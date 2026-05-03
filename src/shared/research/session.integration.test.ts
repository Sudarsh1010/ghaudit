/**
 * Slice 2 happy-path: simulates `POST /session` end-to-end at the use-case
 * layer.
 *
 * Differs from `session.test.ts` in that it uses the **live** `Ids` layer
 * (real web crypto) so we exercise the production id format. The session
 * row goes through `RepositoryInMemoryLive` because we don't want a D1
 * binding in the test.
 */
import { describe, it, expect } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { IdsLive } from '~/shared/domain/ids'
import {
  RepositoryInMemoryLive,
  ResearchRepository,
} from '~/shared/infra/drizzle/repository'
import { ResearchSessionStatus } from '~/shared/infra/drizzle/schema'
import { createSession } from './session'
import { EventStreamUrlBuilderLive } from '~/shared/runtime/main'

const TestLayer = Layer.mergeAll(
  IdsLive,
  RepositoryInMemoryLive,
  EventStreamUrlBuilderLive((id) => `/session/${id}/stream`),
)

describe('POST /session happy path (slice 2)', () => {
  it.effect('persists a session row and returns the eventStreamUrl', () =>
    Effect.gen(function* () {
      const result = yield* createSession({
        initialPrompt: 'help me write a PRD',
      })

      expect(result.sessionId).toMatch(/^rs_[0-9a-f]{16}$/)
      expect(result.eventStreamUrl).toBe(
        `/session/${result.sessionId}/stream`,
      )

      const repo = yield* ResearchRepository
      const row = yield* repo.getSessionById(result.sessionId)
      expect(row.initialPrompt).toBe('help me write a PRD')
      expect(row.status).toBe(ResearchSessionStatus.active)
    }).pipe(Effect.provide(TestLayer)),
  )
})
