/**
 * Pure FSM — no IO, no R, no layers. We assert through `Effect.exit` so
 * the success/failure shape is the test surface, not a hand-rolled
 * `{ok, state}` envelope.
 */
import { describe, it, expect } from '@effect/vitest'
import { Cause, Effect, Exit } from 'effect'
import {
  transition,
  StateTransitionError,
  type SessionState,
  type SessionEvent,
} from './state-machine'

const expectOk = (
  from: SessionState,
  event: SessionEvent,
  to: SessionState,
) =>
  it.effect(`${from} + ${event} → ${to}`, () =>
    Effect.gen(function* () {
      const next = yield* transition(from, event)
      expect(next).toBe(to)
    }),
  )

const expectErr = (from: SessionState, event: SessionEvent) =>
  it.effect(`${from} + ${event} → StateTransitionError`, () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(transition(from, event))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(failure._tag).toBe('Some')
        if (failure._tag === 'Some') {
          expect(failure.value).toBeInstanceOf(StateTransitionError)
          expect(failure.value._tag).toBe('StateTransitionError')
          expect(failure.value.from).toBe(from)
          expect(failure.value.event).toBe(event)
        }
      }
    }),
  )

describe('session state machine', () => {
  describe('valid transitions', () => {
    expectOk('RUNNING', 'askQuestion', 'WAITING_FOR_USER')
    expectOk('RUNNING', 'finalize', 'COMPLETED')
    expectOk('RUNNING', 'fail', 'FAILED')
    expectOk('RUNNING', 'abandon', 'ABANDONED')
    expectOk('WAITING_FOR_USER', 'answer', 'RUNNING')
    expectOk('WAITING_FOR_USER', 'abandon', 'ABANDONED')
  })

  describe('invalid transitions', () => {
    const terminal: ReadonlyArray<SessionState> = [
      'COMPLETED',
      'FAILED',
      'ABANDONED',
    ]
    const allEvents: ReadonlyArray<SessionEvent> = [
      'askQuestion',
      'answer',
      'finalize',
      'fail',
      'abandon',
    ]

    for (const state of terminal) {
      for (const event of allEvents) {
        expectErr(state, event)
      }
    }

    expectErr('RUNNING', 'answer')
    expectErr('WAITING_FOR_USER', 'askQuestion')
    expectErr('WAITING_FOR_USER', 'finalize')
  })
})
