/**
 * `BraveSearch` — Effect service for the Brave Search API seam.
 *
 * The seam exists so the `webSearch` tool can hand off "find me top results
 * for query X" to a swappable adapter. Live talks to Brave via `fetch`;
 * tests provide either a stubbed `fetch` (this file's `BraveLive` tests) or
 * a canned `BraveStub.layer` (consumers that don't care about wire shape).
 *
 * Auth: `X-Subscription-Token: <BRAVE_API_KEY>` header. Missing key fails
 * the layer build with `BraveAuthError` rather than letting the request
 * 401 at runtime.
 *
 * Wire shape (what the tool wraps):
 *
 *   GET https://api.search.brave.com/res/v1/web/search?q=<query>&count=<n>
 *   Accept: application/json
 *   X-Subscription-Token: <key>
 *
 *   {
 *     "web": { "results": [{ "title": ..., "url": ..., "description": ... }] }
 *   }
 *
 * The service flattens that into `{ results: [{title, url, snippet}] }` —
 * `description` is renamed to `snippet` to match the agent's expectations.
 */
import { Context, Effect, Layer, Ref } from 'effect'
import {
  type BraveError,
  BraveApiError,
  BraveAuthError,
  BraveNetworkError,
  BraveRateLimitError,
} from '~/shared/domain/errors'

export const BRAVE_BASE_URL = 'https://api.search.brave.com/res/v1/web/search'

export interface BraveSearchParams {
  readonly query: string
  /** Top-N results to return; Brave caps at 20. Default 5. */
  readonly count?: number
}

export interface BraveSearchResult {
  readonly title: string
  readonly url: string
  readonly snippet: string
}

export interface BraveSearchResponse {
  readonly results: ReadonlyArray<BraveSearchResult>
}

export class BraveSearch extends Context.Tag('BraveSearch')<
  BraveSearch,
  {
    readonly search: (
      params: BraveSearchParams,
    ) => Effect.Effect<BraveSearchResponse, BraveError>
  }
>() {}

export interface BraveLiveOptions {
  readonly apiKey: string | undefined
  readonly baseURL?: string
  readonly fetch?: typeof fetch
}

interface BraveRawResponse {
  readonly web?: {
    readonly results?: ReadonlyArray<{
      readonly title?: string
      readonly url?: string
      readonly description?: string
    }>
  }
}

const DEFAULT_COUNT = 5

export const BraveLive = (
  options: BraveLiveOptions,
): Layer.Layer<BraveSearch> =>
  Layer.succeed(BraveSearch, {
    search: (params) =>
      Effect.gen(function* () {
        if (!options.apiKey) {
          return yield* new BraveAuthError({
            reason: 'BRAVE_API_KEY is required to call Brave Search',
          })
        }

        const baseURL = options.baseURL ?? BRAVE_BASE_URL
        const fetchImpl = options.fetch ?? fetch
        const count = params.count ?? DEFAULT_COUNT

        const url = `${baseURL}?q=${encodeURIComponent(params.query).replace(/%20/g, '+')}&count=${count}`
        const headers = new Headers({
          accept: 'application/json',
          'x-subscription-token': options.apiKey,
        })

        const res = yield* Effect.tryPromise({
          try: () => fetchImpl(url, { method: 'GET', headers }),
          catch: (cause): BraveError => new BraveNetworkError({ cause }),
        })

        if (res.status === 401 || res.status === 403) {
          return yield* new BraveAuthError({
            reason: `Brave returned ${res.status}`,
          })
        }
        if (res.status === 429) {
          const ra = res.headers.get('retry-after')
          const seconds =
            ra !== null && ra.length > 0 ? Number(ra) : undefined
          return yield* new BraveRateLimitError({
            retryAfterSeconds: Number.isFinite(seconds) ? seconds : undefined,
          })
        }
        if (!res.ok) {
          const body = yield* Effect.tryPromise({
            try: () => res.text(),
            catch: () => new BraveApiError({ status: res.status, body: '' }),
          }).pipe(Effect.orElseSucceed(() => ''))
          return yield* new BraveApiError({ status: res.status, body })
        }

        const json = (yield* Effect.tryPromise({
          try: () => res.json() as Promise<BraveRawResponse>,
          catch: (cause): BraveError => new BraveNetworkError({ cause }),
        })) as BraveRawResponse

        const results = (json.web?.results ?? []).map((r) => ({
          title: r.title ?? '',
          url: r.url ?? '',
          snippet: r.description ?? '',
        }))

        return { results }
      }),
  })

/**
 * Test adapter: returns canned `BraveSearchResponse`s in order. After the
 * list is exhausted, further calls fail with `BraveApiError`. Provide via
 * `Layer.provide(BraveStub.layer([...]))` in `it.effect`.
 */
export const BraveStub = {
  layer: (
    responses: ReadonlyArray<BraveSearchResponse>,
  ): Layer.Layer<BraveSearch> =>
    Layer.scoped(
      BraveSearch,
      Effect.gen(function* () {
        const cursor = yield* Ref.make(0)
        return BraveSearch.of({
          search: () =>
            Effect.gen(function* () {
              const i = yield* Ref.modify(cursor, (n) => [n, n + 1])
              const r = responses[i]
              if (!r) {
                return yield* new BraveApiError({
                  status: 0,
                  body: `BraveStub: no canned response for call ${i + 1}`,
                })
              }
              return r
            }),
        })
      }),
    ),
}
