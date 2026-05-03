/**
 * Tests for the `BraveSearch` Effect service.
 *
 *   - `BraveLive(opts)` is the live layer; we drive it with a `fetch` stub so
 *     the live HTTP transport never opens a real socket.
 *   - The wire shape is asserted on (URL, header, query string).
 *   - Response is parsed into `{ results: [{title, url, snippet}, …] }` —
 *     mapping Brave's `web.results[].description` onto our `snippet`.
 */
import { describe, it, expect } from '@effect/vitest'
import { Cause, Effect, Exit } from 'effect'
import { BRAVE_BASE_URL, BraveSearch, BraveLive } from './client'

interface CapturedRequest {
  readonly url: string
  readonly init: RequestInit
}

const fetchStub = (
  body: object,
  status: number,
  captured: { current: CapturedRequest | null },
  headers?: Record<string, string>,
): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.current = {
      url: typeof input === 'string' ? input : input.toString(),
      init: init ?? {},
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    })
  }) as typeof fetch

describe('BraveLive', () => {
  it.effect('GETs the Brave web/search endpoint with the API key header and parses results', () =>
    Effect.gen(function* () {
      const captured: { current: CapturedRequest | null } = { current: null }
      const layer = BraveLive({
        apiKey: 'test-key',
        fetch: fetchStub(
          {
            web: {
              results: [
                {
                  title: 'Effect-TS docs',
                  url: 'https://effect.website/',
                  description: 'The TypeScript library for building robust apps.',
                },
                {
                  title: 'GitHub: Effect',
                  url: 'https://github.com/Effect-TS/effect',
                  description: 'Source for the Effect library.',
                },
              ],
            },
          },
          200,
          captured,
        ),
      })

      const program = Effect.gen(function* () {
        const brave = yield* BraveSearch
        return yield* brave.search({ query: 'effect typescript', count: 5 })
      })

      const res = yield* program.pipe(Effect.provide(layer))

      expect(res.results).toEqual([
        {
          title: 'Effect-TS docs',
          url: 'https://effect.website/',
          snippet: 'The TypeScript library for building robust apps.',
        },
        {
          title: 'GitHub: Effect',
          url: 'https://github.com/Effect-TS/effect',
          snippet: 'Source for the Effect library.',
        },
      ])

      expect(captured.current).not.toBeNull()
      const { url, init } = captured.current!
      expect(url).toContain(BRAVE_BASE_URL)
      expect(url).toContain('q=effect+typescript')
      expect(url).toContain('count=5')
      const headers = new Headers(init.headers)
      expect(headers.get('x-subscription-token')).toBe('test-key')
      expect(headers.get('accept')).toBe('application/json')
      // Brave is GET — no body.
      expect(init.method ?? 'GET').toBe('GET')
    }),
  )

  it.effect('classifies 429 as BraveRateLimitError with retryAfterSeconds', () =>
    Effect.gen(function* () {
      const captured: { current: CapturedRequest | null } = { current: null }
      const layer = BraveLive({
        apiKey: 'k',
        fetch: fetchStub({}, 429, captured, { 'retry-after': '17' }),
      })
      const program = Effect.gen(function* () {
        const brave = yield* BraveSearch
        return yield* brave.search({ query: 'q' })
      })
      const exit = yield* Effect.exit(program.pipe(Effect.provide(layer)))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(failure._tag).toBe('Some')
        if (failure._tag === 'Some') {
          expect(failure.value._tag).toBe('BraveRateLimitError')
          if (failure.value._tag === 'BraveRateLimitError') {
            expect(failure.value.retryAfterSeconds).toBe(17)
          }
        }
      }
    }),
  )

  it.effect('fails with BraveAuthError when apiKey is missing', () =>
    Effect.gen(function* () {
      const layer = BraveLive({ apiKey: undefined })
      const program = Effect.gen(function* () {
        const brave = yield* BraveSearch
        return yield* brave.search({ query: 'x' })
      })
      const exit = yield* Effect.exit(program.pipe(Effect.provide(layer)))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(failure._tag).toBe('Some')
        if (failure._tag === 'Some') {
          expect(failure.value._tag).toBe('BraveAuthError')
        }
      }
    }),
  )
})
