/**
 * Cookie header (de)serialisation. Two pure functions:
 *
 *   - `buildSessionOwnerCookie` renders the `Set-Cookie` header value
 *     for the `session_owner` cookie (HttpOnly, signed value, scoped
 *     to the session URL so the browser only ships it back when the
 *     user is on that session's pages).
 *   - `readSessionOwnerCookie` pulls the `session_owner` cookie from
 *     a `Cookie` request header (or returns `Option.none()` if absent).
 *
 * Both are deterministic, no IO; tests are straight string assertions.
 */
import { describe, it, expect } from 'vitest'
import { Option } from 'effect'
import {
  buildSessionOwnerCookie,
  readSessionOwnerCookie,
} from './header'

describe('buildSessionOwnerCookie', () => {
  it('emits a HttpOnly, signed cookie scoped to the session id', () => {
    const header = buildSessionOwnerCookie({
      sessionId: 'rs_abc',
      signedValue: 'own_1.deadbeef',
    })
    expect(header).toContain('session_owner=own_1.deadbeef')
    expect(header).toContain('HttpOnly')
    expect(header).toContain('Path=/session/rs_abc')
    expect(header).toContain('SameSite=Lax')
    expect(header).toContain('Secure')
  })
})

describe('readSessionOwnerCookie', () => {
  it('returns the value when the cookie is present', () => {
    const got = readSessionOwnerCookie('session_owner=own_1.sig123')
    expect(Option.getOrNull(got)).toBe('own_1.sig123')
  })

  it('returns none when the header is missing', () => {
    expect(Option.isNone(readSessionOwnerCookie(undefined))).toBe(true)
    expect(Option.isNone(readSessionOwnerCookie(null))).toBe(true)
    expect(Option.isNone(readSessionOwnerCookie(''))).toBe(true)
  })

  it('returns none when session_owner is not present among other cookies', () => {
    const got = readSessionOwnerCookie('foo=bar; baz=qux')
    expect(Option.isNone(got)).toBe(true)
  })

  it('finds session_owner when mixed with other cookies', () => {
    const got = readSessionOwnerCookie(
      'foo=bar; session_owner=own_2.sig999; baz=qux',
    )
    expect(Option.getOrNull(got)).toBe('own_2.sig999')
  })
})
