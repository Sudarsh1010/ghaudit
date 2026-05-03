/**
 * `OwnerCookie` — sign and verify the value carried by the
 * `session_owner` cookie. The cookie's value is `<ownerId>.<sigHex>`,
 * where the signature is HMAC-SHA-256 over the owner id under the
 * server's secret. Verification recomputes the HMAC with the same secret
 * and compares in constant time.
 *
 * The interface is two methods (`sign`, `verify`); the bytes are an
 * implementation detail. Tests must not assert on the signature value
 * itself — only on the round-trip and on rejection of tampered values.
 */
import { Context, Effect, Layer, Option } from 'effect'

export class OwnerCookie extends Context.Tag('OwnerCookie')<
  OwnerCookie,
  {
    readonly sign: (ownerId: string) => Effect.Effect<string>
    readonly verify: (
      signedValue: string,
    ) => Effect.Effect<Option.Option<string>>
  }
>() {}

const SEPARATOR = '.'

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

const importKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

const hmacHex = async (
  key: CryptoKey,
  payload: string,
): Promise<string> => {
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  )
  return toHex(new Uint8Array(sig))
}

/** Constant-time string compare on equal-length hex. */
const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export const OwnerCookieLive = (secret: string): Layer.Layer<OwnerCookie> =>
  Layer.scoped(
    OwnerCookie,
    Effect.gen(function* () {
      const key = yield* Effect.promise(() => importKey(secret))
      return OwnerCookie.of({
        sign: (ownerId) =>
          Effect.promise(async () => {
            const sig = await hmacHex(key, ownerId)
            return `${ownerId}${SEPARATOR}${sig}`
          }),
        verify: (signedValue) =>
          Effect.promise(async () => {
            const idx = signedValue.lastIndexOf(SEPARATOR)
            if (idx < 0) return Option.none<string>()
            const ownerId = signedValue.slice(0, idx)
            const sig = signedValue.slice(idx + 1)
            if (ownerId.length === 0 || sig.length === 0) {
              return Option.none<string>()
            }
            const expected = await hmacHex(key, ownerId)
            return constantTimeEqual(sig, expected)
              ? Option.some(ownerId)
              : Option.none<string>()
          }),
      })
    }),
  )
