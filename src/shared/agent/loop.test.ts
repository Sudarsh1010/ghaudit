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
import { GroqStub } from '~/shared/infra/groq/client'
import { RepositoryInMemoryLive } from '~/shared/infra/drizzle/repository'
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

const TestEnv = Layer.mergeAll(
  RepositoryInMemoryLive,
  IdsTest,
  SessionFixed,
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
})
