/**
 * Stream-orchestration helpers shared by the Durable Object and tests.
 *
 * The DO drains a `Stream<AgentEvent>` from the agent loop and, for each
 * event, has to:
 *
 *   - persist a `research_steps` row that mirrors the event,
 *   - decide what FSM event (if any) the *terminal* event implies.
 *
 * Both decisions are pure functions of the event shape, so they live here
 * — the DO calls them one layer up but the tests can call them directly
 * against the in-memory repo without spinning up a real DO.
 */
import { Effect } from 'effect'
import type { RepositoryError } from '~/shared/domain/errors'
import {
  ResearchRepository,
  type NewStep,
} from '~/shared/infra/drizzle/repository'
import { ResearchSessionStatus } from '~/shared/infra/drizzle/schema'
import type { SessionEvent, SessionState } from '~/shared/session/state-machine'
import type { AgentEvent } from '~/shared/sse/events'

/**
 * Mapping from FSM state → DB-encoded session status. Lives here (not in
 * the DO) so the test orchestrator and the DO agree on the encoding.
 */
export const STATE_TO_DB: Record<SessionState, ResearchSessionStatus> = {
  RUNNING: ResearchSessionStatus.active,
  WAITING_FOR_USER: ResearchSessionStatus.waitingForUser,
  COMPLETED: ResearchSessionStatus.completed,
  FAILED: ResearchSessionStatus.failed,
  ABANDONED: ResearchSessionStatus.abandoned,
}

/**
 * Wrap an `AgentEvent` into the `NewStep` write shape the repository
 * accepts. The repo then projects the event into the per-column row
 * (deriving `errorMessage` from `error/*` events and choosing
 * `status: failure` only on `error/failed`).
 */
export const eventToStep = (sessionId: string, event: AgentEvent): NewStep => ({
  sessionId,
  event,
})

/**
 * Persist one step row through the repository. Effectful wrapper around
 * `eventToStep`.
 */
export const persistStepForEvent = (
  sessionId: string,
  event: AgentEvent,
): Effect.Effect<void, RepositoryError, ResearchRepository> =>
  Effect.gen(function* () {
    const repo = yield* ResearchRepository
    yield* repo.appendStep(eventToStep(sessionId, event))
  })

/**
 * Decide which FSM event (if any) the terminal stream event implies.
 *
 *   - question_asked → askQuestion
 *   - error/failed   → fail
 *   - done           → finalize
 *
 * Anything else → undefined (the host shouldn't transition; the loop
 * either ended mid-stream and another tick will follow, or the event
 * carries no transition semantics).
 */
export const transitionEventForLastEvent = (
  event: AgentEvent,
): SessionEvent | undefined => {
  switch (event.type) {
    case 'question_asked':
      return 'askQuestion'
    case 'done':
      return 'finalize'
    case 'error':
      return event.kind === 'failed' ? 'fail' : undefined
    default:
      return undefined
  }
}
