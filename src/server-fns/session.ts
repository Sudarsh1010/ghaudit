/**
 * Server-function bindings for the two RPC-shaped session endpoints.
 *
 *   - `createSessionFn`  ←  POST /session
 *   - `submitAnswerFn`   ←  POST /session/:id/answer/:qid
 *
 * The other two endpoints (`/stream`, `/prd`) stay as raw HTTP in
 * `src/server.ts` because they're not RPC-shaped — one is `text/event-stream`
 * with `EventSource`-style framing, the other is a file download with
 * `Content-Disposition`. Server functions return data, not those.
 *
 * Why this file exists at all:
 *   - typed end-to-end calls from the browser (no `fetch` + cast on the
 *     client, no regex routing on the worker)
 *   - input is validated through the same Effect Schemas the rest of the
 *     app uses; the boundary cannot drift from the inside
 *   - errors surface as thrown `Error`s on the client, with `_tag` /
 *     `status` attached so callers can pattern-match
 *
 * Effect runtime is established per call: `MainLive` is built from the
 * Cloudflare env, the program runs, the result is rendered. Worker
 * env access goes through `cloudflare:workers`'s `env` import — the
 * server-function context doesn't expose env directly.
 */
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
// eslint-disable-next-line import/no-unresolved
import { env } from 'cloudflare:workers'
import { Cause, Effect, Layer, Schema } from 'effect'
import { type AppError, statusForError } from '~/shared/domain/errors'
import { createSession } from '~/shared/research/session'
import {
  EventStreamUrlBuilderLive,
  MainLive,
} from '~/shared/runtime/main'

/* ------------------------------------------------------------------ *
 * Input schemas
 * ------------------------------------------------------------------ */

const CreateSessionInput = Schema.Struct({
  initialPrompt: Schema.String.pipe(Schema.minLength(1)),
})

const SubmitAnswerInput = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  questionId: Schema.String.pipe(Schema.minLength(1)),
  kind: Schema.Literal('accept', 'reject', 'custom'),
  value: Schema.optional(Schema.String),
})

/* ------------------------------------------------------------------ *
 * Error rendering — AppError → throwable Error with `tag` + `status`
 * stamped on so the client can branch on them.
 * ------------------------------------------------------------------ */

interface ServerFnError extends Error {
  readonly tag: string
  readonly status: number
}

const renderError = (err: AppError): ServerFnError => {
  const detail = 'reason' in err ? err.reason : ''
  const message = detail ? `${err._tag}: ${detail}` : err._tag
  const e = new Error(message) as ServerFnError
  Object.assign(e, { tag: err._tag, status: statusForError(err) })
  return e
}

const renderCause = (cause: Cause.Cause<unknown>): ServerFnError => {
  const e = new Error(`internal error: ${Cause.pretty(cause)}`) as ServerFnError
  Object.assign(e, { tag: 'InternalError', status: 500 })
  return e
}

/* ------------------------------------------------------------------ *
 * createSessionFn
 *
 * Mints a Research Session, returns the SSE URL the client should
 * subscribe to. The SSE URL is rendered relative to the inbound
 * request's origin so the same code works in dev and prod.
 * ------------------------------------------------------------------ */

export const createSessionFn = createServerFn({ method: 'POST' })
  .inputValidator(Schema.decodeUnknownSync(CreateSessionInput))
  .handler(async ({ data }) => {
    const url = new URL(getRequest().url)
    const layer = Layer.merge(
      MainLive({ D1: env.D1, groq: { apiKey: env.GROQ_API_KEY } }),
      EventStreamUrlBuilderLive(
        (id) => `${url.origin}/session/${id}/stream`,
      ),
    )
    return Effect.runPromise(
      createSession(data).pipe(
        Effect.provide(layer),
        Effect.catchAll((err: AppError) => Effect.fail(renderError(err))),
        Effect.catchAllCause((cause) => Effect.fail(renderCause(cause))),
      ),
    )
  })

/* ------------------------------------------------------------------ *
 * submitAnswerFn
 *
 * Proxies the answer to the per-session Durable Object, parses its
 * JSON response, surfaces failures as thrown errors. The DO owns the
 * state machine — this fn is a thin shim that exists so the regex
 * route in `server.ts` can go away and the client gets typed
 * arguments + return.
 * ------------------------------------------------------------------ */

interface AnswerSuccessBody {
  readonly ok: true
  readonly state: string
}

interface AnswerErrorBody {
  readonly error: string
  readonly detail?: string
}

const isAnswerError = (
  body: unknown,
): body is AnswerErrorBody =>
  typeof body === 'object' &&
  body !== null &&
  'error' in body &&
  typeof (body as { error: unknown }).error === 'string'

/**
 * Cast the typed `DurableObjectNamespace<ResearchDO>` to a minimal shape
 * to keep TS from chasing the DO's full method surface — the same trick
 * the worker entry uses. We only need `idFromName` + `fetch` here.
 */
interface ResearchDONamespace {
  readonly idFromName: (name: string) => unknown
  readonly get: (id: unknown) => { fetch: typeof fetch }
}

export const submitAnswerFn = createServerFn({ method: 'POST' })
  .inputValidator(Schema.decodeUnknownSync(SubmitAnswerInput))
  .handler(async ({ data }): Promise<AnswerSuccessBody> => {
    const ns = env.RESEARCH_DO as unknown as ResearchDONamespace
    const stub = ns.get(ns.idFromName(data.sessionId))
    const res = await stub.fetch('https://do/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questionId: data.questionId,
        kind: data.kind,
        value: data.value,
      }),
    })
    const body = (await res.json().catch(() => null)) as unknown
    if (!res.ok || isAnswerError(body)) {
      const message = isAnswerError(body)
        ? `${body.error}${body.detail ? `: ${body.detail}` : ''}`
        : `request failed: ${res.status}`
      const e = new Error(message) as ServerFnError
      Object.assign(e, {
        tag: isAnswerError(body) ? body.error : 'UnknownError',
        status: res.status,
      })
      throw e
    }
    return body as AnswerSuccessBody
  })
