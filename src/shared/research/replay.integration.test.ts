/**
 * Slice 5 acceptance criterion: kill the stream mid-session, open a
 * new EventSource with a `Last-Event-ID`, verify the event sequence
 * from that id forward is complete and ordered.
 *
 * Simulated end-to-end below `server.ts` / DO HTTP — directly through
 * `sessionEventStream` so the assertion stays at the behavioural seam
 * the DO consumes. The DO + worker are thin wrappers over this stream
 * (header parse, body parse, frame write); their wiring is verified by
 * `pnpm build` / smoke testing, not by reproducing a Cloudflare runtime
 * in vitest.
 */
import { describe, it, expect } from '@effect/vitest'
import { Chunk, Clock, Effect, Layer, Stream } from 'effect'
import type OpenAI from 'openai'
import { IdsTest } from '~/shared/domain/ids'
import { GroqStub } from '~/shared/infra/groq/client'
import {
  RepositoryInMemoryLive,
  ResearchRepository,
} from '~/shared/infra/drizzle/repository'
import { ResearchSessionStatus } from '~/shared/infra/drizzle/schema'
import { makeCatalog, SessionContext } from '~/shared/agent/tools/catalog'
import { builtinTools } from '~/shared/agent/tools/builtin'
import type { AgentEvent } from '~/shared/sse/events'
import { sessionEventStream } from './replay'

const SessionFixed = Layer.succeed(SessionContext, { sessionId: 's1' })

const askQuestionCompletion: OpenAI.ChatCompletion = {
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'm',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'thinking about your feature…',
        refusal: null,
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: {
              name: 'askQuestion',
              arguments: JSON.stringify({
                question: 'Who are the primary users?',
                recommendation: 'Power users',
                rationale: 'They tolerate complexity',
              }),
            },
          },
        ],
      },
      finish_reason: 'tool_calls',
      logprobs: null,
    },
  ],
} as OpenAI.ChatCompletion

const catalog = makeCatalog(builtinTools)

const seed = Effect.gen(function* () {
  const repo = yield* ResearchRepository
  const millis = yield* Clock.currentTimeMillis
  yield* repo.createSession({
    id: 's1',
    initialPrompt: 'design a CLI dark mode toggler',
    status: ResearchSessionStatus.active,
    createdAt: new Date(millis),
    updatedAt: new Date(millis),
  })
})

describe('Slice 5: kill mid-session, reconnect with Last-Event-ID', () => {
  it.effect(
    'replays missed events bit-equal to the originals; no dupes, no gaps',
    () =>
      Effect.gen(function* () {
        yield* seed
        const repo = yield* ResearchRepository

        const persistLive = (event: AgentEvent) =>
          repo.appendStep({ sessionId: 's1', event })

        // ---------- Phase 1 — initial connection ----------
        // The agent runs one tick, emits a multi-event sequence, then
        // pauses on `question_asked`. The DO would persist each event
        // as it streams; we mirror that with `persistLive`.
        const phase1 = yield* Stream.runCollect(
          sessionEventStream({
            prompt: 'design a CLI dark mode toggler',
            sessionId: 's1',
            lastEventId: 0,
            catalog,
            persistLive,
          }),
        ).pipe(Effect.provide(GroqStub.layer([askQuestionCompletion])))

        const original = Chunk.toReadonlyArray(
          phase1,
        ) as ReadonlyArray<AgentEvent>

        // Sanity: the tick produced agent_thinking → tool_invoked →
        // question_asked, and persisted them all.
        expect(original.map((e) => e.type)).toEqual([
          'agent_thinking',
          'tool_invoked',
          'question_asked',
        ])

        // Production DO would call `transitionTo('askQuestion')` which
        // flips the row to `waiting_for_user`. Mirror that here so the
        // reconnect path doesn't fire a fresh LLM call.
        const millis = yield* Clock.currentTimeMillis
        yield* repo.setSessionStatus(
          's1',
          ResearchSessionStatus.waitingForUser,
          new Date(millis),
        )

        // ---------- Phase 2 — reconnect mid-session ----------
        // Suppose the browser only managed to receive event 1 before
        // the connection dropped. EventSource will reconnect with
        // `Last-Event-ID: 1`. The server replays events 2..3.
        const cutAt = 1
        const lastSeenId = original[cutAt - 1]!.id

        const phase2 = yield* Stream.runCollect(
          sessionEventStream({
            prompt: 'design a CLI dark mode toggler',
            sessionId: 's1',
            lastEventId: lastSeenId,
            catalog,
            persistLive,
          }),
        )
          // Empty Groq turns: a fresh LLM call here would crash on
          // missing turn 0, which is the right failure shape for
          // "this path must not call the model".
          .pipe(Effect.provide(GroqStub.layer([])))

        const replayed = Chunk.toReadonlyArray(
          phase2,
        ) as ReadonlyArray<AgentEvent>

        // Bit-equality: same ids, same types, same payloads.
        expect(replayed).toEqual(original.slice(cutAt))

        // Explicit: contiguous step numbers from lastSeenId + 1 onward.
        expect(replayed.map((e) => e.id)).toEqual(
          original.slice(cutAt).map((e) => e.id),
        )
        const ids = replayed.map((e) => e.id)
        for (let i = 1; i < ids.length; i++) {
          expect(ids[i]).toBe(ids[i - 1]! + 1)
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(RepositoryInMemoryLive, IdsTest, SessionFixed),
        ),
      ),
  )

  it.effect(
    'reconnect from event 0 (no Last-Event-ID) replays everything bit-equal',
    () =>
      Effect.gen(function* () {
        yield* seed
        const repo = yield* ResearchRepository
        const persistLive = (event: AgentEvent) =>
          repo.appendStep({ sessionId: 's1', event })

        const phase1 = yield* Stream.runCollect(
          sessionEventStream({
            prompt: 'p',
            sessionId: 's1',
            lastEventId: 0,
            catalog,
            persistLive,
          }),
        ).pipe(Effect.provide(GroqStub.layer([askQuestionCompletion])))
        const original = Chunk.toReadonlyArray(
          phase1,
        ) as ReadonlyArray<AgentEvent>

        const millis = yield* Clock.currentTimeMillis
        yield* repo.setSessionStatus(
          's1',
          ResearchSessionStatus.waitingForUser,
          new Date(millis),
        )

        // Reconnect with `Last-Event-ID: 0` — same as no header.
        const phase2 = yield* Stream.runCollect(
          sessionEventStream({
            prompt: 'p',
            sessionId: 's1',
            lastEventId: 0,
            catalog,
            persistLive,
          }),
        ).pipe(Effect.provide(GroqStub.layer([])))
        const replayed = Chunk.toReadonlyArray(
          phase2,
        ) as ReadonlyArray<AgentEvent>

        expect(replayed).toEqual(original)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(RepositoryInMemoryLive, IdsTest, SessionFixed),
        ),
      ),
  )
})
