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
import { Chunk, Effect, Option, Stream } from 'effect'
import type OpenAI from 'openai'
import {
  GroqEmptyCompletionError,
  type LoopError,
} from '~/shared/domain/errors'
import { Groq } from '~/shared/infra/groq/client'
import type { AgentEvent } from '~/shared/sse/events'
import type { ToolCatalog } from './tools/catalog'

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
}

const DEFAULT_MODEL = 'llama-3.1-8b-instant'
const DEFAULT_SOFT_CAP = 50
const DEFAULT_HARD_CAP = 100

const SYSTEM = (softCap: number): string =>
  `You are a Research agent grilling the user about a feature so you can produce a PRD.\n` +
  `Aim to finish in under ${softCap} tool calls. Always pair an askQuestion with a recommendation and rationale. ` +
  `When you have enough material, write PRD sections via writeOutput({ kind: 'prd_section', section, content }) ` +
  `and then call finalize({ summary }).`

export const runLoop = <R, E>(
  input: RunLoopInput,
  catalog: ToolCatalog<R, E>,
): Stream.Stream<AgentEvent, LoopError | E, R | Groq> => {
  const model = input.model ?? DEFAULT_MODEL
  const softCap = input.softCap ?? DEFAULT_SOFT_CAP
  const hardCap = input.hardCap ?? DEFAULT_HARD_CAP

  const initial: LoopState = {
    history: [
      { role: 'system', content: SYSTEM(softCap) },
      { role: 'user', content: input.prompt },
    ],
    stepNumber: input.startStepNumber ?? 1,
    turns: 0,
  }

  return Stream.paginateChunkEffect(initial, (state) =>
    step(state, model, hardCap, catalog),
  )
}

/* ------------------------------------------------------------------ *
 * Per-turn state machine
 * ------------------------------------------------------------------ */

interface LoopState {
  readonly history: ReadonlyArray<OpenAI.ChatCompletionMessageParam>
  readonly stepNumber: number
  readonly turns: number
}

const step = <R, E>(
  state: LoopState,
  model: string,
  hardCap: number,
  catalog: ToolCatalog<R, E>,
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
    const completion = yield* groq.chatCompletion({
      model,
      messages: state.history,
      tools: catalog.openAITools,
    })

    const message = completion.choices[0]?.message
    if (!message) {
      return yield* new GroqEmptyCompletionError()
    }

    const text = message.content ?? ''
    const events: Array<AgentEvent> = []
    let stepNumber = state.stepNumber

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

    for (const call of message.tool_calls) {
      if (call.type !== 'function') continue
      const args = safeParseJson(call.function.arguments)

      events.push({
        id: stepNumber++,
        type: 'tool_invoked',
        toolName: call.function.name,
        args,
      })

      const outcome = yield* catalog.dispatch({
        name: call.function.name,
        rawArguments: call.function.arguments,
      })

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

    return [
      Chunk.fromIterable(events),
      Option.some<LoopState>({
        history: newHistory,
        stepNumber,
        turns: state.turns + 1,
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
