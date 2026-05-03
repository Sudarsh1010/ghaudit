/**
 * `Context7` — Effect service for the Context7 public v1 API.
 *
 * No API key required for the public endpoint. Two operations:
 *
 *   - `searchLibrary(name)`         → top match `{ libraryId, title }`
 *   - `fetchContext(libraryId, q)`  → snippet excerpts for that library
 *
 * The `searchLibraryDocs` tool chains both. Failures are typed via
 * `Context7Error`. A search that returns zero results is `Context7NotFound`
 * — the tool should surface this to the LLM so it can ask for a different
 * library name rather than silently producing empty context.
 */
import { Context, Effect, Layer, Ref } from 'effect'
import {
  type Context7Error,
  Context7ApiError,
  Context7NetworkError,
  Context7NotFound,
} from '~/shared/domain/errors'

export const CONTEXT7_BASE_URL = 'https://context7.com/api/v1'

export interface Context7Library {
  readonly libraryId: string
  readonly title: string
}

export interface Context7Snippet {
  readonly title: string
  readonly content: string
}

export class Context7 extends Context.Tag('Context7')<
  Context7,
  {
    readonly searchLibrary: (
      name: string,
    ) => Effect.Effect<Context7Library, Context7Error>
    readonly fetchContext: (
      libraryId: string,
      query: string,
    ) => Effect.Effect<ReadonlyArray<Context7Snippet>, Context7Error>
  }
>() {}

export interface Context7LiveOptions {
  readonly baseURL?: string
  readonly fetch?: typeof fetch
}

interface SearchRaw {
  readonly results?: ReadonlyArray<{
    readonly id?: string
    readonly title?: string
  }>
}

interface ContextRaw {
  readonly codeSnippets?: ReadonlyArray<{
    readonly codeTitle?: string
    readonly codeList?: ReadonlyArray<{ readonly code?: string }>
  }>
  readonly infoSnippets?: ReadonlyArray<{
    readonly content?: string
    readonly title?: string
  }>
}

const requestJson = (
  fetchImpl: typeof fetch,
  url: string,
): Effect.Effect<unknown, Context7Error> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
        }),
      catch: (cause): Context7Error => new Context7NetworkError({ cause }),
    })

    if (!res.ok) {
      const body = yield* Effect.tryPromise({
        try: () => res.text(),
        catch: () => new Context7ApiError({ status: res.status, body: '' }),
      }).pipe(Effect.orElseSucceed(() => ''))
      return yield* new Context7ApiError({ status: res.status, body })
    }

    return yield* Effect.tryPromise({
      try: () => res.json() as Promise<unknown>,
      catch: (cause): Context7Error => new Context7NetworkError({ cause }),
    })
  })

export const Context7Live = (
  options: Context7LiveOptions = {},
): Layer.Layer<Context7> =>
  Layer.succeed(Context7, {
    searchLibrary: (name) =>
      Effect.gen(function* () {
        const baseURL = options.baseURL ?? CONTEXT7_BASE_URL
        const fetchImpl = options.fetch ?? fetch
        const url = `${baseURL}/search?query=${encodeURIComponent(name)}`
        const raw = (yield* requestJson(fetchImpl, url)) as SearchRaw
        const top = raw.results?.[0]
        if (!top || !top.id) {
          return yield* new Context7NotFound({ query: name })
        }
        return { libraryId: top.id, title: top.title ?? top.id }
      }),
    fetchContext: (libraryId, query) =>
      Effect.gen(function* () {
        const baseURL = options.baseURL ?? CONTEXT7_BASE_URL
        const fetchImpl = options.fetch ?? fetch
        const url = `${baseURL}${libraryId}?topic=${encodeURIComponent(query)}&type=json`
        const raw = (yield* requestJson(fetchImpl, url)) as ContextRaw

        const code = (raw.codeSnippets ?? []).flatMap((cs) =>
          (cs.codeList ?? []).map((c) => ({
            title: cs.codeTitle ?? '',
            content: c.code ?? '',
          })),
        )
        const info = (raw.infoSnippets ?? []).map((s) => ({
          title: s.title ?? '',
          content: s.content ?? '',
        }))

        return [...info, ...code]
      }),
  })

/**
 * Test adapter — canned `searchLibrary` and `fetchContext` results.
 */
export const Context7Stub = {
  layer: (canned: {
    readonly libraries?: ReadonlyArray<Context7Library>
    readonly contexts?: ReadonlyArray<ReadonlyArray<Context7Snippet>>
  }): Layer.Layer<Context7> =>
    Layer.scoped(
      Context7,
      Effect.gen(function* () {
        const libIdx = yield* Ref.make(0)
        const ctxIdx = yield* Ref.make(0)
        const libs = canned.libraries ?? []
        const ctxs = canned.contexts ?? []
        return Context7.of({
          searchLibrary: (name) =>
            Effect.gen(function* () {
              const i = yield* Ref.modify(libIdx, (n) => [n, n + 1])
              const lib = libs[i]
              if (!lib) {
                return yield* new Context7NotFound({ query: name })
              }
              return lib
            }),
          fetchContext: () =>
            Effect.gen(function* () {
              const i = yield* Ref.modify(ctxIdx, (n) => [n, n + 1])
              return ctxs[i] ?? []
            }),
        })
      }),
    ),
}
