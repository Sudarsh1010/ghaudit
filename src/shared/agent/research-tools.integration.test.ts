/**
 * Slice 7 integration: a session that calls a research tool and emits a
 * `tool_result` event with the expected payload shape.
 *
 * Stubs:
 *   - GroqStub      — returns one tool-call turn (`webSearch`) then a `done`.
 *   - BraveStub     — canned `{ results: […] }` payload.
 *   - Context7Stub  — empty (unused this run; provided so types satisfy).
 *   - UrlFetcherStub — empty (same reason).
 *
 * Asserted:
 *   - `tool_invoked` carries `toolName: 'webSearch'` and the LLM-shaped args.
 *   - `tool_result` carries the same `toolName` and the parsed Brave payload
 *     under `result.results`.
 */
import { describe, it, expect } from '@effect/vitest'
import { Chunk, Effect, Layer, Stream } from 'effect'
import type OpenAI from 'openai'
import { IdsTest } from '~/shared/domain/ids'
import { GroqStub } from '~/shared/infra/groq/client'
import { BraveStub } from '~/shared/infra/brave/client'
import { Context7Stub } from '~/shared/infra/context7/client'
import { UrlFetcherStub } from '~/shared/infra/url-fetcher/client'
import { RepositoryInMemoryLive } from '~/shared/infra/drizzle/repository'
import { runLoop } from './loop'
import { makeCatalog, SessionContext } from './tools/catalog'
import { builtinTools } from './tools/builtin'
import { researchTools } from './tools/research'
import type { AgentEvent } from '~/shared/sse/events'

const SessionFixed = Layer.succeed(SessionContext, { sessionId: 's' })

const completion = (
  cmplId: string,
  opts: {
    content?: string
    toolCalls?: ReadonlyArray<{
      id: string
      name: string
      args: Record<string, unknown>
    }>
  },
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

const allTools = [...builtinTools, ...researchTools] as const
const catalog = makeCatalog(allTools)

describe('Slice 7: research-tool integration', () => {
  it.effect('runs a webSearch call and emits a tool_result event with the Brave payload', () =>
    Effect.gen(function* () {
      const turns: ReadonlyArray<OpenAI.ChatCompletion> = [
        completion('c1', {
          toolCalls: [
            {
              id: 'tc1',
              name: 'webSearch',
              args: { query: 'effect-ts schema validation' },
            },
          ],
        }),
        // After receiving the tool_result, the model "decides" to stop.
        completion('c2', { content: 'Done with research.' }),
      ]

      const events = yield* Stream.runCollect(
        runLoop({ prompt: 'research effect schema for me' }, catalog),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            RepositoryInMemoryLive,
            IdsTest,
            SessionFixed,
            GroqStub.layer(turns),
            BraveStub.layer([
              {
                results: [
                  {
                    title: 'Effect Schema',
                    url: 'https://effect.website/docs/schema/introduction',
                    snippet: 'Schema is a powerful library...',
                  },
                ],
              },
            ]),
            Context7Stub.layer({}),
            UrlFetcherStub.layer([]),
          ),
        ),
      )

      const arr = Chunk.toReadonlyArray(events) as ReadonlyArray<AgentEvent>
      const types = arr.map((e) => e.type)

      // The loop should have streamed: agent_thinking, tool_invoked,
      // tool_result, agent_thinking, done.
      expect(types).toEqual([
        'agent_thinking',
        'tool_invoked',
        'tool_result',
        'agent_thinking',
        'done',
      ])

      const invoked = arr.find((e) => e.type === 'tool_invoked')!
      if (invoked.type !== 'tool_invoked') throw new Error('expected invoked')
      expect(invoked.toolName).toBe('webSearch')
      expect(invoked.args).toEqual({ query: 'effect-ts schema validation' })

      const result = arr.find((e) => e.type === 'tool_result')!
      if (result.type !== 'tool_result') throw new Error('expected result')
      expect(result.toolName).toBe('webSearch')
      expect(result.result).toEqual({
        results: [
          {
            title: 'Effect Schema',
            url: 'https://effect.website/docs/schema/introduction',
            snippet: 'Schema is a powerful library...',
          },
        ],
      })
    }),
  )
})
