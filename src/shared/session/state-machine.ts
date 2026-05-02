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
 * The machine is pure: no IO, no side effects. Hosts (the DO) call
 * `transition(state, event)` and persist the resulting state separately.
 */

export type SessionState =
  | 'RUNNING'
  | 'WAITING_FOR_USER'
  | 'COMPLETED'
  | 'FAILED'
  | 'ABANDONED'

export type SessionEvent =
  | 'askQuestion'
  | 'answer'
  | 'finalize'
  | 'fail'
  | 'abandon'

export class StateTransitionError extends Error {
  constructor(
    public readonly from: SessionState,
    public readonly event: SessionEvent,
  ) {
    super(`Invalid transition: ${from} + ${event}`)
    this.name = 'StateTransitionError'
  }
}

export type TransitionResult =
  | { ok: true; state: SessionState }
  | { ok: false; error: StateTransitionError }

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

export const transition = (
  state: SessionState,
  event: SessionEvent,
): TransitionResult => {
  const next = TABLE[state][event]
  if (!next) {
    return { ok: false, error: new StateTransitionError(state, event) }
  }
  return { ok: true, state: next }
}
