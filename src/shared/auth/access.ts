/**
 * `assertSessionAccess` — the gate session-scoped routes call before
 * doing anything else. Loads the session row, verifies the inbound
 * `session_owner` cookie's signature with `OwnerCookie`, and compares
 * the decoded owner id against the row's `owner_id`.
 *
 * Folds four failure modes (no cookie, malformed/tampered cookie,
 * owner mismatch, session not found) into a single `Forbidden`. The
 * "session not found" case is intentional: returning 404 there would
 * let an unauthenticated probe enumerate which session ids exist on
 * the system, which leaks information about other users' activity.
 */
import { Effect, Option } from 'effect'
import { Forbidden, type RepositoryError } from '~/shared/domain/errors'
import {
  ResearchRepository,
} from '~/shared/infra/drizzle/repository'
import type { ResearchSessionRow } from '~/shared/infra/drizzle/schemas'
import { OwnerCookie } from './cookie'

export interface AssertSessionAccessInput {
  readonly sessionId: string
  /**
   * The raw value of the `session_owner` cookie, if present. The HTTP
   * boundary is responsible for parsing the `Cookie` request header
   * and pulling out this single value before calling here.
   */
  readonly signedCookie: Option.Option<string>
}

export const assertSessionAccess = (
  input: AssertSessionAccessInput,
): Effect.Effect<
  ResearchSessionRow,
  Forbidden | Exclude<RepositoryError, { _tag: 'RepositoryNotFound' }>,
  ResearchRepository | OwnerCookie
> =>
  Effect.gen(function* () {
    const cookie = yield* OwnerCookie
    const repo = yield* ResearchRepository

    if (Option.isNone(input.signedCookie)) {
      return yield* new Forbidden({ reason: 'missing session_owner cookie' })
    }

    const decoded = yield* cookie.verify(input.signedCookie.value)
    if (Option.isNone(decoded)) {
      return yield* new Forbidden({
        reason: 'invalid session_owner cookie signature',
      })
    }

    const session = yield* repo.getSessionById(input.sessionId).pipe(
      Effect.catchTag('RepositoryNotFound', () =>
        Effect.fail(
          new Forbidden({ reason: 'session not accessible' }),
        ),
      ),
    )

    if (session.ownerId !== decoded.value) {
      return yield* new Forbidden({ reason: 'session not accessible' })
    }

    return session
  })
