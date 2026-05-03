/**
 * Slice 5: `sessionEventStream` composes replay + live.
 *
 * The DO calls this when the browser opens `/session/:id/stream` (with
 * or without a `Last-Event-ID`). The stream:
 *
 *   1. Emits all persisted events with `stepNumber > lastEventId` in
 *      order — replay.
 *   2. If the session is still active, attaches the live `runLoop` and
 *      continues from the next step number. Otherwise the stream ends
 *      after replay (no fresh LLM call against a paused session).
 *
 * The replayed events are bit-equal to the originals so the frontend
 * reducer is idempotent and reconnect is invisible to the user.
 */
import { describe, it, expect } from '@effect/vitest'
import { Chunk, Effect, Layer, Stream } from 'effect'
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

const SessionFixed = (id: string) =>
  Layer.succeed(SessionContext, { sessionId: id })

const finalCompletion = (
  cmplId: string,
  text: string,
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
          content: text,
          refusal: null,
        },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
  }) as OpenAI.ChatCompletion

const seedSession = (
  id: string,
  status: ResearchSessionStatus,
  events: ReadonlyArray<AgentEvent>,
) =>
  Effect.gen(function* () {
    const repo = yield* ResearchRepository
    const now = new Date(0)
    yield* repo.createSession({
      id,
      initialPrompt: `prompt-${id}`,
      status,
      ownerId: `own_${id}`,
      createdAt: now,
      updatedAt: now,
    })
    for (const event of events) {
      yield* repo.appendStep({ sessionId: id, event })
    }
  })

const catalog = makeCatalog(builtinTools)

describe('sessionEventStream — replay then live', () => {
  it.effect(
    'on an active session: emits replay events first, then live events with continuing ids',
    () =>
      Effect.gen(function* () {
        const seeded: ReadonlyArray<AgentEvent> = [
          { id: 1, type: 'agent_thinking', text: 'first' },
          { id: 2, type: 'agent_thinking', text: 'second' },
          { id: 3, type: 'agent_thinking', text: 'third' },
        ]
        yield* seedSession('s1', ResearchSessionStatus.active, seeded)

        const collected = yield* Stream.runCollect(
          sessionEventStream({
            prompt: 'continue please',
            sessionId: 's1',
            lastEventId: 1,
            catalog,
            persistLive: () => Effect.void,
          }),
        ).pipe(
          Effect.provide(GroqStub.layer([finalCompletion('c1', 'all done')])),
        )
        const events = Chunk.toReadonlyArray(collected) as ReadonlyArray<
          AgentEvent
        >

        // First two: replay events 2 and 3 from the persisted store.
        expect(events.slice(0, 2)).toEqual(seeded.slice(1))

        // Live tail follows: agent_thinking + done from the GroqStub.
        // ids continue from 4 onward (max replay id was 3).
        expect(events[2]).toEqual({
          id: 4,
          type: 'agent_thinking',
          text: 'all done',
        })
        expect(events[3]).toEqual({
          id: 5,
          type: 'done',
          finalText: 'all done',
        })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RepositoryInMemoryLive,
            IdsTest,
            SessionFixed('s1'),
          ),
        ),
      ),
  )

  it.effect(
    'on a paused (waiting_for_user) session: emits only replay, no live tick',
    () =>
      Effect.gen(function* () {
        const seeded: ReadonlyArray<AgentEvent> = [
          { id: 1, type: 'agent_thinking', text: 'a' },
          {
            id: 2,
            type: 'question_asked',
            questionId: 'q_1',
            question: 'q?',
            recommendation: 'r',
            rationale: 'why',
            kind: 'single',
          },
        ]
        yield* seedSession(
          's1',
          ResearchSessionStatus.waitingForUser,
          seeded,
        )

        // GroqStub layer with no turns — if the live tick runs, it
        // crashes on completion #0 missing.
        const collected = yield* Stream.runCollect(
          sessionEventStream({
            prompt: 'p',
            sessionId: 's1',
            lastEventId: 0,
            catalog,
            persistLive: () => Effect.void,
          }),
        ).pipe(Effect.provide(GroqStub.layer([])))

        const events = Chunk.toReadonlyArray(collected) as ReadonlyArray<
          AgentEvent
        >
        expect(events).toEqual(seeded)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RepositoryInMemoryLive,
            IdsTest,
            SessionFixed('s1'),
          ),
        ),
      ),
  )

  it.effect(
    'when lastEventId covers everything persisted: emits no replay, only live',
    () =>
      Effect.gen(function* () {
        yield* seedSession('s1', ResearchSessionStatus.active, [
          { id: 1, type: 'agent_thinking', text: 'old' },
        ])

        const collected = yield* Stream.runCollect(
          sessionEventStream({
            prompt: 'p',
            sessionId: 's1',
            lastEventId: 99,
            catalog,
            persistLive: () => Effect.void,
          }),
        ).pipe(
          Effect.provide(GroqStub.layer([finalCompletion('c1', 'fresh')])),
        )
        const events = Chunk.toReadonlyArray(collected) as ReadonlyArray<
          AgentEvent
        >

        // Only live events. Live ids continue from lastEventId + 1.
        expect(events).toEqual([
          { id: 100, type: 'agent_thinking', text: 'fresh' },
          { id: 101, type: 'done', finalText: 'fresh' },
        ])
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RepositoryInMemoryLive,
            IdsTest,
            SessionFixed('s1'),
          ),
        ),
      ),
  )
})
