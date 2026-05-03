/**
 * Five-state finite state machine for a Research Session.
 *
 *   RUNNING ──askQuestion──▶ WAITING_FOR_USER
 *      │                        │
 *      │                       answer
 *      ▼                        ▼
 *   FAILED  COMPLETED       RUNNING
 *      ▲       ▲                │
 *      │       │             abandon
 *      │       │                ▼
 *      │       │          ABANDONED
 *
 * Pure: no IO, no side effects. `transition(state, event)` returns an
 * Effect so callers cannot silently drop invalid transitions — failure
 * to handle the `StateTransitionError` is a type error.
 */
import { Effect, Schema } from 'effect'
import { StateTransitionError } from '~/shared/domain/errors'

export const SessionState = Schema.Literal(
  'RUNNING',
  'WAITING_FOR_USER',
  'COMPLETED',
  'FAILED',
  'ABANDONED',
)
export type SessionState = Schema.Schema.Type<typeof SessionState>

export const SessionEvent = Schema.Literal(
  'askQuestion',
  'answer',
  'finalize',
  'fail',
  'abandon',
)
export type SessionEvent = Schema.Schema.Type<typeof SessionEvent>

const TABLE: Record<SessionState, Partial<Record<SessionEvent, SessionState>>> =
  {
    RUNNING: {
      askQuestion: 'WAITING_FOR_USER',
      finalize: 'COMPLETED',
      fail: 'FAILED',
      abandon: 'ABANDONED',
    },
    WAITING_FOR_USER: {
      answer: 'RUNNING',
      abandon: 'ABANDONED',
    },
    COMPLETED: {},
    FAILED: {},
    ABANDONED: {},
  }

/**
 * Compute the next state. Fails with `StateTransitionError` when the
 * (state, event) pair has no edge in the table.
 */
export const transition = (
  state: SessionState,
  event: SessionEvent,
): Effect.Effect<SessionState, StateTransitionError> => {
  const next = TABLE[state][event]
  return next === undefined
    ? Effect.fail(new StateTransitionError({ from: state, event }))
    : Effect.succeed(next)
}

export { StateTransitionError }
