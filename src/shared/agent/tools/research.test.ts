/**
 * Research tool dispatch tests.
 *
 * The three Research Tools (`webSearch`, `searchLibraryDocs`, `readUrl`) are
 * thin wrappers over the corresponding seam services. Tests dispatch through
 * the catalog (matching how the Loop does it in production) and provide
 * canned-response Stub layers for each external service.
 *
 * What we're asserting here:
 *   1. The catalog accepts the tool by name.
 *   2. The tool's Schema decoding accepts the LLM-shaped JSON args.
 *   3. The tool produces a `Continue(payload)` outcome with the expected
 *      structured shape — that's what gets streamed back as `tool_result`.
 */
import { describe, it, expect } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { BraveSearch, BraveStub } from '~/shared/infra/brave/client'
import { Context7, Context7Stub } from '~/shared/infra/context7/client'
import {
  UrlFetcher,
  UrlFetcherStub,
} from '~/shared/infra/url-fetcher/client'
import { makeCatalog } from './catalog'
import { researchTools } from './research'

/**
 * Bundles the canned-response layers for every research seam together,
 * so each dispatch test can provide them in one line. Tests that only
 * exercise one tool don't pay for the others — empty stubs are cheap.
 */
const stubs = (overrides?: {
  readonly brave?: Parameters<typeof BraveStub.layer>[0]
  readonly context7?: Parameters<typeof Context7Stub.layer>[0]
  readonly urlFetcher?: Parameters<typeof UrlFetcherStub.layer>[0]
}): Layer.Layer<BraveSearch | Context7 | UrlFetcher> =>
  Layer.mergeAll(
    BraveStub.layer(overrides?.brave ?? []),
    Context7Stub.layer(overrides?.context7 ?? {}),
    UrlFetcherStub.layer(overrides?.urlFetcher ?? []),
  )

describe('webSearch tool', () => {
  it.effect('dispatches through the catalog and returns Continue with results', () =>
    Effect.gen(function* () {
      const catalog = makeCatalog(researchTools)
      const outcome = yield* catalog.dispatch({
        name: 'webSearch',
        rawArguments: JSON.stringify({ query: 'effect typescript' }),
      })

      if (outcome._tag !== 'Continue') {
        throw new Error(`expected Continue, got ${outcome._tag}`)
      }
      expect(outcome.result).toEqual({
        results: [
          {
            title: 'Effect-TS docs',
            url: 'https://effect.website/',
            snippet: 'Robust TypeScript apps.',
          },
        ],
      })
    }).pipe(
      Effect.provide(
        stubs({
          brave: [
            {
              results: [
                {
                  title: 'Effect-TS docs',
                  url: 'https://effect.website/',
                  snippet: 'Robust TypeScript apps.',
                },
              ],
            },
          ],
        }),
      ),
    ),
  )
})

describe('searchLibraryDocs tool', () => {
  it.effect('chains library search + context fetch and returns Continue with snippets', () =>
    Effect.gen(function* () {
      const catalog = makeCatalog(researchTools)
      const outcome = yield* catalog.dispatch({
        name: 'searchLibraryDocs',
        rawArguments: JSON.stringify({
          library: 'next.js',
          query: 'route handlers',
        }),
      })

      if (outcome._tag !== 'Continue') {
        throw new Error(`expected Continue, got ${outcome._tag}`)
      }
      expect(outcome.result).toEqual({
        library: 'next.js',
        libraryId: '/vercel/next.js',
        title: 'Next.js',
        snippets: [
          { title: 'Routing', content: 'App Router intro.' },
          { title: 'Handler', content: 'export async function GET() {}' },
        ],
      })
    }).pipe(
      Effect.provide(
        stubs({
          context7: {
            libraries: [{ libraryId: '/vercel/next.js', title: 'Next.js' }],
            contexts: [
              [
                { title: 'Routing', content: 'App Router intro.' },
                { title: 'Handler', content: 'export async function GET() {}' },
              ],
            ],
          },
        }),
      ),
    ),
  )
})

describe('readUrl tool', () => {
  it.effect('dispatches through the catalog and returns Continue with extracted content', () =>
    Effect.gen(function* () {
      const catalog = makeCatalog(researchTools)
      const outcome = yield* catalog.dispatch({
        name: 'readUrl',
        rawArguments: JSON.stringify({ url: 'https://example.com/article' }),
      })

      if (outcome._tag !== 'Continue') {
        throw new Error(`expected Continue, got ${outcome._tag}`)
      }
      expect(outcome.result).toEqual({
        url: 'https://example.com/article',
        content: 'The article body.',
      })
    }).pipe(
      Effect.provide(
        stubs({
          urlFetcher: [
            {
              url: 'https://example.com/article',
              content: 'The article body.',
            },
          ],
        }),
      ),
    ),
  )
})
