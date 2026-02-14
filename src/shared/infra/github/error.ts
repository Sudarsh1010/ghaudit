export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(`[GitHubError] ${message}`)
    this.name = 'GitHubError'
  }
}

export class GitHubRateLimitError extends GitHubError {
  constructor(resetAt: Date) {
    super(`Rate limited. Reset at ${resetAt.toISOString()}`, 403)
    this.name = 'GitHubRateLimitError'
  }
}

export class GitHubInsufficientPermissionsError extends GitHubError {
  constructor(missingScope: string) {
    super(`Missing required scope: ${missingScope}`, 403)
    this.name = 'GitHubInsufficientPermissionsError'
  }
}
