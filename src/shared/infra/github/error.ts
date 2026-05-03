/**
 * Tagged error taxonomy for the GitHub seam.
 *
 * Mirrors the rules used elsewhere (`src/shared/domain/errors.ts`):
 * every adapter failure is one of a small union, and the union is what
 * callers branch on — never a string match against `.message`.
 */
import { Data } from 'effect'

export class GitHubAuthError extends Data.TaggedError('GitHubAuthError')<{
  readonly reason: string
}> {}

export class GitHubRateLimitError extends Data.TaggedError(
  'GitHubRateLimitError',
)<{
  readonly resetAt: Date
}> {}

export class GitHubInsufficientPermissionsError extends Data.TaggedError(
  'GitHubInsufficientPermissionsError',
)<{
  readonly missingScope: string
}> {}

export class GitHubApiError extends Data.TaggedError('GitHubApiError')<{
  readonly status: number
  readonly body: string
}> {}

export class GitHubNetworkError extends Data.TaggedError(
  'GitHubNetworkError',
)<{
  readonly cause: unknown
}> {}

export type GitHubError =
  | GitHubAuthError
  | GitHubRateLimitError
  | GitHubInsufficientPermissionsError
  | GitHubApiError
  | GitHubNetworkError
