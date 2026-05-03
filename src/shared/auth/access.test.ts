/**
 * `assertSessionAccess` is the use case session-scoped HTTP routes call
 * before they do anything else. It folds three failure modes into a
 * single `Forbidden` so callers don't have to branch and so we don't
 * leak whether a session id exists:
 *
 *   - missing cookie        → Forbidden
 *   - cookie HMAC invalid    → Forbidden
 *   - cookie owner ≠ stored owner → Forbidden
 *   - session not found      → Forbidden  (privacy: don't disclose
 *                                          existence to the public)
 *
 * On success it returns the loaded `ResearchSessionRow` so callers
 * (e.g. the `/stream` proxy) can use other fields like `initialPrompt`
 * without a second DB hit.
 *
 * Tests grow incrementally — one branch per cycle.
 */
import { describe, it, expect } from '@effect/vitest'
import { Cause, Effect, Exit, Layer, Option } from 'effect'
import { OwnerCookie, OwnerCookieLive } from './cookie'
import { assertSessionAccess } from './access'
import {
  RepositoryInMemoryLive,
  ResearchRepository,
} from '~/shared/infra/drizzle/repository'
import { ResearchSessionStatus } from '~/shared/infra/drizzle/schema'

const expectForbidden = <A>(exit: Exit.Exit<A, unknown>): void => {
  if (Exit.isSuccess(exit)) {
    throw new Error(`expected failure, got success: ${JSON.stringify(exit.value)}`)
  }
  const failure = Cause.failureOption(exit.cause)
  if (Option.isNone(failure)) {
    throw new Error(`expected tagged failure, got: ${Cause.pretty(exit.cause)}`)
  }
  const tag = (failure.value as { _tag?: string })._tag
  expect(tag).toBe('Forbidden')
}

const TestLayer = Layer.mergeAll(
  OwnerCookieLive('test-secret'),
  RepositoryInMemoryLive,
)

const seed = (sessionId: string, ownerId: string) =>
  Effect.gen(function* () {
    const repo = yield* ResearchRepository
    yield* repo.createSession({
      id: sessionId,
      initialPrompt: 'p',
      status: ResearchSessionStatus.active,
      ownerId,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    })
  })

describe('assertSessionAccess', () => {
  it.effect('returns the session when the cookie owner matches', () =>
    Effect.gen(function* () {
      yield* seed('rs_1', 'own_1')
      const cookie = yield* OwnerCookie
      const signed = yield* cookie.sign('own_1')

      const row = yield* assertSessionAccess({
        sessionId: 'rs_1',
        signedCookie: Option.some(signed),
      })
      expect(row.id).toBe('rs_1')
      expect(row.ownerId).toBe('own_1')
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('Forbidden when no cookie is supplied', () =>
    Effect.gen(function* () {
      yield* seed('rs_1', 'own_1')
      const exit = yield* Effect.exit(
        assertSessionAccess({
          sessionId: 'rs_1',
          signedCookie: Option.none(),
        }),
      )
      expectForbidden(exit)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('Forbidden when the cookie was signed for a different owner', () =>
    Effect.gen(function* () {
      yield* seed('rs_1', 'own_1')
      const cookie = yield* OwnerCookie
      const foreign = yield* cookie.sign('own_2')

      const exit = yield* Effect.exit(
        assertSessionAccess({
          sessionId: 'rs_1',
          signedCookie: Option.some(foreign),
        }),
      )
      expectForbidden(exit)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('Forbidden when the cookie signature is invalid', () =>
    Effect.gen(function* () {
      yield* seed('rs_1', 'own_1')
      const exit = yield* Effect.exit(
        assertSessionAccess({
          sessionId: 'rs_1',
          signedCookie: Option.some('own_1.deadbeef'),
        }),
      )
      expectForbidden(exit)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('Forbidden when the session id does not exist (no leak)', () =>
    Effect.gen(function* () {
      const cookie = yield* OwnerCookie
      const signed = yield* cookie.sign('own_1')
      const exit = yield* Effect.exit(
        assertSessionAccess({
          sessionId: 'rs_does_not_exist',
          signedCookie: Option.some(signed),
        }),
      )
      expectForbidden(exit)
    }).pipe(Effect.provide(TestLayer)),
  )
})
