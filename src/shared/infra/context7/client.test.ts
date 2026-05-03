/**
 * Tests for the `Context7` Effect service.
 *
 * Context7 has a public v1 endpoint that doesn't require an API key. The
 * `searchDocs` operation is a two-step orchestration: search the library
 * catalogue, then fetch context for the top hit. Tests stub `fetch` and
 * assert on the wire shape of *both* calls plus the merged response.
 */
import { describe, it, expect } from '@effect/vitest'
import { Effect } from 'effect'
import { CONTEXT7_BASE_URL, Context7, Context7Live } from './client'

interface Captured {
  readonly url: string
  readonly init: RequestInit
}

const sequencedFetch = (
  responses: ReadonlyArray<{
    readonly status: number
    readonly body: unknown
  }>,
  log: Array<Captured>,
): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const i = log.length
    log.push({
      url: typeof input === 'string' ? input : input.toString(),
      init: init ?? {},
    })
    const turn = responses[i]
    if (!turn) throw new Error(`no canned response for call ${i + 1}`)
    return new Response(JSON.stringify(turn.body), {
      status: turn.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

describe('Context7Live.searchLibrary', () => {
  it.effect('GETs /api/v1/search?query=<name> and returns the top library id and title', () =>
    Effect.gen(function* () {
      const log: Array<Captured> = []
      const layer = Context7Live({
        fetch: sequencedFetch(
          [
            {
              status: 200,
              body: {
                results: [
                  {
                    id: '/vercel/next.js',
                    title: 'Next.js',
                    description: 'The React Framework',
                    trustScore: 9.5,
                  },
                  {
                    id: '/react/docs',
                    title: 'React',
                    description: 'A library',
                    trustScore: 9.4,
                  },
                ],
              },
            },
          ],
          log,
        ),
      })

      const program = Effect.gen(function* () {
        const c7 = yield* Context7
        return yield* c7.searchLibrary('next.js')
      })

      const res = yield* program.pipe(Effect.provide(layer))
      expect(res.libraryId).toBe('/vercel/next.js')
      expect(res.title).toBe('Next.js')

      expect(log).toHaveLength(1)
      expect(log[0]!.url).toContain(CONTEXT7_BASE_URL)
      expect(log[0]!.url).toContain('/search?query=next.js')
    }),
  )

  it.effect('returns Context7NotFound when search yields zero results', () =>
    Effect.gen(function* () {
      const log: Array<Captured> = []
      const layer = Context7Live({
        fetch: sequencedFetch([{ status: 200, body: { results: [] } }], log),
      })
      const program = Effect.gen(function* () {
        const c7 = yield* Context7
        return yield* c7.searchLibrary('totally-fake-lib')
      })
      const exit = yield* Effect.exit(program.pipe(Effect.provide(layer)))
      if (exit._tag !== 'Failure') throw new Error('expected failure')
    }),
  )
})

describe('Context7Live.fetchContext', () => {
  it.effect('GETs /api/v1/<libraryId>?topic=<query> and flattens snippets', () =>
    Effect.gen(function* () {
      const log: Array<Captured> = []
      const layer = Context7Live({
        fetch: sequencedFetch(
          [
            {
              status: 200,
              body: {
                infoSnippets: [
                  { title: 'Routing', content: 'Use App Router for ...' },
                ],
                codeSnippets: [
                  {
                    codeTitle: 'Route handler',
                    codeList: [
                      { code: 'export async function GET() {}' },
                      { code: 'export async function POST() {}' },
                    ],
                  },
                ],
              },
            },
          ],
          log,
        ),
      })

      const program = Effect.gen(function* () {
        const c7 = yield* Context7
        return yield* c7.fetchContext('/vercel/next.js', 'route handlers')
      })

      const snippets = yield* program.pipe(Effect.provide(layer))
      // info snippets first, then flattened code snippets — order matters for the agent.
      expect(snippets.map((s) => s.content)).toEqual([
        'Use App Router for ...',
        'export async function GET() {}',
        'export async function POST() {}',
      ])

      expect(log).toHaveLength(1)
      expect(log[0]!.url).toContain('/vercel/next.js')
      expect(log[0]!.url).toContain('topic=route%20handlers')
      expect(log[0]!.url).toContain('type=json')
    }),
  )
})
