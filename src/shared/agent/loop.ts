/**
 * The Agent Loop, expressed as `Stream<AgentEvent, LoopError | E, R>`.
 *
 *     RUNNING ──askQuestion──▶ paused (stream ends, host transitions to
 *                                       WAITING_FOR_USER)
 *        │
 *        ├─finalize──────────▶ done (stream ends)
 *        │
 *        └─writeOutput / echo / continue ──▶ next turn …
 *
 * Each turn:
 *   1. ask Groq what to do given the running history,
 *   2. emit `agent_thinking`,
 *   3. for every tool call: emit `tool_invoked`, run the tool through the
 *      catalogue, emit `tool_result` / `prd_section_written`, and either
 *      end the stream (Pause / Finalise) or thread the tool's result back
 *      into the history.
 *
 * Halt conditions:
 *   - Pause → emit `question_asked`, end stream
 *   - Finalise → emit `done` with the summary, end stream
 *   - LLM returns no tool calls → emit `done` with the assistant text
 *   - Hard cap reached → emit a forced `done`
 *
 * Persistence (research_steps), state-machine transitions, and SSE
 * write-outs live one layer up — the loop is pure stream-of-events.
 */
import { Chunk, Effect, Either, Option, Stream } from 'effect'
import type OpenAI from 'openai'
import {
  type GroqError,
  GroqEmptyCompletionError,
  type LoopError,
  type ToolError,
} from '~/shared/domain/errors'
import { Groq, type GroqChatCompletionParams } from '~/shared/infra/groq/client'
import type { AgentEvent } from '~/shared/sse/events'
import type { ToolCatalog } from './tools/catalog'
import type { ToolOutcome } from '~/shared/infra/ai/tool'

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export interface RunLoopInput {
  readonly prompt: string
  readonly model?: string
  /** Soft cap appended as advisory text to the system prompt. Default 50. */
  readonly softCap?: number
  /** Hard cap — when reached, the loop force-finalises. Default 100. */
  readonly hardCap?: number
  /** Step number the first emitted event should carry. Default 1. */
  readonly startStepNumber?: number
  /**
   * Base delay (millis) for Groq retry backoff. With 3 retries, the loop
   * sleeps `base × 2^n` between attempts: 1s, 2s, 4s by default. Tests
   * pass `1` so the suite stays fast.
   */
  readonly groqRetryBaseDelayMs?: number
}

const DEFAULT_MODEL = 'llama-3.1-8b-instant'
const DEFAULT_SOFT_CAP = 50
const DEFAULT_HARD_CAP = 100
/**
 * After this many consecutive turns with malformed tool calls, the loop
 * gives up and emits a terminal `error/failed` event. The DO converts that
 * into a `FAILED` state transition.
 */
const MAX_REPAIR_ATTEMPTS = 3
/**
 * How many transient-Groq retries the loop will attempt before giving up.
 * Three retries means up to four total Groq calls per turn, with backoffs
 * of `base × 1, 2, 4` milliseconds between them.
 */
const MAX_GROQ_RETRIES = 3
const DEFAULT_GROQ_RETRY_BASE_MS = 1000

const SYSTEM = (softCap: number): string =>
  `You are a Research agent grilling the user about a feature so you can produce a PRD.\n` +
  `Aim to finish in under ${softCap} tool calls. Always pair an askQuestion with a recommendation and rationale. ` +
  `When you have enough material, write PRD sections via writeOutput({ kind: 'prd_section', section, content }) ` +
  `and then call finalize({ summary }).\n\n` +
  `Before recommending an answer to a non-trivial question, ground yourself with the research tools:\n` +
  `  - webSearch({ query }) — Brave web search; use for sources, recent posts, comparisons.\n` +
  `  - searchLibraryDocs({ library, query }) — Context7 docs lookup; use whenever the decision turns on a specific library or framework.\n` +
  `  - readUrl({ url }) — fetch the readable text of a URL returned by webSearch when the snippet alone is insufficient.\n` +
  `Prefer one or two targeted research calls per decision over guessing; cite the result back to the user in your rationale.`

