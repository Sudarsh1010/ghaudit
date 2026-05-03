/**
 * Single point of translation between tagged `AppError`s and HTTP shapes.
 *
 * Two shapes, because the codebase has two boundaries that surface
 * errors:
 *
 *   - `renderError`     — TanStack server-fn boundary. Server fns can
 *                         only signal failure by `throw`-ing, so we
 *                         convert to an `Error` with `tag` / `status` /
 *                         `retryAfterSeconds` stamped on.
 *
 *   - `toErrorResponse` — raw worker-entry boundary (`server.ts` and the
 *                         `do/research.ts` HTTP routes). Returns a real
 *                         `Response` with status, JSON body, and
 *                         `Retry-After` when the error carries one.
 *
 * Centralising these here means: one place to add a new error tag, one
 * place to add a new HTTP semantics rule (e.g. `Retry-After`).
 */
import { type AppError, statusForError } from './errors'

export interface ServerFnError extends Error {
  readonly tag: string
  readonly status: number
  readonly retryAfterSeconds?: number
}

export const renderError = (err: AppError): ServerFnError => {
  const detail = 'reason' in err ? err.reason : ''
  const message = detail ? `${err._tag}: ${detail}` : err._tag
  const e = new Error(message) as Error & {
    tag: string
    status: number
    retryAfterSeconds?: number
  }
  e.tag = err._tag
  e.status = statusForError(err)
  if (err._tag === 'RequestRateLimited') {
    e.retryAfterSeconds = err.retryAfterSeconds
  }
  return e
}

export const toErrorResponse = (err: AppError): Response => {
  const headers: Record<string, string> = {}
  if (err._tag === 'RequestRateLimited') {
    headers['Retry-After'] = String(err.retryAfterSeconds)
  }
  return Response.json(
    {
      error: err._tag,
      detail: 'reason' in err ? err.reason : undefined,
    },
    { status: statusForError(err), headers },
  )
}
