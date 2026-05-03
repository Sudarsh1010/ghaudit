// DO NOT DELETE THIS FILE!!!
/**
 * Worker entry — routes the four endpoints we care about, falls back to
 * TanStack Start for everything else.
 *
 *   POST /session                         create session, return SSE URL
 *   GET  /session/:id/stream              proxy to ResearchDO /stream
 *   POST /session/:id/answer/:questionId  proxy to ResearchDO /answer
 *   GET  /session/:id/prd                 proxy to ResearchDO /prd
 *
 * Effect runtime is established at the request boundary (every endpoint
 * function is an `Effect<Response, AppError, R>`), runs once per
 * request, then renders to a `Response` via `Effect.runPromise`.
 *
 * The DO endpoints are simply proxied — the DO owns its own runtime and
 * speaks plain HTTP back. Keeps the worker dumb and the DO authoritative.
 */
import handler from '@tanstack/react-start/server-entry'
import { Cause, Effect, Layer, ParseResult, Schema } from 'effect'
import {
  type AppError,
  NotFound,
  SchemaViolation,
  statusForError,
} from '~/shared/domain/errors'
import { Ids } from '~/shared/domain/ids'
import { ResearchRepository } from '~/shared/infra/drizzle/repository'
import { Groq } from '~/shared/infra/groq/client'
import { createSession, EventStreamUrlBuilder } from '~/shared/research/session'
import {
  EventStreamUrlBuilderLive,
  MainLive,
} from '~/shared/runtime/main'

console.log("[server-entry]: using custom server entry in 'src/server.ts'")

export { ResearchDO } from '~/do/research'

/* ------------------------------------------------------------------ *
 * Request schemas
 * ------------------------------------------------------------------ */

const CreateSessionRequest = Schema.Struct({
  initialPrompt: Schema.String.pipe(Schema.minLength(1)),
})
const decodeCreateSession = Schema.decodeUnknown(CreateSessionRequest)

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

const STREAM_PATH = /^\/session\/([^/]+)\/stream$/
const ANSWER_PATH = /^\/session\/([^/]+)\/answer\/([^/]+)$/
const PRD_PATH = /^\/session\/([^/]+)\/prd$/

const handleCreateSession = (
  request: Request,
): Effect.Effect<
  Response,
  AppError,
  ResearchRepository | Ids | EventStreamUrlBuilder
> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => request.json() as Promise<unknown>,
      catch: (cause) =>
        new SchemaViolation({ cause: cause as ParseResult.ParseError }),
    })
    const body = yield* decodeCreateSession(raw).pipe(
      Effect.mapError(
        (cause: ParseResult.ParseError) => new SchemaViolation({ cause }),
      ),
    )
    const result = yield* createSession(body)
    return Response.json(result)
  })

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

const handleAnswer = (
  sessionId: string,
  questionId: string,
  request: Request,
  env: Env,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => request.text())
    let merged: Record<string, unknown>
    try {
      merged = { ...(JSON.parse(text || '{}') as object), questionId }
    } catch {
      merged = { questionId }
    }
    return yield* Effect.promise(() =>
      doStub(env, sessionId).fetch('https://do/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(merged),
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
 * ------------------------------------------------------------------ */

const requestLayer = (request: Request, env: Env) => {
  const e = env as unknown as { D1: D1Database; GROQ_API_KEY?: string }
  const url = new URL(request.url)
  return Layer.merge(
    MainLive({ D1: e.D1, groq: { apiKey: e.GROQ_API_KEY } }),
    EventStreamUrlBuilderLive(
      (id) => `${url.origin}/session/${id}/stream`,
    ),
  )
}

type ProvidedServices =
  | Ids
  | Groq
  | ResearchRepository
  | EventStreamUrlBuilder

const runRequest = (
  request: Request,
  env: Env,
  program: Effect.Effect<Response, AppError, ProvidedServices>,
): Promise<Response> =>
  Effect.runPromise(
    program.pipe(
      Effect.catchAll((err: AppError) => Effect.succeed(toErrorResponse(err))),
      Effect.provide(requestLayer(request, env)),
      Effect.catchAllCause((cause) =>
        Effect.succeed(
          new Response(`internal error: ${Cause.pretty(cause)}`, {
            status: 500,
          }),
        ),
      ),
    ),
  )

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

    if (request.method === 'POST' && url.pathname === '/session') {
      return runRequest(request, env, handleCreateSession(request))
    }

    const streamMatch = url.pathname.match(STREAM_PATH)
    if (streamMatch && request.method === 'GET') {
      return runRequest(request, env, handleStream(streamMatch[1]!, env))
    }

    const answerMatch = url.pathname.match(ANSWER_PATH)
    if (answerMatch && request.method === 'POST') {
      return runRequest(
        request,
        env,
        handleAnswer(answerMatch[1]!, answerMatch[2]!, request, env),
      )
    }

    const prdMatch = url.pathname.match(PRD_PATH)
    if (prdMatch && request.method === 'GET') {
      return runRequest(request, env, handlePrd(prdMatch[1]!, env))
    }

    return handler.fetch(request, {
      context: {
        // @ts-expect-error tanstack context shape
        fromFetch: true,
      },
    })
  },
}
