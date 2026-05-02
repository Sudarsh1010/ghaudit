import type { AgentTickOutput } from './agent'
import { ResearchSessionStatus } from '~/shared/infra/drizzle/schema'

export interface CreateSessionInput {
  initialPrompt: string
}

export interface CreateSessionOutput {
  sessionId: string
  response: string
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
  /** Spawns the Durable Object for this session and runs one tick(). */
  spawnAgentTick: (
    sessionId: string,
    prompt: string,
  ) => Promise<AgentTickOutput>
  generateId?: () => string
  now?: () => Date
}

/**
 * Use case: start a new Research Session.
 *
 * Persists the session row, spawns its Durable Object, runs one Agent Loop
 * tick, and returns the agent's response. This is the Slice 1 happy-path
 * orchestration; later slices replace `spawnAgentTick` with a streaming
 * channel and add 5-state transitions.
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

  const tickResult = await deps.spawnAgentTick(id, initialPrompt)

  return { sessionId: id, response: tickResult.text }
}

const defaultGenerateId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `rs_${hex}`
}
