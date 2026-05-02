import { describe, it, expect } from 'vitest'
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
) => {
  const result = transition(from, event)
  expect(result).toEqual({ ok: true, state: to })
}

const expectErr = (from: SessionState, event: SessionEvent) => {
  const result = transition(from, event)
  expect(result).toMatchObject({ ok: false })
  expect((result as { error: StateTransitionError }).error).toBeInstanceOf(
    StateTransitionError,
  )
}

describe('session state machine', () => {
  describe('valid transitions', () => {
    it('RUNNING + askQuestion → WAITING_FOR_USER', () => {
      expectOk('RUNNING', 'askQuestion', 'WAITING_FOR_USER')
    })
    it('RUNNING + finalize → COMPLETED', () => {
      expectOk('RUNNING', 'finalize', 'COMPLETED')
    })
    it('RUNNING + fail → FAILED', () => {
      expectOk('RUNNING', 'fail', 'FAILED')
    })
    it('RUNNING + abandon → ABANDONED', () => {
      expectOk('RUNNING', 'abandon', 'ABANDONED')
    })
    it('WAITING_FOR_USER + answer → RUNNING', () => {
      expectOk('WAITING_FOR_USER', 'answer', 'RUNNING')
    })
    it('WAITING_FOR_USER + abandon → ABANDONED', () => {
      expectOk('WAITING_FOR_USER', 'abandon', 'ABANDONED')
    })
  })

  describe('invalid transitions', () => {
    const terminal: Array<SessionState> = ['COMPLETED', 'FAILED', 'ABANDONED']
    const allEvents: Array<SessionEvent> = [
      'askQuestion',
      'answer',
      'finalize',
      'fail',
      'abandon',
    ]

    for (const state of terminal) {
      for (const event of allEvents) {
        it(`${state} + ${event} → error`, () => {
          expectErr(state, event)
        })
      }
    }

    it('RUNNING + answer → error', () => {
      expectErr('RUNNING', 'answer')
    })
    it('WAITING_FOR_USER + askQuestion → error (already waiting)', () => {
      expectErr('WAITING_FOR_USER', 'askQuestion')
    })
    it('WAITING_FOR_USER + finalize → error', () => {
      expectErr('WAITING_FOR_USER', 'finalize')
    })
  })
})
