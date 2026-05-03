/**
 * Slice 6 acceptance test, run end-to-end through the use cases.
 *
 *   - Create a session via `createSession` (slice 2 use case).
 *   - Drop the cookie → `assertSessionAccess` returns `Forbidden`.
 *   - Restore the cookie → access succeeds.
 *   - Create a second session under cookie B; attempting access to
 *     session A with cookie B returns `Forbidden`.
 *
 * Mirrors the AC: "create a session, drop the cookie, GET the stream
 * returns 403; restore the cookie, GET succeeds; create a session with
 * cookie A, attempt access with cookie B, returns 403."
 *
 * Runs against the in-memory repository so we don't need a real D1
 * binding. The HTTP boundary (parsing the cookie header, mapping
 * Forbidden to 403) is one extra layer above what's tested here, kept
 * trivial in `src/server.ts` and `src/server-fns/session.ts` so it
 * doesn't carry independent risk.
 */
import { describe, it, expect } from '@effect/vitest'
import { Cause, Effect, Exit, Layer, Option } from 'effect'
import { assertSessionAccess } from './access'
import { OwnerCookie, OwnerCookieLive } from './cookie'
import { IdsLive } from '~/shared/domain/ids'
import { RepositoryInMemoryLive } from '~/shared/infra/drizzle/repository'
import {
  createSession,
} from '~/shared/research/session'
import { EventStreamUrlBuilderLive } from '~/shared/runtime/main'

const SECRET = 'integration-test-secret'

const TestLayer = Layer.mergeAll(
  IdsLive,
  RepositoryInMemoryLive,
  OwnerCookieLive(SECRET),
  EventStreamUrlBuilderLive((id) => `/session/${id}/stream`),
)

const expectForbidden = <A>(exit: Exit.Exit<A, unknown>): void => {
  if (Exit.isSuccess(exit)) {
    throw new Error(`expected failure, got success: ${JSON.stringify(exit.value)}`)
  }
  const failure = Cause.failureOption(exit.cause)
  if (Option.isNone(failure)) {
    throw new Error(`expected tagged failure, got: ${Cause.pretty(exit.cause)}`)
  }
  expect((failure.value as { _tag?: string })._tag).toBe('Forbidden')
}

describe('Slice 6 cookie auth — end-to-end', () => {
  it.effect(
    'creates a session, then enforces cookie ownership on subsequent access',
    () =>
      Effect.gen(function* () {
        const cookie = yield* OwnerCookie

        // Create session A; mint cookie A from its returned ownerId.
        const a = yield* createSession({ initialPrompt: 'session A' })
        const cookieA = yield* cookie.sign(a.ownerId)

        // Cookie present + matching → access granted.
        const okExit = yield* Effect.exit(
          assertSessionAccess({
            sessionId: a.sessionId,
            signedCookie: Option.some(cookieA),
          }),
        )
        expect(Exit.isSuccess(okExit)).toBe(true)

        // Drop the cookie → 403.
        const noCookieExit = yield* Effect.exit(
          assertSessionAccess({
            sessionId: a.sessionId,
            signedCookie: Option.none(),
          }),
        )
        expectForbidden(noCookieExit)

        // Restore cookie → 200.
        const restoredExit = yield* Effect.exit(
          assertSessionAccess({
            sessionId: a.sessionId,
            signedCookie: Option.some(cookieA),
          }),
        )
        expect(Exit.isSuccess(restoredExit)).toBe(true)

        // Create session B with a fresh owner; cookie B must not unlock A.
        const b = yield* createSession({ initialPrompt: 'session B' })
        const cookieB = yield* cookie.sign(b.ownerId)

        const crossExit = yield* Effect.exit(
          assertSessionAccess({
            sessionId: a.sessionId,
            signedCookie: Option.some(cookieB),
          }),
        )
        expectForbidden(crossExit)

        // And the converse: cookie A doesn't unlock B.
        const crossExit2 = yield* Effect.exit(
          assertSessionAccess({
            sessionId: b.sessionId,
            signedCookie: Option.some(cookieA),
          }),
        )
        expectForbidden(crossExit2)
      }).pipe(Effect.provide(TestLayer)),
  )
})
