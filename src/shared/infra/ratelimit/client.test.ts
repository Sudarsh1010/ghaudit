/**
 * `RateLimiter` is a deep module: callers say `rl.checkSessionCreate(key)`
 * and never touch the underlying Cloudflare binding shape, the key
 * derivation, or the `{ success: boolean }` → tagged-error translation.
 *
 * These tests provide hand-rolled fake bindings that match the
 * Cloudflare `RateLimit` runtime shape (`limit({ key }) → { success }`).
 * The fakes are deliberately not Effect services — they live on the
 * "Cloudflare side" of the seam.
 */
import { describe, it, expect } from '@effect/vitest'
import { Cause, Effect, Exit } from 'effect'
import { RequestRateLimited } from '~/shared/domain/errors'
import { RateLimiter, RateLimiterLive } from './client'

interface FakeBinding {
  readonly limit: (options: { key: string }) => Promise<{ success: boolean }>
}

const stubBinding = (success: boolean): FakeBinding => ({
  limit: async () => ({ success }),
})

describe('RateLimiter.checkSessionCreate', () => {
  it.effect(
    'fails with RequestRateLimited(scope=session-create, retryAfterSeconds=60) when binding denies',
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const rl = yield* RateLimiter
            yield* rl.checkSessionCreate('1.2.3.4')
          }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const failure = Cause.failureOption(exit.cause)
          expect(failure._tag).toBe('Some')
          if (failure._tag === 'Some') {
            expect(failure.value).toBeInstanceOf(RequestRateLimited)
            expect(failure.value.scope).toBe('session-create')
            expect(failure.value.retryAfterSeconds).toBe(60)
          }
        }
      }).pipe(
        Effect.provide(
          RateLimiterLive({
            sessionCreate: stubBinding(false),
            answerSubmit: stubBinding(true),
            periodSeconds: 60,
          }),
        ),
      ),
  )

  it.effect('succeeds when the binding allows the request', () =>
    Effect.gen(function* () {
      const rl = yield* RateLimiter
      // The success of the Effect itself is the assertion — if the
      // service threw `RequestRateLimited` here, this expression
      // would fail with that error (R contains it, so it can't escape).
      yield* rl.checkSessionCreate('1.2.3.4')
    }).pipe(
      Effect.provide(
        RateLimiterLive({
          sessionCreate: stubBinding(true),
          answerSubmit: stubBinding(false),
          periodSeconds: 60,
        }),
      ),
    ),
  )
})

describe('RateLimiter binding routing', () => {
  it.effect(
    'checkAnswerSubmit fails with scope=answer-submit (uses answer binding, not session binding)',
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const rl = yield* RateLimiter
            yield* rl.checkAnswerSubmit('1.2.3.4')
          }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const failure = Cause.failureOption(exit.cause)
          if (failure._tag === 'Some') {
            expect(failure.value).toBeInstanceOf(RequestRateLimited)
            expect(failure.value.scope).toBe('answer-submit')
          }
        }
      }).pipe(
        // The session binding is *open* (true) and the answer binding is
        // *closed* (false). The only way the test fails with
        // scope=answer-submit is if the service routed through the
        // answer binding, not the session one.
        Effect.provide(
          RateLimiterLive({
            sessionCreate: stubBinding(true),
            answerSubmit: stubBinding(false),
            periodSeconds: 60,
          }),
        ),
      ),
  )
})

describe('RateLimiter key forwarding', () => {
  it.effect("passes the caller's key through to the binding", () => {
    const calls: Array<{ binding: 'session' | 'answer'; key: string }> = []
    const recordingBinding = (which: 'session' | 'answer'): FakeBinding => ({
      limit: async ({ key }) => {
        calls.push({ binding: which, key })
        return { success: true }
      },
    })

    return Effect.gen(function* () {
      const rl = yield* RateLimiter
      yield* rl.checkSessionCreate('203.0.113.7')
      yield* rl.checkAnswerSubmit('198.51.100.42')

      expect(calls).toEqual([
        { binding: 'session', key: '203.0.113.7' },
        { binding: 'answer', key: '198.51.100.42' },
      ])
    }).pipe(
      Effect.provide(
        RateLimiterLive({
          sessionCreate: recordingBinding('session'),
          answerSubmit: recordingBinding('answer'),
          periodSeconds: 60,
        }),
      ),
    )
  })
})
