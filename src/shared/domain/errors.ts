/**
 * Tagged error taxonomy for the whole app.
 *
 * Every Effect that can fail does so with one of these tagged errors. The
 * HTTP boundary (`server.ts` / `do/research.ts`) maps tags to status codes;
 * tests assert on tags via `Effect.exit` and `Cause.failureOption`.
 *
 * Rules of thumb:
 *   - Errors below the seam (Repository, Groq) carry domain-specific tags.
 *   - Errors at a seam wrap upstream errors as `cause` rather than smearing.
 *   - LoopError is a union — the Agent Loop fails with exactly one of its
 *     members, never `unknown` or `Error`.
 */
import { Data } from 'effect'
import type { ParseResult } from 'effect'

/* ------------------------------------------------------------------ *
 * Repository
 * ------------------------------------------------------------------ */

export class RepositoryNotFound extends Data.TaggedError(
  'RepositoryNotFound',
)<{
  readonly entity: string
  readonly id: string
}> {}

export class RepositoryUniqueViolation extends Data.TaggedError(
  'RepositoryUniqueViolation',
)<{
  readonly entity: string
  readonly key: string
}> {}

export class RepositoryRowDecodeError extends Data.TaggedError(
  'RepositoryRowDecodeError',
)<{
  readonly entity: string
  readonly cause: ParseResult.ParseError
}> {}

export class RepositoryUnknownError extends Data.TaggedError(
  'RepositoryUnknownError',
)<{
  readonly cause: unknown
}> {}

export type RepositoryError =
  | RepositoryNotFound
  | RepositoryUniqueViolation
  | RepositoryRowDecodeError
  | RepositoryUnknownError

/* ------------------------------------------------------------------ *
 * Groq
 * ------------------------------------------------------------------ */

export class GroqAuthError extends Data.TaggedError('GroqAuthError')<{
  readonly reason: string
}> {}

export class GroqNetworkError extends Data.TaggedError('GroqNetworkError')<{
  readonly cause: unknown
}> {}

export class GroqRateLimitError extends Data.TaggedError(
  'GroqRateLimitError',
)<{
  readonly retryAfterSeconds?: number
}> {}

export class GroqApiError extends Data.TaggedError('GroqApiError')<{
  readonly status: number
  readonly body: string
}> {}

export class GroqParseError extends Data.TaggedError('GroqParseError')<{
  readonly cause: ParseResult.ParseError | unknown
}> {}

export class GroqEmptyCompletionError extends Data.TaggedError(
  'GroqEmptyCompletionError',
)<{}> {}

export type GroqError =
  | GroqAuthError
  | GroqNetworkError
  | GroqRateLimitError
  | GroqApiError
  | GroqParseError
  | GroqEmptyCompletionError

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

export class ToolInputJsonError extends Data.TaggedError(
  'ToolInputJsonError',
)<{
  readonly toolName: string
  readonly raw: string
  readonly cause: unknown
}> {}

export class ToolInputParseError extends Data.TaggedError(
  'ToolInputParseError',
)<{
  readonly toolName: string
  readonly raw: unknown
  readonly cause: ParseResult.ParseError
}> {}

export class ToolExecutionError extends Data.TaggedError(
  'ToolExecutionError',
)<{
  readonly toolName: string
  readonly cause: unknown
}> {}

export class ToolUnknownError extends Data.TaggedError('ToolUnknownError')<{
  readonly toolName: string
}> {}

export type ToolError =
  | ToolInputJsonError
  | ToolInputParseError
  | ToolExecutionError
  | ToolUnknownError

/* ------------------------------------------------------------------ *
 * Session state machine
 * ------------------------------------------------------------------ */

export class StateTransitionError extends Data.TaggedError(
  'StateTransitionError',
)<{
  readonly from: string
  readonly event: string
}> {}

/* ------------------------------------------------------------------ *
 * HTTP boundary (worker + DO)
 * ------------------------------------------------------------------ */

export class JsonSyntaxError extends Data.TaggedError('JsonSyntaxError')<{
  readonly cause: unknown
}> {}

export class SchemaViolation extends Data.TaggedError('SchemaViolation')<{
  readonly cause: ParseResult.ParseError
}> {}

export class NotFound extends Data.TaggedError('NotFound')<{
  readonly resource: string
}> {}

export class Conflict extends Data.TaggedError('Conflict')<{
  readonly reason: string
}> {}

/**
 * Cookie owner mismatch on a session-scoped route. Used by Slice 6's
 * `assertSessionAccess` — the route both proves the request lacks a
 * valid cookie *and* refuses to disclose whether the session exists,
 * so this tag also covers "no such session" (privacy: don't leak
 * existence of session ids).
 */
export class Forbidden extends Data.TaggedError('Forbidden')<{
  readonly reason: string
}> {}

export type RequestParseError = JsonSyntaxError | SchemaViolation

/* ------------------------------------------------------------------ *
 * Agent Loop — union of everything the loop can fail with.
 * ------------------------------------------------------------------ */

export type LoopError = GroqError | ToolError | RepositoryError

/* ------------------------------------------------------------------ *
 * HTTP status mapping
 *
 * Single source of truth. Anywhere we render a tagged error to a
 * Response, route through `statusForError`.
 * ------------------------------------------------------------------ */

export type AppError =
  | RepositoryError
  | GroqError
  | ToolError
  | StateTransitionError
  | RequestParseError
  | NotFound
  | Conflict
  | Forbidden

export const statusForError = (e: AppError): number => {
  switch (e._tag) {
    case 'RepositoryNotFound':
    case 'NotFound':
      return 404
    case 'Forbidden':
      return 403
    case 'RepositoryUniqueViolation':
    case 'StateTransitionError':
    case 'Conflict':
      return 409
    case 'JsonSyntaxError':
    case 'SchemaViolation':
    case 'ToolInputJsonError':
    case 'ToolInputParseError':
    case 'ToolUnknownError':
      return 400
    case 'GroqAuthError':
      return 502
    case 'GroqRateLimitError':
      return 429
    case 'GroqNetworkError':
    case 'GroqApiError':
    case 'GroqParseError':
    case 'GroqEmptyCompletionError':
      return 502
    case 'ToolExecutionError':
    case 'RepositoryRowDecodeError':
    case 'RepositoryUnknownError':
      return 500
  }
}
