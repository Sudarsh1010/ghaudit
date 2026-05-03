/**
 * Agent Loop tests — `runLoop` is a `Stream<AgentEvent, …, R>`. Tests
 * compose:
 *
 *   GroqStub.layer([turns…])    — canned LLM responses
 *   RepositoryInMemoryLive       — Map-backed persistence
 *   IdsTest                      — deterministic question ids
 *   SessionContext fixed layer   — `sessionId: 's'`
 *
 * and assert on the emitted events via `Stream.runCollect`.
 *
 * Halt conditions covered:
 *   - Pause   (askQuestion → question_asked, stream ends)
 *   - Finalise (finalize  → done, stream ends)
 *   - Hard cap (forced done)
 */
import { describe, it, expect } from '@effect/vitest'
import { Chunk, Effect, Layer, Stream } from 'effect'
import type OpenAI from 'openai'
import { IdsTest } from '~/shared/domain/ids'
import { BraveStub } from '~/shared/infra/brave/client'
import { Context7Stub } from '~/shared/infra/context7/client'
import { UrlFetcherStub } from '~/shared/infra/url-fetcher/client'
import { GroqStub, type GroqStubTurn } from '~/shared/infra/groq/client'
import { RepositoryInMemoryLive } from '~/shared/infra/drizzle/repository'
import {
  GroqApiError,
  GroqAuthError,
  GroqRateLimitError,
} from '~/shared/domain/errors'
import { runLoop } from './loop'
import { makeCatalog, SessionContext } from './tools/catalog'
import { builtinTools } from './tools/builtin'
import type { AgentEvent } from '~/shared/sse/events'

interface CannedToolCall {
  readonly id: string
  readonly name: string
  readonly args: Record<string, unknown>
}

const completion = (
  cmplId: string,
  opts: { content?: string; toolCalls?: ReadonlyArray<CannedToolCall> },
): OpenAI.ChatCompletion =>
  ({
    id: cmplId,
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: opts.content ?? '',
          refusal: null,
          tool_calls: opts.toolCalls?.map((c) => ({
            id: c.id,
            type: 'function',
            function: {
              name: c.name,
              arguments: JSON.stringify(c.args),
            },
          })),
        },
        finish_reason: opts.toolCalls ? 'tool_calls' : 'stop',
        logprobs: null,
      },
    ],
  }) as OpenAI.ChatCompletion

const SessionFixed = Layer.succeed(SessionContext, { sessionId: 's' })

// Empty research-tool stubs — these tests don't drive the search path, so
// nothing needs canned responses; we just have to satisfy the requirements
// the catalog declares (Slice 11 added them).
const TestEnv = Layer.mergeAll(
  RepositoryInMemoryLive,
  IdsTest,
  SessionFixed,
  BraveStub.layer([]),
  Context7Stub.layer({}),
  UrlFetcherStub.layer([]),
)

const catalog = makeCatalog(builtinTools)

