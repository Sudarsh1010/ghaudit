/**
 * `RateLimiter` — Effect service for the worker-edge rate-limit seam.
 *
 * Public surface (intentionally narrow):
 *   - `checkSessionCreate(key)` — gate `POST /session`
 *   - `checkAnswerSubmit(key)`  — gate `POST /session/:id/answer/:qid`
 *
 * Both fail with `RequestRateLimited` when the underlying Cloudflare
 * binding returns `{ success: false }`. Callers never see the binding,
 * never see the success/failure shape, never compute the `Retry-After`
 * — the service owns all of that.
 *
 * `Retry-After` is derived from the layer's `periodSeconds` (the same
 * value configured on the binding in `alchemy.run.ts`). The CF binding
 * itself doesn't return a retry-after, so this is a deliberate choice:
 * we tell the client "wait one full window" rather than guessing.
 */
import { Context, Effect, Layer } from 'effect'
import { RequestRateLimited } from '~/shared/domain/errors'

/**
 * Minimal shape of the Cloudflare `RateLimit` runtime binding.
 * Re-declared rather than imported from `@cloudflare/workers-types`
 * so tests can hand-roll a fake without dragging the binding type in.
 */
export interface RateLimitBinding {
  readonly limit: (options: {
    readonly key: string
  }) => Promise<{ readonly success: boolean }>
}

export class RateLimiter extends Context.Tag('RateLimiter')<
  RateLimiter,
  {
    readonly checkSessionCreate: (
      key: string,
    ) => Effect.Effect<void, RequestRateLimited>
    readonly checkAnswerSubmit: (
      key: string,
    ) => Effect.Effect<void, RequestRateLimited>
  }
>() {}

export interface RateLimiterLiveOptions {
  readonly sessionCreate: RateLimitBinding
  readonly answerSubmit: RateLimitBinding
  readonly periodSeconds: number
}

/**
 * Live layer. Each `check*` call hits the corresponding binding and
 * translates `{ success: false }` into a tagged failure.
 */
export const RateLimiterLive = (
  options: RateLimiterLiveOptions,
): Layer.Layer<RateLimiter> =>
  Layer.succeed(
    RateLimiter,
    RateLimiter.of({
      checkSessionCreate: (key) =>
        Effect.gen(function* () {
          const outcome = yield* Effect.promise(() =>
            options.sessionCreate.limit({ key }),
          )
          if (!outcome.success) {
            return yield* new RequestRateLimited({
              scope: 'session-create',
              retryAfterSeconds: options.periodSeconds,
            })
          }
        }),
      checkAnswerSubmit: (key) =>
        Effect.gen(function* () {
          const outcome = yield* Effect.promise(() =>
            options.answerSubmit.limit({ key }),
          )
          if (!outcome.success) {
            return yield* new RequestRateLimited({
              scope: 'answer-submit',
              retryAfterSeconds: options.periodSeconds,
            })
          }
        }),
    }),
  )
