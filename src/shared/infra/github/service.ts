/**
 * `GitHubService` — Effect service for GitHub REST calls.
 *
 * The token is *dynamic* — every audit is initiated against a different
 * installation/PAT, so there's no single global Layer. Callers build a
 * fresh layer with `GitHubServiceLive({ token })` inside the request-
 * scoped runtime.
 *
 * The seam is intentionally narrow (a couple of read endpoints today);
 * adding endpoints means adding methods to the Tag's service shape and
 * to the Live implementation, never sprinkling `fetch` calls across the
 * Loop.
 */
import { Context, Effect, Layer } from 'effect'
import {
  type GitHubError,
  GitHubApiError,
  GitHubAuthError,
  GitHubInsufficientPermissionsError,
  GitHubNetworkError,
  GitHubRateLimitError,
} from './error'

export const GITHUB_BASE_URL = 'https://api.github.com'

export class GitHubService extends Context.Tag('GitHubService')<
  GitHubService,
  {
    readonly fetchRepo: (
      owner: string,
      repo: string,
    ) => Effect.Effect<unknown, GitHubError>
    readonly listPullRequests: (
      owner: string,
      repo: string,
    ) => Effect.Effect<unknown, GitHubError>
  }
>() {}

export interface GitHubServiceConfig {
  readonly token: string
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
}

export const GitHubServiceLive = (
  config: GitHubServiceConfig,
): Layer.Layer<GitHubService> =>
  Layer.succeed(GitHubService, {
    fetchRepo: (owner, repo) => request(config, `/repos/${owner}/${repo}`),
    listPullRequests: (owner, repo) =>
      request(config, `/repos/${owner}/${repo}/pulls?state=open&per_page=10`),
  })

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

const request = (
  config: GitHubServiceConfig,
  path: string,
): Effect.Effect<unknown, GitHubError> =>
  Effect.gen(function* () {
    const baseUrl = config.baseUrl ?? GITHUB_BASE_URL
    const fetchImpl = config.fetch ?? fetch
    const headers = new Headers({
      Authorization: `token ${config.token}`,
      'User-Agent': 'github-auditor/1.0',
      Accept: 'application/vnd.github.v3+json',
    })

    const res = yield* Effect.tryPromise({
      try: () => fetchImpl(`${baseUrl}${path}`, { headers }),
      catch: (cause) => new GitHubNetworkError({ cause }),
    })

    if (res.status === 401) {
      return yield* new GitHubAuthError({ reason: 'unauthorized' })
    }

    if (res.status === 403) {
      const body = yield* readJson(res)
      const message =
        typeof body === 'object' && body !== null && 'message' in body
          ? String((body as { message: unknown }).message)
          : ''

      if (message.includes('API rate limit exceeded')) {
        const reset = res.headers.get('x-ratelimit-reset')
        const resetAt =
          reset !== null && reset.length > 0
            ? new Date(Number(reset) * 1000)
            : new Date(0)
        return yield* new GitHubRateLimitError({ resetAt })
      }

      if (message.includes('Resource not accessible by integration')) {
        return yield* new GitHubInsufficientPermissionsError({
          missingScope: 'security_events or repo',
        })
      }

      return yield* new GitHubApiError({ status: 403, body: message })
    }

    if (!res.ok) {
      const body = yield* Effect.tryPromise({
        try: () => res.text(),
        catch: () => new GitHubApiError({ status: res.status, body: '' }),
      }).pipe(Effect.orElseSucceed(() => ''))
      return yield* new GitHubApiError({ status: res.status, body })
    }

    return yield* Effect.tryPromise({
      try: () => res.json() as Promise<unknown>,
      catch: (cause) => new GitHubNetworkError({ cause }),
    })
  })

const readJson = (res: Response): Effect.Effect<unknown> =>
  Effect.tryPromise({
    try: () => res.json() as Promise<unknown>,
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null))
