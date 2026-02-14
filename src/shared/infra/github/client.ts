import {
  GitHubError,
  GitHubRateLimitError,
  GitHubInsufficientPermissionsError,
} from './error'

export interface GitHubClientOptions {
  token: string
  baseUrl?: string
}

/**
 * Minimal, non-Effect GitHub client.
 * Used internally by the Effect service.
 */
export class GitHubClient {
  private readonly headers: Headers

  constructor(private readonly options: GitHubClientOptions) {
    this.headers = new Headers({
      Authorization: `token ${options.token}`,
      'User-Agent': 'github-auditor/1.0',
      Accept: 'application/vnd.github.v3+json',
    })
  }

  async request<T>(path: string): Promise<T> {
    const url = `${this.options.baseUrl || 'https://api.github.com'}${path}`
    const res = await fetch(url, { headers: this.headers })

    if (res.status === 403) {
      const body = await res.json().catch(() => ({}))

      if (
        body &&
        typeof body === 'object' &&
        'message' in body &&
        typeof body.message === 'string'
      ) {
        if (body.message?.includes('API rate limit exceeded')) {
          const reset = res.headers.get('x-ratelimit-reset')
          if (reset)
            throw new GitHubRateLimitError(new Date(Number(reset) * 1000))
        }

        if (body.message?.includes('Resource not accessible by integration')) {
          // Detect missing scopes like security_events
          throw new GitHubInsufficientPermissionsError(
            'security_events or repo',
          )
        }
      }
    }

    if (!res.ok) {
      throw new GitHubError(`HTTP ${res.status}: ${res.statusText}`, res.status)
    }

    return res.json() as Promise<T>
  }
}
