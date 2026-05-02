import { ResearchSessionStatus } from '~/shared/infra/drizzle/schema'

export interface CreateSessionInput {
  initialPrompt: string
}

export interface CreateSessionOutput {
  sessionId: string
  eventStreamUrl: string
}

export interface SessionDeps {
  /** Inserts the row into research_sessions. */
  insertSession: (row: {
    id: string
    initialPrompt: string
    status: ResearchSessionStatus
    createdAt: Date
    updatedAt: Date
  }) => Promise<void>
  /**
   * Builds the SSE URL the client should subscribe to for this session.
   * Injected so the worker can choose between absolute / relative URLs and
   * tests can assert on a stable shape.
   */
  buildEventStreamUrl: (sessionId: string) => string
  generateId?: () => string
  now?: () => Date
}

/**
 * Use case: start a new Research Session.
 *
 * Persists the session row and returns the URL the UI should subscribe to
 * for live agent events. The agent loop itself is kicked off by the SSE
 * stream handler when the client connects.
 */
export const createSession = async (
  input: CreateSessionInput,
  deps: SessionDeps,
): Promise<CreateSessionOutput> => {
  const initialPrompt = input.initialPrompt?.trim() ?? ''
  if (initialPrompt.length === 0) {
    throw new Error('initialPrompt must not be empty')
  }

  const id = (deps.generateId ?? defaultGenerateId)()
  const now = (deps.now ?? (() => new Date()))()

  await deps.insertSession({
    id,
    initialPrompt,
    status: ResearchSessionStatus.active,
    createdAt: now,
    updatedAt: now,
  })

  return { sessionId: id, eventStreamUrl: deps.buildEventStreamUrl(id) }
}

const defaultGenerateId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `rs_${hex}`
}
