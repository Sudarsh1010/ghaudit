/**
 * Tests for the `UrlFetcher` Effect service.
 *
 * The fetcher GETs a URL and returns extracted readable text. v1 strips HTML
 * tags and collapses whitespace — no fancy readability extraction. The seam
 * exists so the `readUrl` tool can hand off "give me the text of <url>"
 * without owning timeout / size-guard / extraction logic.
 */
import { describe, it, expect } from '@effect/vitest'
import { Cause, Effect, Exit, TestClock } from 'effect'
import { UrlFetcher, UrlFetcherLive } from './client'

interface Captured {
  readonly url: string
  readonly init: RequestInit
}

const fetchStub = (
  body: string,
  status: number,
  log: { current: Captured | null },
  contentType = 'text/html',
): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    log.current = {
      url: typeof input === 'string' ? input : input.toString(),
      init: init ?? {},
    }
    return new Response(body, {
      status,
      headers: { 'content-type': contentType },
    })
  }) as typeof fetch

describe('UrlFetcherLive.fetchReadable', () => {
  it.effect('GETs the URL and returns plain text with HTML stripped', () =>
    Effect.gen(function* () {
      const log: { current: Captured | null } = { current: null }
      const layer = UrlFetcherLive({
        fetch: fetchStub(
          '<html><body><h1>Hello</h1><p>This is a <a href="x">link</a> and <strong>bold</strong> text.</p><script>alert(1)</script></body></html>',
          200,
          log,
        ),
      })

      const program = Effect.gen(function* () {
        const f = yield* UrlFetcher
        return yield* f.fetchReadable('https://example.com/article')
      })

      const out = yield* program.pipe(Effect.provide(layer))
      expect(out.url).toBe('https://example.com/article')
      // Tags stripped, whitespace collapsed, scripts dropped.
      expect(out.content).toBe('Hello This is a link and bold text.')
      expect(log.current?.url).toBe('https://example.com/article')
    }),
  )

  it.effect('returns plain text bodies unchanged (whitespace-collapsed)', () =>
    Effect.gen(function* () {
      const log: { current: Captured | null } = { current: null }
      const layer = UrlFetcherLive({
        fetch: fetchStub(
          'Line one.\n\nLine    two.\n\tLine\tthree.',
          200,
          log,
          'text/plain',
        ),
      })
      const program = Effect.gen(function* () {
        const f = yield* UrlFetcher
        return yield* f.fetchReadable('https://example.com/raw.txt')
      })
      const out = yield* program.pipe(Effect.provide(layer))
      expect(out.content).toBe('Line one. Line two. Line three.')
    }),
  )

  it.effect('fails with UrlFetcherTimeout when fetch never resolves', () =>
    Effect.gen(function* () {
      // Slow fetch — never resolves on its own.
      const slowFetch = (() =>
        new Promise<Response>(() => {
          /* never */
        })) as unknown as typeof fetch

      const layer = UrlFetcherLive({
        fetch: slowFetch,
        timeoutMillis: 1_000,
      })

      const program = Effect.gen(function* () {
        const f = yield* UrlFetcher
        return yield* f.fetchReadable('https://slow.example/article')
      })

      // Drive the timeout deterministically via TestClock.
      const fiber = yield* Effect.fork(
        program.pipe(Effect.provide(layer), Effect.exit),
      )
      yield* TestClock.adjust('2 seconds')
      const exit = yield* fiber.await

      // Fiber.await wraps the exit; unwrap if needed.
      const inner = exit._tag === 'Success' ? exit.value : exit
      expect(Exit.isFailure(inner)).toBe(true)
      if (Exit.isFailure(inner)) {
        const failure = Cause.failureOption(inner.cause)
        expect(failure._tag).toBe('Some')
        if (failure._tag === 'Some') {
          expect(failure.value._tag).toBe('UrlFetcherTimeout')
        }
      }
    }),
  )
})
