/**
 * Status-mapping tests for `statusForError`. The status table is the
 * single source of truth at every HTTP boundary, so each tag's mapping
 * is exercised explicitly.
 */
import { describe, it, expect } from '@effect/vitest'
import { RequestRateLimited, statusForError } from './errors'

describe('statusForError', () => {
  it('maps RequestRateLimited to 429', () => {
    const e = new RequestRateLimited({
      scope: 'session-create',
      retryAfterSeconds: 60,
    })
    expect(statusForError(e)).toBe(429)
  })
})
