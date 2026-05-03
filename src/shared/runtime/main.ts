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
import { EventStreamUrlBuilder } from '~/shared/research/session'

export interface MainLiveOptions {
  readonly D1: D1Database
  readonly groq: GroqLiveOptions
  readonly brave?: BraveLiveOptions
  readonly context7?: Context7LiveOptions
  readonly urlFetcher?: UrlFetcherLiveOptions
}

export const MainLive = (
  options: MainLiveOptions,
): Layer.Layer<
  Ids | Groq | ResearchRepository | BraveSearch | Context7 | UrlFetcher,
  GroqAuthError
> =>
  Layer.mergeAll(
    IdsLive,
    GroqLive(options.groq),
    RepositoryD1Live({ D1: options.D1 }),
    BraveLive(options.brave ?? { apiKey: undefined }),
    Context7Live(options.context7 ?? {}),
    UrlFetcherLive(options.urlFetcher ?? {}),
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
