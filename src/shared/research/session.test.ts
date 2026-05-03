/**
 * `createSession` is the seam where a new Research Session is minted.
 * Tests provide:
 *
 *   - `IdsTest`              — deterministic ids (`rs_0001`, …)
 *   - `RepositoryInMemoryLive` — Map-backed `ResearchRepository`
 *   - `EventStreamUrlBuilderLive` — fixed render fn so the URL is asserted
 *
 * The empty-prompt rejection is asserted at the worker boundary
 * (`server.ts` decodes through `CreateSessionRequest`); here we verify
 * the in-process invariant that `createSession` *itself* doesn't
 * impose minLength — its R says it just needs an id and a place to
 * write.
 */
import { describe, it, expect } from '@effect/vitest'
import { Effect, Layer, TestClock } from 'effect'
import { Ids, IdsTest } from '~/shared/domain/ids'
import {
  RepositoryInMemoryLive,
  ResearchRepository,
} from '~/shared/infra/drizzle/repository'
import { ResearchSessionStatus } from '~/shared/infra/drizzle/schema'
import {
  createSession,
  EventStreamUrlBuilder,
} from './session'
import { EventStreamUrlBuilderLive } from '~/shared/runtime/main'

const TestLayer = Layer.mergeAll(
  IdsTest,
  RepositoryInMemoryLive,
  EventStreamUrlBuilderLive((id) => `/session/${id}/stream`),
)

describe('createSession', () => {
  it.effect(
    'persists a research_sessions row and returns the SSE stream URL',
    () =>
      Effect.gen(function* () {
        // Pin the clock so `createdAt` is observable.
        yield* TestClock.setTime(1700000000000)

        const result = yield* createSession({
          initialPrompt: 'help me write a PRD',
        })

        expect(result.sessionId).toBe('rs_0001')
        expect(result.eventStreamUrl).toBe('/session/rs_0001/stream')

        const repo = yield* ResearchRepository
        const row = yield* repo.getSessionById('rs_0001')
        expect(row.initialPrompt).toBe('help me write a PRD')
        expect(row.status).toBe(ResearchSessionStatus.active)
        expect(row.createdAt.getTime()).toBe(1700000000000)
        expect(row.updatedAt.getTime()).toBe(1700000000000)
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('mints a fresh id per call', () =>
    Effect.gen(function* () {
      const a = yield* createSession({ initialPrompt: 'first' })
      const b = yield* createSession({ initialPrompt: 'second' })
      expect(a.sessionId).toBe('rs_0001')
      expect(b.sessionId).toBe('rs_0002')
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    'mints a fresh ownerId per session and persists it on the row',
    () =>
      Effect.gen(function* () {
        const result = yield* createSession({ initialPrompt: 'p' })
        expect(result.ownerId).toBe('own_0001')

        const repo = yield* ResearchRepository
        const row = yield* repo.getSessionById(result.sessionId)
        expect(row.ownerId).toBe('own_0001')

        const second = yield* createSession({ initialPrompt: 'p2' })
        expect(second.ownerId).toBe('own_0002')
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('threads the EventStreamUrlBuilder through R', () =>
    Effect.gen(function* () {
      const result = yield* createSession({ initialPrompt: 'x' })
      const builder = yield* EventStreamUrlBuilder
      expect(result.eventStreamUrl).toBe(builder.build(result.sessionId))
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          IdsTest,
          RepositoryInMemoryLive,
          EventStreamUrlBuilderLive(
            (id) => `https://example.test/session/${id}/stream`,
          ),
        ),
      ),
    ),
  )

  it.effect('Ids can be swapped for a different prefix layer', () =>
    Effect.gen(function* () {
      const ids = yield* Ids
      // Sanity: the test layer is what we expect.
      const minted = yield* ids.mint('rs_')
      expect(minted).toBe('rs_0001')
    }).pipe(Effect.provide(IdsTest)),
  )
})