export const runLoop = <R, E>(
  input: RunLoopInput,
  catalog: ToolCatalog<R, E>,
): Stream.Stream<AgentEvent, LoopError | E, R | Groq> => {
  const model = input.model ?? DEFAULT_MODEL
  const softCap = input.softCap ?? DEFAULT_SOFT_CAP
  const hardCap = input.hardCap ?? DEFAULT_HARD_CAP
  const groqRetryBaseDelayMs =
    input.groqRetryBaseDelayMs ?? DEFAULT_GROQ_RETRY_BASE_MS

  const initial: LoopState = {
    history: [
      { role: 'system', content: SYSTEM(softCap) },
      { role: 'user', content: input.prompt },
    ],
    stepNumber: input.startStepNumber ?? 1,
    turns: 0,
    repairAttempts: 0,
  }

  return Stream.paginateChunkEffect(initial, (state) =>
    step(state, model, hardCap, catalog, groqRetryBaseDelayMs),
  )
}

/* ------------------------------------------------------------------ *
 * Per-turn state machine
 * ------------------------------------------------------------------ */

interface LoopState {
  readonly history: ReadonlyArray<OpenAI.ChatCompletionMessageParam>
  readonly stepNumber: number
  readonly turns: number
  /**
   * How many turns in a row the LLM emitted at least one malformed tool
   * call (unknown tool, invalid JSON, schema mismatch). Resets to 0 on a
   * clean turn.
   */
  readonly repairAttempts: number
}

/* ------------------------------------------------------------------ *
 * Tool-call repair
 *
 * When `catalog.dispatch` fails with a *validation* error (unknown tool,
 * bad JSON, schema mismatch), we don't kill the loop — we feed a synthetic
 * tool-message back to the LLM saying "previous tool call was invalid:
 * <reason>; try again" and ask it to retry. `ToolExecutionError` is *not*
 * repairable: that's a real failure inside a tool's execute, surface it.
 * ------------------------------------------------------------------ */

type DispatchOutcome =
  | { readonly kind: 'ok'; readonly outcome: ToolOutcome }
  | { readonly kind: 'repair'; readonly reason: string }

type RepairableToolError = Extract<
  ToolError,
  { _tag: 'ToolUnknownError' | 'ToolInputJsonError' | 'ToolInputParseError' }
>

const isRepairable = (err: unknown): err is RepairableToolError => {
  if (typeof err !== 'object' || err === null || !('_tag' in err)) return false
  const tag = (err as { _tag: unknown })._tag
  return (
    tag === 'ToolUnknownError' ||
    tag === 'ToolInputJsonError' ||
    tag === 'ToolInputParseError'
  )
}

const repairReason = (err: RepairableToolError): string => {
  switch (err._tag) {
    case 'ToolUnknownError':
      return `unknown tool '${err.toolName}'`
    case 'ToolInputJsonError':
      return `invalid JSON arguments for tool '${err.toolName}'`
    case 'ToolInputParseError':
      return `schema validation failed for tool '${err.toolName}'`
  }
}

const repairToolMessage = (
  toolCallId: string,
  reason: string,
): OpenAI.ChatCompletionMessageParam => ({
  role: 'tool',
  tool_call_id: toolCallId,
  content: `previous tool call was invalid: ${reason}; try again`,
})

const step = <R, E>(
  state: LoopState,
  model: string,
  hardCap: number,
  catalog: ToolCatalog<R, E>,
  groqRetryBaseDelayMs: number,
): Effect.Effect<
  readonly [Chunk.Chunk<AgentEvent>, Option.Option<LoopState>],
  LoopError | E,
  R | Groq
