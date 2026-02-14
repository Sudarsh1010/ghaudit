// No global Layer — token is dynamic!
// Instead, instantiate inside Durable Object or application layer

import { Context, Effect } from 'effect'
import { GitHubClient } from './client'
import { GitHubError } from './error'

export interface GitHubService {
  fetchRepo: (
    owner: string,
    repo: string,
  ) => Effect.Effect<unknown, GitHubError>
  listPullRequests: (
    owner: string,
    repo: string,
  ) => Effect.Effect<unknown, GitHubError>
  // Add more as needed
}

export const GitHubService = Context.GenericTag<GitHubService>('GitHubService')

interface GitHubServiceConfig {
  token: string
}

/**
 * Creates a GitHub service instance bound to a specific token.
 * Meant to be instantiated per-audit (inside Durable Object).
 */
export const makeGitHubService = (
  config: GitHubServiceConfig,
): GitHubService => ({
  fetchRepo: (owner, repo) =>
    Effect.tryPromise({
      try: () =>
        new GitHubClient({ token: config.token }).request(
          `/repos/${owner}/${repo}`,
        ),
      catch: (cause) =>
        new GitHubError('Failed to fetch repo', cause as number | undefined),
    }),

  listPullRequests: (owner, repo) =>
    Effect.tryPromise({
      try: () =>
        new GitHubClient({ token: config.token }).request(
          `/repos/${owner}/${repo}/pulls?state=open&per_page=10`,
        ),
      catch: (cause) =>
        new GitHubError('Failed to list PRs', cause as number | undefined),
    }),
})