describe('agent loop', () => {
  it.effect('halts on HITL pause (askQuestion)', () =>
    Effect.gen(function* () {
      const turns: ReadonlyArray<OpenAI.ChatCompletion> = [
        completion('c1', {
          toolCalls: [
            {
              id: 'tc1',
              name: 'askQuestion',
              args: {
                question: 'q?',
                recommendation: 'r',
                rationale: 'why',
              },
            },
          ],
        }),
      ]

      const events = yield* Stream.runCollect(
        runLoop({ prompt: 'go' }, catalog),
      ).pipe(Effect.provide(Layer.merge(TestEnv, GroqStub.layer(turns))))

      const arr = Chunk.toReadonlyArray(events) as ReadonlyArray<AgentEvent>
      const types = arr.map((e) => e.type)
      expect(types).toEqual(['agent_thinking', 'tool_invoked', 'question_asked'])
      const last = arr[arr.length - 1]!
      if (last.type !== 'question_asked') throw new Error('expected pause')
      expect(last.questionId).toBe('q_0001')
    }),
  )

  it.effect('continues across non-HITL tools and halts on finalize', () =>
    Effect.gen(function* () {
      const turns: ReadonlyArray<OpenAI.ChatCompletion> = [
        completion('c1', {
          toolCalls: [
            {
              id: 'tc1',
              name: 'echo',
              args: { text: 'hi' },
            },
          ],
        }),
        completion('c2', {
          toolCalls: [
            {
              id: 'tc2',
              name: 'writeOutput',
              args: {
                kind: 'prd_section',
                section: 'goal',
                content: 'Build dark mode.',
              },
            },
          ],
        }),
        completion('c3', {
          toolCalls: [
            {
              id: 'tc3',
              name: 'finalize',
              args: { summary: 'shipped' },
            },
          ],
        }),
      ]

      const events = yield* Stream.runCollect(
        runLoop({ prompt: 'go' }, catalog),
      ).pipe(Effect.provide(Layer.merge(TestEnv, GroqStub.layer(turns))))

      const arr = Chunk.toReadonlyArray(events) as ReadonlyArray<AgentEvent>
      const types = arr.map((e) => e.type)
      expect(types).toContain('prd_section_written')
      const last = arr[arr.length - 1]!
      if (last.type !== 'done') throw new Error('expected finalize')
      expect(last.finalText).toBe('shipped')
    }),
  )

  it.effect('hits the hard cap and force-finalizes', () =>
    Effect.gen(function* () {
      const turns: Array<OpenAI.ChatCompletion> = []
      for (let i = 0; i < 200; i++) {
        turns.push(
          completion(`c${i}`, {
            toolCalls: [
              {
                id: `tc${i}`,
                name: 'echo',
                args: { text: `n=${i}` },
              },
            ],
          }),
        )
      }

      const events = yield* Stream.runCollect(
        runLoop(
          { prompt: 'go', hardCap: 5, softCap: 3 },
          catalog,
        ),
      ).pipe(Effect.provide(Layer.merge(TestEnv, GroqStub.layer(turns))))

      const arr = Chunk.toReadonlyArray(events) as ReadonlyArray<AgentEvent>
      const last = arr[arr.length - 1]!
      if (last.type !== 'done') throw new Error('expected forced done')
      expect(last.finalText).toMatch(/hit step cap/i)
    }),
  )

  it.effect('halts on plain assistant text (no tool calls) with done', () =>
    Effect.gen(function* () {
      const turns: ReadonlyArray<OpenAI.ChatCompletion> = [
        completion('c1', { content: 'all set' }),
      ]

      const events = yield* Stream.runCollect(
        runLoop({ prompt: 'go' }, catalog),
      ).pipe(Effect.provide(Layer.merge(TestEnv, GroqStub.layer(turns))))

      const arr = Chunk.toReadonlyArray(events) as ReadonlyArray<AgentEvent>
      expect(arr.map((e) => e.type)).toEqual(['agent_thinking', 'done'])
      const last = arr[arr.length - 1]!
      if (last.type !== 'done') throw new Error('expected done')
      expect(last.finalText).toBe('all set')
    }),
  )

  it.effect(
    'repairs malformed tool call: unknown tool name → next turn finalizes',
    () =>
      Effect.gen(function* () {
        // Turn 1: LLM emits a call to a tool that doesn't exist. Without
        // repair, the dispatcher fails with ToolUnknownError and the stream
        // dies. With repair, the loop appends a synthetic message to the
        // history and asks Groq again.
        // Turn 2: LLM corrects itself with a valid finalize.
        const turns: ReadonlyArray<OpenAI.ChatCompletion> = [
          completion('c1', {
            toolCalls: [
              { id: 'tc1', name: 'nonExistentTool', args: { foo: 'bar' } },
            ],
          }),
          completion('c2', {
            toolCalls: [
              { id: 'tc2', name: 'finalize', args: { summary: 'recovered' } },
            ],
          }),
        ]

        const events = yield* Stream.runCollect(
          runLoop({ prompt: 'go' }, catalog),
        ).pipe(Effect.provide(Layer.merge(TestEnv, GroqStub.layer(turns))))

        const arr = Chunk.toReadonlyArray(events) as ReadonlyArray<AgentEvent>
        const last = arr[arr.length - 1]!
        if (last.type !== 'done') throw new Error(`expected done, got ${last.type}`)
        expect(last.finalText).toBe('recovered')
      }),
  )

  // `it.live` — these tests exercise the real backoff scheduler. Under the
  // default `it.effect` TestClock, `Effect.sleep` would never tick.
  it.live('retries Groq 429 with backoff and emits a retry event', () =>
    Effect.gen(function* () {
      // 1st call rate-limits; 2nd succeeds with finalize.
      const turns: ReadonlyArray<GroqStubTurn> = [
        { _err: new GroqRateLimitError({ retryAfterSeconds: 0 }) },
        completion('c2', {
          toolCalls: [
            { id: 'tc1', name: 'finalize', args: { summary: 'recovered' } },
          ],
        }),
      ]

      const events = yield* Stream.runCollect(
        runLoop(
          { prompt: 'go', groqRetryBaseDelayMs: 1 },
          catalog,
        ),
      ).pipe(Effect.provide(Layer.merge(TestEnv, GroqStub.layer(turns))))

      const arr = Chunk.toReadonlyArray(events) as ReadonlyArray<AgentEvent>
      const retry = arr.find((e) => e.type === 'error' && e.kind === 'retry')
      if (!retry || retry.type !== 'error')
        throw new Error('expected an error/retry event')
      expect(retry.attempt).toBe(1)
      expect(retry.reason).toMatch(/rate.?limit|429/i)

      const last = arr[arr.length - 1]!
      if (last.type !== 'done')
        throw new Error(`expected done, got ${last.type}`)
      expect(last.finalText).toBe('recovered')
    }),
  )

  it.live('retries Groq 5xx with backoff and emits a retry event', () =>
    Effect.gen(function* () {
      const turns: ReadonlyArray<GroqStubTurn> = [
        { _err: new GroqApiError({ status: 503, body: 'service unavailable' }) },
        completion('c2', {
          toolCalls: [
            { id: 'tc1', name: 'finalize', args: { summary: 'recovered 5xx' } },
          ],
        }),
      ]

      const events = yield* Stream.runCollect(
        runLoop(
          { prompt: 'go', groqRetryBaseDelayMs: 1 },
          catalog,
        ),
      ).pipe(Effect.provide(Layer.merge(TestEnv, GroqStub.layer(turns))))

      const arr = Chunk.toReadonlyArray(events) as ReadonlyArray<AgentEvent>
      const retry = arr.find((e) => e.type === 'error' && e.kind === 'retry')
      if (!retry || retry.type !== 'error')
        throw new Error('expected an error/retry event')
      expect(retry.attempt).toBe(1)
      expect(retry.reason).toMatch(/503|service unavailable|5xx/i)

      const last = arr[arr.length - 1]!
      if (last.type !== 'done')
        throw new Error(`expected done, got ${last.type}`)
      expect(last.finalText).toBe('recovered 5xx')
    }),
  )

  it.live(
    'emits 3 retry events + error/failed and halts when Groq retries exhaust',
    () =>
      Effect.gen(function* () {
        const turns: ReadonlyArray<GroqStubTurn> = [
          { _err: new GroqRateLimitError({}) },
          { _err: new GroqRateLimitError({}) },
          { _err: new GroqRateLimitError({}) },
          { _err: new GroqRateLimitError({}) },
        ]

        const events = yield* Stream.runCollect(
          runLoop(
            { prompt: 'go', groqRetryBaseDelayMs: 1 },
            catalog,
          ),
        ).pipe(Effect.provide(Layer.merge(TestEnv, GroqStub.layer(turns))))

        const arr = Chunk.toReadonlyArray(events) as ReadonlyArray<AgentEvent>
        const retries = arr.filter(
          (e) => e.type === 'error' && e.kind === 'retry',
        )
        expect(retries).toHaveLength(3)
        expect((retries[0] as { attempt?: number }).attempt).toBe(1)
        expect((retries[1] as { attempt?: number }).attempt).toBe(2)
        expect((retries[2] as { attempt?: number }).attempt).toBe(3)

        const last = arr[arr.length - 1]!
        if (last.type !== 'error')
          throw new Error(`expected error, got ${last.type}`)
        expect(last.kind).toBe('failed')
        expect(last.reason).toMatch(/rate.?limit|429/i)
      }),
  )

  it.effect('non-retryable Groq error (auth) propagates as a stream failure', () =>
    Effect.gen(function* () {
      const turns: ReadonlyArray<GroqStubTurn> = [
        { _err: new GroqAuthError({ reason: 'bad key' }) },
      ]

      const exit = yield* Effect.exit(
        Stream.runCollect(
          runLoop(
            { prompt: 'go', groqRetryBaseDelayMs: 1 },
            catalog,
          ),
        ).pipe(Effect.provide(Layer.merge(TestEnv, GroqStub.layer(turns)))),
      )
      // The loop should NOT silently retry an auth error — it surfaces as a
      // typed failure so the DO can render a 502.
      expect(exit._tag).toBe('Failure')
    }),
  )

  it.effect(
    'emits error/failed and halts after 3 consecutive malformed tool calls',
    () =>
      Effect.gen(function* () {
        // 3 consecutive turns of malformed calls. The 3rd should trigger
        // the terminal error event; the 4th canned response should never
        // be consumed.
        const bad = (i: number) =>
          completion(`c${i}`, {
            toolCalls: [
              { id: `tc${i}`, name: 'nonExistentTool', args: { i } },
            ],
          })
        const turns: ReadonlyArray<OpenAI.ChatCompletion> = [
          bad(1),
          bad(2),
          bad(3),
          // canary: if the loop kept asking, this is what it would see.
          completion('c4', {
            toolCalls: [
              { id: 'tc4', name: 'finalize', args: { summary: 'should not reach' } },
            ],
          }),
        ]

        const events = yield* Stream.runCollect(
          runLoop({ prompt: 'go' }, catalog),
        ).pipe(Effect.provide(Layer.merge(TestEnv, GroqStub.layer(turns))))

        const arr = Chunk.toReadonlyArray(events) as ReadonlyArray<AgentEvent>
        const last = arr[arr.length - 1]!
        if (last.type !== 'error')
          throw new Error(`expected error, got ${last.type}`)
        expect(last.kind).toBe('failed')
        expect(last.reason).toMatch(/unknown tool/i)

        // No `done` event was emitted.
        expect(arr.find((e) => e.type === 'done')).toBeUndefined()
      }),
  )
})
