// DO NOT DELETE THIS FILE!!!
/**
 * Worker entry — handles the two endpoints that aren't RPC-shaped, and
 * falls back to TanStack Start for everything else (UI routes + the two
 * RPC server functions in `src/server-fns/session.ts`).
 *
 *   GET  /session/:id/stream  — proxy to ResearchDO `/stream` (SSE)
 *   GET  /session/:id/prd     — proxy to ResearchDO `/prd`    (Markdown download)
 *
 * Both keep their raw HTTP shape because they aren't shaped like RPC:
 *   - `/stream` returns `text/event-stream` with `EventSource`-friendly
 *     framing (named events, `id:` per frame for resume).
 *   - `/prd` returns `Content-Disposition: attachment` so the browser's
 *     download dialog fires.
 *
 * The two RPC endpoints (`POST /session`, `POST /session/:id/answer/:qid`)
 * live as TanStack Start server functions; the router handler at the
 * bottom dispatches them.
 *
 * Effect runtime is established at the request boundary (every endpoint
 * function is an `Effect<Response, AppError, R>`), runs once per
 * request, then renders to a `Response` via `Effect.runPromise`.
 */
import handler from '@tanstack/react-start/server-entry'
import { Cause, Effect } from 'effect'
import {
  type AppError,
  NotFound,
  statusForError,
} from '~/shared/domain/errors'
import { ResearchRepository } from '~/shared/infra/drizzle/repository'
import { MainLive } from '~/shared/runtime/main'

console.log("[server-entry]: using custom server entry in 'src/server.ts'")

export { ResearchDO } from '~/do/research'

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

const STREAM_PATH = /^\/session\/([^/]+)\/stream$/
const PRD_PATH = /^\/session\/([^/]+)\/prd$/

const handleStream = (
  sessionId: string,
  env: Env,
): Effect.Effect<Response, AppError, ResearchRepository> =>
  Effect.gen(function* () {
    const repo = yield* ResearchRepository
    const session = yield* repo.getSessionById(sessionId).pipe(
      Effect.catchTag('RepositoryNotFound', () =>
        Effect.fail(new NotFound({ resource: `session ${sessionId}` })),
      ),
    )
    return yield* Effect.promise(() =>
      doStub(env, sessionId).fetch('https://do/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: session.initialPrompt }),
      }),
    )
  })

const handlePrd = (
  sessionId: string,
  env: Env,
): Effect.Effect<Response> =>
  Effect.promise(() =>
    doStub(env, sessionId).fetch('https://do/prd', { method: 'GET' }),
  )

/* ------------------------------------------------------------------ *
 * DO stub helper
 * ------------------------------------------------------------------ */

interface ResearchDONamespace {
  readonly idFromName: (name: string) => unknown
  readonly get: (id: unknown) => { fetch: typeof fetch }
}

const doStub = (
  env: Env,
  sessionId: string,
): { fetch: typeof fetch } => {
  const ns = env.RESEARCH_DO as unknown as ResearchDONamespace
  return ns.get(ns.idFromName(sessionId))
}

/* ------------------------------------------------------------------ *
 * Layer composition (per-request)
 *
 * Both remaining handlers only need `ResearchRepository`; the rest of
 * `MainLive` (Ids, Groq) is over-provided. We keep the full live layer
 * so the worker entry stays a one-liner consumer of `MainLive` and the
 * shape mirrors what the DO does.
 * ------------------------------------------------------------------ */

const runRequest = (
  env: Env,
  program: Effect.Effect<Response, AppError, ResearchRepository>,
): Promise<Response> => {
  const e = env as unknown as { D1: D1Database; GROQ_API_KEY?: string }
  return Effect.runPromise(
    program.pipe(
      Effect.catchAll((err: AppError) => Effect.succeed(toErrorResponse(err))),
      Effect.provide(MainLive({ D1: e.D1, groq: { apiKey: e.GROQ_API_KEY } })),
      Effect.catchAllCause((cause) =>
        Effect.succeed(
          new Response(`internal error: ${Cause.pretty(cause)}`, {
            status: 500,
          }),
        ),
      ),
    ),
  )
}

const toErrorResponse = (err: AppError): Response =>
  Response.json(
    {
      error: err._tag,
      detail: 'reason' in err ? err.reason : undefined,
    },
    { status: statusForError(err) },
  )

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    const streamMatch = url.pathname.match(STREAM_PATH)
    if (streamMatch && request.method === 'GET') {
      return runRequest(env, handleStream(streamMatch[1]!, env))
    }

    const prdMatch = url.pathname.match(PRD_PATH)
    if (prdMatch && request.method === 'GET') {
      return runRequest(env, handlePrd(prdMatch[1]!, env))
    }

    return handler.fetch(request, {
      context: {
        // @ts-expect-error tanstack context shape
        fromFetch: true,
      },
    })
  },
}
