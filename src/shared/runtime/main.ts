/**
 * `MainLive` — the live layer composition every server entry point uses.
 *
 * Composes the always-on services:
 *
 *   - `Ids`                  via `IdsLive` (web crypto)
 *   - `Groq`                 via `GroqLive`  (API key + retry + timeout)
 *   - `ResearchRepository`   via `RepositoryD1Live` (Drizzle on D1)
 *   - `BraveSearch`          via `BraveLive` (Brave Search API)
 *   - `Context7`             via `Context7Live` (public Context7 v1)
 *   - `UrlFetcher`           via `UrlFetcherLive` (timeout + size guard)
 *   - `RateLimiter`          via `RateLimiterLive` (CF rate-limit bindings)
 *
 * Per-request services (`EventStreamUrlBuilder`, `SessionContext`) are
 * NOT in here — those are provided fresh at the request boundary, where
 * their values exist.
 *
 * `MainLive` may fail at construction with `GroqAuthError` when the
 * `GROQ_API_KEY` is missing — surfacing the misconfig at boot rather
 * than letting the first chat request return a confusing 502.
 */
import { Layer } from 'effect'
import type { GroqAuthError } from '~/shared/domain/errors'
import { Ids, IdsLive } from '~/shared/domain/ids'
import {
  RepositoryD1Live,
  ResearchRepository,
} from '~/shared/infra/drizzle/repository'
import { Groq, GroqLive, type GroqLiveOptions } from '~/shared/infra/groq/client'
import {
  BraveLive,
  BraveSearch,
  type BraveLiveOptions,
} from '~/shared/infra/brave/client'
import {
  Context7,
  Context7Live,
  type Context7LiveOptions,
} from '~/shared/infra/context7/client'
import {
  UrlFetcher,
  UrlFetcherLive,
  type UrlFetcherLiveOptions,
} from '~/shared/infra/url-fetcher/client'
import {
  RateLimiter,
  RateLimiterLive,
  type RateLimitBinding,
} from '~/shared/infra/ratelimit/client'
import { EventStreamUrlBuilder } from '~/shared/research/session'

export interface MainLiveOptions {
  readonly D1: D1Database
  readonly groq: GroqLiveOptions
  readonly brave?: BraveLiveOptions
  readonly context7?: Context7LiveOptions
  readonly urlFetcher?: UrlFetcherLiveOptions
  /**
   * Worker-edge rate-limit bindings. Optional: only the worker entry
   * (server.ts / server-fns) provides them. The Durable Object lives
   * behind the worker boundary, so its RateLimiter is a no-op (every
   * inbound DO request has already passed the worker gate).
   */
  readonly rateLimit?: {
    readonly sessionCreate: RateLimitBinding
    readonly answerSubmit: RateLimitBinding
    /**
     * Window length in seconds. Mirrors the `period` configured on the
     * underlying `RateLimit()` bindings in `alchemy.run.ts`. Used as the
     * `Retry-After` value the worker sends on 429s.
     */
    readonly periodSeconds: number
  }
}

const allowAlways: RateLimitBinding = {
  limit: async () => ({ success: true }),
}

export const MainLive = (
  options: MainLiveOptions,
): Layer.Layer<
  | Ids
  | Groq
  | ResearchRepository
  | BraveSearch
  | Context7
  | UrlFetcher
  | RateLimiter,
  GroqAuthError
> =>
  Layer.mergeAll(
    IdsLive,
    GroqLive(options.groq),
    RepositoryD1Live({ D1: options.D1 }),
    BraveLive(options.brave ?? { apiKey: undefined }),
    Context7Live(options.context7 ?? {}),
    UrlFetcherLive(options.urlFetcher ?? {}),
    RateLimiterLive(
      options.rateLimit ?? {
        sessionCreate: allowAlways,
        answerSubmit: allowAlways,
        periodSeconds: 60,
      },
    ),
  )

/**
 * Build an `EventStreamUrlBuilder` layer with a closed-over render fn.
 * Worker passes a function that joins onto the inbound `Request.url`;
 * tests pass a fixed string.
 */
export const EventStreamUrlBuilderLive = (
  build: (sessionId: string) => string,
): Layer.Layer<EventStreamUrlBuilder> =>
  Layer.succeed(EventStreamUrlBuilder, { build })
