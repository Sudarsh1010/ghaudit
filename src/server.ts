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
import { Cause, Effect, Layer } from 'effect'
import { assertSessionAccess } from '~/shared/auth/access'
import { OwnerCookie, OwnerCookieLive } from '~/shared/auth/cookie'
import { readSessionOwnerCookie } from '~/shared/auth/header'
import { type AppError } from '~/shared/domain/errors'
import { toErrorResponse } from '~/shared/domain/http-errors'
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
  request: Request,
  env: Env,
): Effect.Effect<Response, AppError, ResearchRepository | OwnerCookie> =>
  Effect.gen(function* () {
    // Slice 6: cookie ownership is checked at this seam (the DO has no
    // notion of cookies). `assertSessionAccess` returns the row so we
    // don't pay a second `getSessionById` round-trip below.
    const session = yield* assertSessionAccess({
      sessionId,
      signedCookie: readSessionOwnerCookie(request.headers.get('cookie')),
    })
    // Slice 5: the browser's EventSource sets `Last-Event-ID` automatically
    // on reconnect. Coerce non-numeric values to 0 so a missing or
    // malformed header behaves like "start from scratch".
    const headerValue = request.headers.get('last-event-id')
    const parsed = headerValue !== null ? Number(headerValue) : NaN
    const lastEventId = Number.isFinite(parsed) ? parsed : 0
    return yield* Effect.promise(() =>
      doStub(env, sessionId).fetch('https://do/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: session.initialPrompt,
          lastEventId,
        }),
      }),
    )
  })

const handlePrd = (
  sessionId: string,
  request: Request,
  env: Env,
): Effect.Effect<Response, AppError, ResearchRepository | OwnerCookie> =>
  Effect.gen(function* () {
    yield* assertSessionAccess({
      sessionId,
      signedCookie: readSessionOwnerCookie(request.headers.get('cookie')),
    })
    return yield* Effect.promise(() =>
      doStub(env, sessionId).fetch('https://do/prd', { method: 'GET' }),
    )
  })

/* ------------------------------------------------------------------ *
 * DO stub helper
 * ------------------------------------------------------------------ */

interface ResearchDONamespace {
  readonly idFromName: (name: string) => unknown
  readonly get: (id: unknown) => { fetch: typeof fetch }
}

const doStub = (env: Env, sessionId: string): { fetch: typeof fetch } => {
  const ns = env.RESEARCH_DO as unknown as ResearchDONamespace
  return ns.get(ns.idFromName(sessionId))
}

/* ------------------------------------------------------------------ *
 * Layer composition (per-request)
 *
 * `/stream` and `/prd` only need `ResearchRepository` + `OwnerCookie`;
 * `MainLive`'s other services (Ids, Groq, Brave, Context7, UrlFetcher,
 * RateLimiter) are over-provided. We keep the full live layer so the
 * worker entry stays a one-liner consumer of `MainLive` and the shape
 * mirrors what the DO does.
 *
 * Slice 13 rate-limit bindings (SESSION_RATELIMIT, ANSWER_RATELIMIT)
 * gate the two server-fn endpoints (`/session`, `/session/:id/answer`),
 * not the routes handled here — so we use `MainLive`'s `allowAlways`
 * fallback rather than threading the env bindings through.
 * ------------------------------------------------------------------ */

const runRequest = (
  env: Env,
  program: Effect.Effect<Response, AppError, ResearchRepository | OwnerCookie>,
): Promise<Response> => {
  const e = env as unknown as {
    D1: D1Database
    GROQ_API_KEY?: string
    SESSION_COOKIE_SECRET?: string
  }
  if (!e.SESSION_COOKIE_SECRET || e.SESSION_COOKIE_SECRET.length === 0) {
    // Fail closed: a missing secret would let cookie verification
    // succeed against an empty key, which is a worse failure mode than
    // a 500 at the session-scoped boundary.
    return Promise.resolve(
      new Response('SESSION_COOKIE_SECRET is not set', { status: 500 }),
    )
  }
  const layer = Layer.merge(
    MainLive({ D1: e.D1, groq: { apiKey: e.GROQ_API_KEY } }),
    OwnerCookieLive(e.SESSION_COOKIE_SECRET),
  )
  return Effect.runPromise(
    program.pipe(
      Effect.catchAll((err: AppError) => Effect.succeed(toErrorResponse(err))),
      Effect.provide(layer),
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

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    const streamMatch = url.pathname.match(STREAM_PATH)
    if (streamMatch && request.method === 'GET') {
      return runRequest(env, handleStream(streamMatch[1]!, request, env))
    }

    const prdMatch = url.pathname.match(PRD_PATH)
    if (prdMatch && request.method === 'GET') {
      return runRequest(env, handlePrd(prdMatch[1]!, request, env))
    }

    return handler.fetch(request, {
      context: {
        // @ts-expect-error tanstack context shape
        fromFetch: true,
      },
    })
  },
}
