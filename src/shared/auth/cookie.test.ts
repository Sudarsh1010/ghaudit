/**
 * `OwnerCookie` is the seam where session-owner identifiers cross the
 * trust boundary between server and browser. The cookie's value carries
 * the owner id plus an HMAC signature over that id; verification
 * recomputes the HMAC with the same secret and rejects mismatches.
 *
 * Tests grow incrementally — one behavior per cycle.
 */
import { describe, it, expect } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { OwnerCookie, OwnerCookieLive } from './cookie'

const SECRET = 'test-secret-do-not-ship'
const TestLayer = OwnerCookieLive(SECRET)

describe('OwnerCookie', () => {
  it.effect('sign then verify returns the original owner id', () =>
    Effect.gen(function* () {
      const cookie = yield* OwnerCookie
      const signed = yield* cookie.sign('own_abc123')
      const decoded = yield* cookie.verify(signed)
      expect(Option.getOrNull(decoded)).toBe('own_abc123')
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('verify rejects a tampered owner-id portion', () =>
    Effect.gen(function* () {
      const cookie = yield* OwnerCookie
      const signed = yield* cookie.sign('own_abc123')
      const sig = signed.split('.')[1]!
      const tampered = `own_xyz999.${sig}`
      const decoded = yield* cookie.verify(tampered)
      expect(Option.isNone(decoded)).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('verify rejects a value with no separator (malformed)', () =>
    Effect.gen(function* () {
      const cookie = yield* OwnerCookie
      const decoded = yield* cookie.verify('not-a-signed-value')
      expect(Option.isNone(decoded)).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('verify rejects a value signed with a different secret', () =>
    Effect.gen(function* () {
      const otherSecret = OwnerCookieLive('different-secret')
      const signed = yield* Effect.gen(function* () {
        const c = yield* OwnerCookie
        return yield* c.sign('own_abc123')
      }).pipe(Effect.provide(otherSecret))

      const cookie = yield* OwnerCookie
      const decoded = yield* cookie.verify(signed)
      expect(Option.isNone(decoded)).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )
})
