/**
 * `abandonSession` is the alarm-handler logic, expressed as a pure
 * Effect. The Durable Object's `alarm()` method is a thin wrapper that
 * runs this Effect and writes its output event to the SSE writer
 * (when one is connected). Testing the Effect directly == testing the
 * alarm handler's behaviour: state transition, persisted step row,
 * emitted event.
 */
import { describe, it, expect } from '@effect/vitest'
import { Effect, Layer, TestClock } from 'effect'
import {
  RepositoryInMemoryLive,
  ResearchRepository,
} from '~/shared/infra/drizzle/repository'
import {
  ResearchSessionStatus,
  ResearchStepStatus,
} from '~/shared/infra/drizzle/schema'
import { abandonSession, ABANDON_REASON } from './abandon'

const TestEnv = Layer.merge(RepositoryInMemoryLive, Layer.empty)

describe('abandonSession', () => {
  it.effect(
    'persists a failure step, marks the session abandoned, and returns a done event',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1700000000000)
        const repo = yield* ResearchRepository

        // Seed: a session in WAITING_FOR_USER (the only state from which
        // the alarm should fire — but abandonSession itself is agnostic
        // to the prior state).
        yield* repo.createSession({
          id: 's1',
          initialPrompt: 'p',
          status: ResearchSessionStatus.waitingForUser,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        })

        const event = yield* abandonSession({
          sessionId: 's1',
          stepNumber: 7,
        })

        expect(event).toEqual({
          id: 7,
          type: 'done',
          finalText: ABANDON_REASON,
          status: 'abandoned',
        })
        expect(ABANDON_REASON).toBe(
          'session abandoned after 24h waiting for user',
        )

        // Session row was flipped.
        const session = yield* repo.getSessionById('s1')
        expect(session.status).toBe(ResearchSessionStatus.abandoned)
        expect(session.updatedAt.getTime()).toBe(1700000000000)

        // A failure step row was appended carrying the reason.
        const steps = yield* repo.listStepsBySession('s1')
        expect(steps).toHaveLength(1)
        const step = steps[0]!
        expect(step.sessionId).toBe('s1')
        expect(step.stepNumber).toBe(7)
        expect(step.status).toBe(ResearchStepStatus.failure)
        expect(step.errorMessage).toBe(ABANDON_REASON)
        expect(step.toolName).toBeNull()
      }).pipe(Effect.provide(TestEnv)),
  )
})
