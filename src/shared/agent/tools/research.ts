/**
 * Research tools — the three external-research wrappers the Agent Loop
 * uses to ground its recommendations.
 *
 *   - `webSearch(query, count?)`         — Brave Search
 *   - `searchLibraryDocs(library, query)` — Context7 public API
 *   - `readUrl(url)`                      — generic URL → readable text
 *
 * Each is a thin wrapper over an `infra/*` seam service. The Schemas are
 * what the LLM sees as the tool's JSON Schema; the `execute` body delegates
 * the entire HTTP / parsing concern to the seam, and emits `Continue(...)`
 * so the Loop streams a `tool_result` event back to the user.
 */
import { Effect, Schema } from 'effect'
import { BraveSearch } from '~/shared/infra/brave/client'
import { Context7 } from '~/shared/infra/context7/client'
import { UrlFetcher } from '~/shared/infra/url-fetcher/client'
import { Continue, defineTool } from '~/shared/infra/ai/tool'

/* ------------------------------------------------------------------ *
 * webSearch
 * ------------------------------------------------------------------ */

const WebSearchInput = Schema.Struct({
  query: Schema.String,
  count: Schema.optional(Schema.Number),
})

export const webSearchTool = defineTool({
  name: 'webSearch',
  description:
    'Search the public web via Brave. Use this to find sources, recent news, or general background before recommending an answer. Returns up to N results, each with title, url, and snippet.',
  inputSchema: WebSearchInput,
  execute: (input) =>
    Effect.gen(function* () {
      const brave = yield* BraveSearch
      const res = yield* brave.search({
        query: input.query,
        count: input.count,
      })
      return Continue({ results: res.results })
    }),
})

/* ------------------------------------------------------------------ *
 * searchLibraryDocs
 * ------------------------------------------------------------------ */

const SearchLibraryDocsInput = Schema.Struct({
  library: Schema.String,
  query: Schema.String,
})

export const searchLibraryDocsTool = defineTool({
  name: 'searchLibraryDocs',
  description:
    "Find current documentation excerpts for a named library (e.g. 'next.js', 'react', 'effect') filtered by a topic query. Returns top excerpts as snippets.",
  inputSchema: SearchLibraryDocsInput,
  execute: (input) =>
    Effect.gen(function* () {
      const c7 = yield* Context7
      const lib = yield* c7.searchLibrary(input.library)
      const snippets = yield* c7.fetchContext(lib.libraryId, input.query)
      return Continue({
        library: input.library,
        libraryId: lib.libraryId,
        title: lib.title,
        snippets,
      })
    }),
})

/* ------------------------------------------------------------------ *
 * readUrl
 * ------------------------------------------------------------------ */

const ReadUrlInput = Schema.Struct({
  url: Schema.String,
})

export const readUrlTool = defineTool({
  name: 'readUrl',
  description:
    'Fetch a URL and return its readable text. Use this on a result from webSearch when you need more than the snippet to answer a user question.',
  inputSchema: ReadUrlInput,
  execute: (input) =>
    Effect.gen(function* () {
      const fetcher = yield* UrlFetcher
      const out = yield* fetcher.fetchReadable(input.url)
      return Continue({ url: out.url, content: out.content })
    }),
})

/* ------------------------------------------------------------------ *
 * Catalogue contents
 * ------------------------------------------------------------------ */

export const researchTools = [
  webSearchTool,
  searchLibraryDocsTool,
  readUrlTool,
] as const
