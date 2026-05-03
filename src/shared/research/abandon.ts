/**
 * Use case: abandon a Research Session that has been idle in
 * `WAITING_FOR_USER` past its 24h grace.
 *
 * This is the alarm-handler logic, expressed as a pure Effect. The
 * Durable Object's `alarm()` method is a thin wrapper that runs this
 * Effect, drives its FSM transition into `ABANDONED`, and writes the
 * returned `done` event to the SSE writer when one is connected.
 *
 * Outcomes:
 *   - Appends a `research_steps` row with status `failure` and the
 *     reason `ABANDON_REASON` so the audit trail records why the
 *     session ended.
 *   - Flips the session row's status to `abandoned`.
 *   - Returns the `done` event the host should emit to any connected
 *     SSE writer; the event also lives in the persisted log for
 *     reconnecting clients.
 */
import { Clock, Effect } from 'effect'
import type { RepositoryError } from '~/shared/domain/errors'
import { ResearchRepository } from '~/shared/infra/drizzle/repository'
import {
  ResearchSessionStatus,
  ResearchStepStatus,
} from '~/shared/infra/drizzle/schema'
import type { DoneEvent } from '~/shared/sse/events'

export const ABANDON_REASON = 'session abandoned after 24h waiting for user'

export interface AbandonSessionInput {
  readonly sessionId: string
  readonly stepNumber: number
}

export const abandonSession = (
  input: AbandonSessionInput,
): Effect.Effect<DoneEvent, RepositoryError, ResearchRepository> =>
  Effect.gen(function* () {
    const repo = yield* ResearchRepository
    const millis = yield* Clock.currentTimeMillis
    const now = new Date(millis)

    yield* repo.appendStep({
      sessionId: input.sessionId,
      stepNumber: input.stepNumber,
      toolName: null,
      llmResponse: null,
      toolRequest: null,
      toolResponse: null,
      errorMessage: ABANDON_REASON,
      status: ResearchStepStatus.failure,
    })

    yield* repo.setSessionStatus(
      input.sessionId,
      ResearchSessionStatus.abandoned,
      now,
    )

    return {
      id: input.stepNumber,
      type: 'done',
      finalText: ABANDON_REASON,
      status: 'abandoned',
    } satisfies DoneEvent
  })
