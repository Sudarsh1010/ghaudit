export class AIError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[AIError] ${message}`)
    this.name = 'AIError'
  }
}