> =>
  Effect.gen(function* () {
    if (state.turns >= hardCap) {
      const summary = `Note: hit step cap (${hardCap}). Forced finalize.`
      const event: AgentEvent = {
        id: state.stepNumber,
        type: 'done',
        finalText: summary,
      }
      return [Chunk.of(event), Option.none<LoopState>()] as const
    }

    const groq = yield* Groq
    const groqResult = yield* callGroqWithRetries(
      groq,
      {
        model,
        messages: state.history,
        tools: catalog.openAITools,
      },
      state.stepNumber,
      groqRetryBaseDelayMs,
    )
    if (groqResult.kind === 'failed') {
      return [
        Chunk.fromIterable(groqResult.events),
        Option.none<LoopState>(),
      ] as const
    }
    const completion = groqResult.completion

    const message = completion.choices[0]?.message
    if (!message) {
      return yield* new GroqEmptyCompletionError()
    }

    const text = message.content ?? ''
    const events: Array<AgentEvent> = [...groqResult.events]
    let stepNumber = groqResult.nextStepNumber

    events.push({ id: stepNumber++, type: 'agent_thinking', text })

    const newHistory: Array<OpenAI.ChatCompletionMessageParam> = [
      ...state.history,
      {
        role: 'assistant',
        content: text,
        tool_calls: message.tool_calls,
      } as OpenAI.ChatCompletionAssistantMessageParam,
    ]

    if (!message.tool_calls || message.tool_calls.length === 0) {
      events.push({ id: stepNumber++, type: 'done', finalText: text })
      return [Chunk.fromIterable(events), Option.none<LoopState>()] as const
    }

    let hadRepair = false

    for (const call of message.tool_calls) {
      if (call.type !== 'function') continue
      const args = safeParseJson(call.function.arguments)

      events.push({
        id: stepNumber++,
        type: 'tool_invoked',
        toolName: call.function.name,
        args,
      })

      const dispatched: DispatchOutcome = yield* catalog
        .dispatch({
          name: call.function.name,
          rawArguments: call.function.arguments,
        })
        .pipe(
          Effect.map(
            (outcome): DispatchOutcome => ({ kind: 'ok', outcome }),
          ),
          Effect.catchAll((err) =>
            isRepairable(err)
              ? Effect.succeed<DispatchOutcome>({
                  kind: 'repair',
                  reason: repairReason(err),
                })
              : Effect.fail(err),
          ),
        )

      if (dispatched.kind === 'repair') {
        // Don't emit tool_result; the LLM will try again next turn. Append
        // a synthetic tool-message so the OpenAI API contract (every
        // tool_call needs a tool response) holds.
        newHistory.push(repairToolMessage(call.id, dispatched.reason))
        hadRepair = true
        continue
      }

      const outcome = dispatched.outcome

      if (outcome._tag === 'Pause') {
        events.push({
          id: stepNumber++,
          type: 'question_asked',
          questionId: outcome.questionId,
          question: outcome.question,
          recommendation: outcome.recommendation,
          rationale: outcome.rationale,
          kind: 'single',
        })
        return [Chunk.fromIterable(events), Option.none<LoopState>()] as const
      }

      if (outcome._tag === 'Finalise') {
        events.push({
          id: stepNumber++,
          type: 'done',
          finalText: outcome.summary,
        })
        return [Chunk.fromIterable(events), Option.none<LoopState>()] as const
      }

      const renderable: unknown =
        outcome._tag === 'Continue'
          ? outcome.result
          : {
              kind: 'prd_section',
              section: outcome.section,
              content: outcome.content,
            }

      events.push({
        id: stepNumber++,
        type: 'tool_result',
        toolName: call.function.name,
        result: renderable,
      })

      if (outcome._tag === 'WroteOutput') {
        events.push({
          id: stepNumber++,
          type: 'prd_section_written',
          section: outcome.section,
          content: outcome.content,
        })
      }

      newHistory.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(renderable),
      })
    }

    const nextRepairAttempts = hadRepair ? state.repairAttempts + 1 : 0

    if (nextRepairAttempts >= MAX_REPAIR_ATTEMPTS) {
      // Find the most recent repair reason from the synthetic tool messages
      // we appended this turn — `tool_call_id` + content carry the why.
      const lastSynthetic = [...newHistory]
        .reverse()
        .find(
          (m) =>
            m.role === 'tool' &&
            typeof m.content === 'string' &&
            m.content.startsWith('previous tool call was invalid: '),
        ) as OpenAI.ChatCompletionToolMessageParam | undefined
      const reason =
        typeof lastSynthetic?.content === 'string'
          ? lastSynthetic.content
              .replace(/^previous tool call was invalid: /, '')
              .replace(/; try again$/, '')
          : 'malformed tool call'
      events.push({
        id: stepNumber++,
        type: 'error',
        kind: 'failed',
        reason: `tool-call repair attempts exhausted: ${reason}`,
      })
      return [Chunk.fromIterable(events), Option.none<LoopState>()] as const
    }

    return [
      Chunk.fromIterable(events),
      Option.some<LoopState>({
        history: newHistory,
        stepNumber,
        turns: state.turns + 1,
        repairAttempts: nextRepairAttempts,
      }),
    ] as const
  })

const safeParseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/* ------------------------------------------------------------------ *
 * Groq retry / failure handling
 *
 * Wraps a single `groq.chatCompletion` call with backoff-and-retry so
 * the loop can emit `error/retry` events between attempts and an
 * `error/failed` event when the retries exhaust. Non-retryable Groq
 * errors (auth, schema-empty, etc.) propagate as stream failures so the
 * DO can render a typed error response.
 * ------------------------------------------------------------------ */

const isGroqRetryable = (e: GroqError): boolean => {
  if (e._tag === 'GroqRateLimitError') return true
  if (e._tag === 'GroqNetworkError') return true
  if (e._tag === 'GroqApiError') {
    return e.status >= 500 && e.status < 600
  }
  return false
}

const groqErrorReason = (e: GroqError): string => {
  switch (e._tag) {
    case 'GroqRateLimitError':
      return e.retryAfterSeconds !== undefined
        ? `Groq rate-limited (429), retry-after ${e.retryAfterSeconds}s`
        : 'Groq rate-limited (429)'
    case 'GroqNetworkError':
      return 'Groq network error'
    case 'GroqApiError':
      return `Groq API error (${e.status}): ${e.body}`
    case 'GroqAuthError':
      return `Groq auth error: ${e.reason}`
    case 'GroqParseError':
      return 'Groq response parse error'
    case 'GroqEmptyCompletionError':
      return 'Groq returned an empty completion'
  }
}

interface GroqCallOk {
  readonly kind: 'ok'
  readonly completion: OpenAI.ChatCompletion
  readonly events: ReadonlyArray<AgentEvent>
  readonly nextStepNumber: number
}

interface GroqCallFailed {
  readonly kind: 'failed'
  readonly events: ReadonlyArray<AgentEvent>
  readonly nextStepNumber: number
}

type GroqCallResult = GroqCallOk | GroqCallFailed

const callGroqWithRetries = (
  groq: Effect.Effect.Success<typeof Groq>,
  params: GroqChatCompletionParams,
  startStepNumber: number,
  baseDelayMs: number,
): Effect.Effect<GroqCallResult, GroqError> =>
  Effect.gen(function* () {
    const events: Array<AgentEvent> = []
    let stepNumber = startStepNumber

    for (let attempt = 1; attempt <= MAX_GROQ_RETRIES + 1; attempt++) {
      const result = yield* groq.chatCompletion(params).pipe(Effect.either)
      if (Either.isRight(result)) {
        return {
          kind: 'ok',
          completion: result.right,
          events,
          nextStepNumber: stepNumber,
        } as GroqCallResult
      }
      const err = result.left
      if (!isGroqRetryable(err)) {
        return yield* Effect.fail(err)
      }
      // Last attempt failed AND was retryable → give up.
      if (attempt > MAX_GROQ_RETRIES) {
        events.push({
          id: stepNumber++,
          type: 'error',
          kind: 'failed',
          reason: `Groq retries exhausted: ${groqErrorReason(err)}`,
        })
        return {
          kind: 'failed',
          events,
          nextStepNumber: stepNumber,
        } as GroqCallResult
      }
      // More attempts left — emit retry event, sleep, and try again.
      events.push({
        id: stepNumber++,
        type: 'error',
        kind: 'retry',
        attempt,
        reason: groqErrorReason(err),
      })
      yield* Effect.sleep(`${baseDelayMs * 2 ** (attempt - 1)} millis`)
    }

    // Unreachable — the loop above always returns within MAX_GROQ_RETRIES+1
    // iterations. Returning a failed result is just to satisfy the type
    // checker.
    return {
      kind: 'failed',
      events,
      nextStepNumber: stepNumber,
    } as GroqCallResult
  })
