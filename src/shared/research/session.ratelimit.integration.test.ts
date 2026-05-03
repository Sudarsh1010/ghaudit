/**
 * Integration test for the rate-limited `POST /session` pipeline.
 *
 * Reconstructs the same composition the server-fn handler uses:
 *
 *   1. `RateLimiter.checkSessionCreate(key)` — gate
 *   2. `createSession(data)`                 — use case
 *   3. `renderError(...)`                    — boundary translation
 *
 * The vitest environment is `node`, so we can't run this against a real
 * Cloudflare RateLimit binding. Instead we provide a fake binding whose
 * `limit({ key })` returns `{ success: true }` for the first N calls
 * and `{ success: false }` thereafter — the same observable shape a
 * real binding would produce when the bucket exhausts.
 *
 * What this test pins down (that the unit tests don't):
 *   - The rate-limit check happens *before* the session row is written
 *     (binding denies → no row in repository).
 *   - On exhaustion the server-fn error envelope carries
 *     status=429 and retryAfterSeconds=60 (what the client branches on).
 */
import { describe, it, expect } from '@effect/vitest'
import { Cause, Effect, Exit, Layer } from 'effect'
import { type AppError, RequestRateLimited } from '~/shared/domain/errors'
import { renderError, type ServerFnError } from '~/shared/domain/http-errors'
import { IdsLive } from '~/shared/domain/ids'
import { RepositoryInMemoryLive } from '~/shared/infra/drizzle/repository'
import {
  RateLimiter,
  RateLimiterLive,
  type RateLimitBinding,
} from '~/shared/infra/ratelimit/client'
import { createSession } from './session'
import { EventStreamUrlBuilderLive } from '~/shared/runtime/main'

/**
 * Fake binding that approximates Cloudflare's behaviour: allows up to
 * `limit` calls, denies after that. Keys are ignored — a real binding
 * would scope by key, but the test only spams one IP.
 */
const exhaustingBinding = (limit: number): RateLimitBinding => {
  let count = 0
  return {
    limit: async () => {
      count += 1
      return { success: count <= limit }
    },
  }
}

const alwaysAllow: RateLimitBinding = {
  limit: async () => ({ success: true }),
}

const TestLayer = (sessionCreate: RateLimitBinding) =>
  Layer.mergeAll(
    IdsLive,
    RepositoryInMemoryLive,
    EventStreamUrlBuilderLive((id) => `/session/${id}/stream`),
    RateLimiterLive({
      sessionCreate,
      answerSubmit: alwaysAllow,
      periodSeconds: 60,
    }),
  )

/**
 * Mirrors the server-fn composition. Kept inline rather than extracted
 * into production code so the production module stays free of HTTP
 * concerns — the wrapper is only meaningful at the request boundary.
 */
const ratelimitedCreateSession = (
  key: string,
  input: { initialPrompt: string },
) =>
  Effect.gen(function* () {
    const rl = yield* RateLimiter
    yield* rl.checkSessionCreate(key)
    return yield* createSession(input)
  })

describe('POST /session — rate-limited pipeline', () => {
  it.effect(
    'spam past the limit: first N requests succeed, (N+1)th fails with 429 + Retry-After=60',
    () =>
      Effect.gen(function* () {
        const limit = 3

        // The first `limit` requests should succeed: each writes a row
        // and returns a session id.
        for (let i = 0; i < limit; i += 1) {
          const result = yield* ratelimitedCreateSession('1.2.3.4', {
            initialPrompt: `attempt ${i + 1}`,
          })
          expect(result.sessionId).toMatch(/^rs_/)
        }

        // The (limit+1)th request fails at the rate-limit gate. The
        // gate runs before `createSession`, so the failure value is the
        // tagged `RequestRateLimited` (no repository error mixed in).
        const exit = yield* Effect.exit(
          ratelimitedCreateSession('1.2.3.4', { initialPrompt: 'overflow' }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const failure = Cause.failureOption(exit.cause)
          expect(failure._tag).toBe('Some')
          if (failure._tag === 'Some') {
            // Tagged-error invariant: `RequestRateLimited` here proves
            // the gate fired *and* createSession was not reached
            // (createSession's R can't produce this tag).
            expect(failure.value).toBeInstanceOf(RequestRateLimited)

            // Render through the server-fn boundary translator. This
            // is exactly what the handler does: AppError → ServerFnError.
            const rendered: ServerFnError = renderError(
              failure.value as AppError,
            )
            expect(rendered.tag).toBe('RequestRateLimited')
            expect(rendered.status).toBe(429)
            expect(rendered.retryAfterSeconds).toBe(60)
          }
        }
      }).pipe(Effect.provide(TestLayer(exhaustingBinding(3)))),
  )

  it.effect('happy path with always-allow binding returns the session id', () =>
    Effect.gen(function* () {
      const result = yield* ratelimitedCreateSession('1.2.3.4', {
        initialPrompt: 'hi',
      })
      expect(result.sessionId).toMatch(/^rs_/)
      expect(result.eventStreamUrl).toBe(`/session/${result.sessionId}/stream`)
    }).pipe(Effect.provide(TestLayer(alwaysAllow))),
  )
})
