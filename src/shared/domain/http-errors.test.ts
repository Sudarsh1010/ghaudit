/**
 * Boundary tests for the HTTP error renderers. The renderers translate
 * tagged `AppError`s into:
 *
 *   - `renderError`     → a `Error` for `throw` from a TanStack server fn
 *                         (status code stamped on so the client can branch)
 *   - `toErrorResponse` → a `Response` for the raw worker entry
 *                         (status + headers, JSON body)
 *
 * These exist as a shared module rather than duplicated in
 * `server.ts` / `server-fns/session.ts` so error semantics live in one
 * place — adding a new error tag means updating one file.
 */
import { describe, it, expect } from '@effect/vitest'
import { Conflict, RequestRateLimited } from './errors'
import { renderError, toErrorResponse } from './http-errors'

describe('renderError (server-fn boundary)', () => {
  it('stamps tag and status from the error', () => {
    const e = renderError(new Conflict({ reason: 'already done' }))
    expect(e.tag).toBe('Conflict')
    expect(e.status).toBe(409)
  })

  it('attaches retryAfterSeconds for RequestRateLimited', () => {
    const e = renderError(
      new RequestRateLimited({
        scope: 'session-create',
        retryAfterSeconds: 60,
      }),
    )
    expect(e.tag).toBe('RequestRateLimited')
    expect(e.status).toBe(429)
    expect(e.retryAfterSeconds).toBe(60)
  })
})

describe('toErrorResponse (raw HTTP boundary)', () => {
  it('renders RequestRateLimited as 429 with a Retry-After header', async () => {
    const res = toErrorResponse(
      new RequestRateLimited({
        scope: 'session-create',
        retryAfterSeconds: 60,
      }),
    )
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('60')
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('RequestRateLimited')
  })

  it('does NOT attach Retry-After to non-rate-limit errors', () => {
    const res = toErrorResponse(new Conflict({ reason: 'already done' }))
    expect(res.status).toBe(409)
    expect(res.headers.get('Retry-After')).toBeNull()
  })
})
