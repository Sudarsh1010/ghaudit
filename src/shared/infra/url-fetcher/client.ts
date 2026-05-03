/**
 * `UrlFetcher` — Effect service for the `readUrl` tool.
 *
 * Fetches a URL with a sane timeout, guards against oversize responses,
 * and extracts readable text from the body. v1 extraction is deliberately
 * dumb: strip `<script>` and `<style>` blocks, drop the rest of the tags,
 * collapse whitespace. Good enough to feed back into the LLM as grounding
 * for a recommendation; we can deepen later if real-world pages need it.
 *
 * Errors are typed:
 *   - `UrlFetcherTimeout`     — request didn't complete in time
 *   - `UrlFetcherTooLarge`    — response body exceeded `maxBytes`
 *   - `UrlFetcherHttpError`   — non-2xx status
 *   - `UrlFetcherNetworkError` — anything else (DNS, abort, etc.)
 */
import { Context, Effect, Layer, Ref } from 'effect'
import {
  type UrlFetcherError,
  UrlFetcherHttpError,
  UrlFetcherNetworkError,
  UrlFetcherTimeout,
  UrlFetcherTooLarge,
} from '~/shared/domain/errors'

export interface ReadableContent {
  readonly url: string
  readonly content: string
}

export class UrlFetcher extends Context.Tag('UrlFetcher')<
  UrlFetcher,
  {
    readonly fetchReadable: (
      url: string,
    ) => Effect.Effect<ReadableContent, UrlFetcherError>
  }
>() {}

export interface UrlFetcherLiveOptions {
  readonly fetch?: typeof fetch
  /** Default 10s. */
  readonly timeoutMillis?: number
  /** Default 1 MiB. Bodies above this fail with `UrlFetcherTooLarge`. */
  readonly maxBytes?: number
}

const DEFAULT_TIMEOUT = 10_000
const DEFAULT_MAX_BYTES = 1_000_000

export const UrlFetcherLive = (
  options: UrlFetcherLiveOptions = {},
): Layer.Layer<UrlFetcher> =>
  Layer.succeed(UrlFetcher, {
    fetchReadable: (url) =>
      Effect.gen(function* () {
        const fetchImpl = options.fetch ?? fetch
        const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

        const res = yield* Effect.tryPromise({
          try: () =>
            fetchImpl(url, {
              method: 'GET',
              headers: { accept: 'text/html, text/plain;q=0.9, */*;q=0.5' },
            }),
          catch: (cause): UrlFetcherError =>
            new UrlFetcherNetworkError({ url, cause }),
        })

        if (!res.ok) {
          return yield* new UrlFetcherHttpError({ url, status: res.status })
        }

        const body = yield* Effect.tryPromise({
          try: () => res.text(),
          catch: (cause): UrlFetcherError =>
            new UrlFetcherNetworkError({ url, cause }),
        })

        if (body.length > maxBytes) {
          return yield* new UrlFetcherTooLarge({ url, bytes: body.length })
        }

        const contentType = res.headers.get('content-type') ?? ''
        const content = contentType.includes('html')
          ? extractFromHtml(body)
          : collapseWhitespace(body)

        return { url, content }
      }).pipe(
        Effect.timeoutFail({
          duration: `${options.timeoutMillis ?? DEFAULT_TIMEOUT} millis`,
          onTimeout: (): UrlFetcherError => new UrlFetcherTimeout({ url }),
        }),
      ),
  })

/* ------------------------------------------------------------------ *
 * Extraction
 *
 * v1 algorithm:
 *   1. drop `<script>` and `<style>` blocks (with their content)
 *   2. drop the rest of the tags (keep their inner text)
 *   3. decode the four entities we actually see (&amp; &lt; &gt; &quot;)
 *   4. collapse whitespace
 *
 * Not perfect; deliberately not parsing HTML. If we need higher quality
 * extraction (article body detection, link preservation, etc.) we can
 * swap this out without changing the tool or the seam.
 * ------------------------------------------------------------------ */

const extractFromHtml = (html: string): string => {
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
  return collapseWhitespace(stripped)
}

const collapseWhitespace = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * Test adapter — canned `ReadableContent`s in order. After the list is
 * exhausted, further calls fail with `UrlFetcherNetworkError`.
 */
export const UrlFetcherStub = {
  layer: (
    responses: ReadonlyArray<ReadableContent>,
  ): Layer.Layer<UrlFetcher> =>
    Layer.scoped(
      UrlFetcher,
      Effect.gen(function* () {
        const cursor = yield* Ref.make(0)
        return UrlFetcher.of({
          fetchReadable: (url) =>
            Effect.gen(function* () {
              const i = yield* Ref.modify(cursor, (n) => [n, n + 1])
              const r = responses[i]
              if (!r) {
                return yield* new UrlFetcherNetworkError({
                  url,
                  cause: `UrlFetcherStub: no canned response for call ${i + 1}`,
                })
              }
              return r
            }),
        })
      }),
    ),
}
