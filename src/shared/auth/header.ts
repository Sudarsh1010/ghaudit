/**
 * `session_owner` cookie header (de)serialisation.
 *
 *   - `buildSessionOwnerCookie` renders a `Set-Cookie` value: HttpOnly,
 *     Secure, SameSite=Lax, scoped to `/session/<id>` so the browser
 *     only ships it back when the user is on that session's pages
 *     (preventing accidental leak to other sessions or unrelated
 *     routes).
 *   - `readSessionOwnerCookie` extracts the `session_owner` value from
 *     a raw `Cookie` request header. Returns `Option.none()` if the
 *     header is absent or doesn't contain `session_owner`.
 *
 * Both functions are pure and side-effect-free so they can be tested
 * directly without touching a Request / Response.
 */
import { Option } from 'effect'

export const SESSION_OWNER_COOKIE = 'session_owner'

export interface BuildSessionOwnerCookieInput {
  readonly sessionId: string
  readonly signedValue: string
}

export const buildSessionOwnerCookie = ({
  sessionId,
  signedValue,
}: BuildSessionOwnerCookieInput): string => {
  const attrs = [
    `${SESSION_OWNER_COOKIE}=${signedValue}`,
    `Path=/session/${sessionId}`,
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
  ]
  return attrs.join('; ')
}

export const readSessionOwnerCookie = (
  cookieHeader: string | null | undefined,
): Option.Option<string> => {
  if (!cookieHeader) return Option.none()
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const name = trimmed.slice(0, eq)
    if (name === SESSION_OWNER_COOKIE) {
      const value = trimmed.slice(eq + 1)
      return value.length > 0 ? Option.some(value) : Option.none()
    }
  }
  return Option.none()
}
