/**
 * `ResearchRepository.getStepsAfter` — used by the SSE replay path on
 * `EventSource` reconnect (Slice 5). Reads events with `stepNumber >
 * lastEventId` for one session, ordered. The events round-trip through
 * `appendStep`, so a replayed event is bit-equal to the originally
 * emitted one (id + type + payload).
 *
 * Tests run against the in-memory adapter; the D1 adapter shares the
 * same Effect Schema decode path, so behaviour drift between the two
 * surfaces as a row-decode error rather than as silently divergent
 * results.
 */
import { describe, it, expect } from '@effect/vitest'
import { Effect } from 'effect'
import {
  RepositoryInMemoryLive,
  ResearchRepository,
} from './repository'
import { ResearchSessionStatus } from './schema'
import type { AgentEvent } from '~/shared/sse/events'

const sampleEvents: ReadonlyArray<AgentEvent> = [
  { id: 1, type: 'agent_thinking', text: 'pondering' },
  {
    id: 2,
    type: 'tool_invoked',
    toolName: 'echo',
    args: { text: 'hi' },
  },
  {
    id: 3,
    type: 'tool_result',
    toolName: 'echo',
    result: { text: 'hi' },
  },
  {
    id: 4,
    type: 'question_asked',
    questionId: 'q_1',
    question: 'why?',
    recommendation: 'because',
    rationale: 'reasons',
    kind: 'single',
  },
  {
    id: 5,
    type: 'prd_section_written',
    section: 'goal',
    content: 'make it dark',
  },
  { id: 6, type: 'done', finalText: 'all good' },
]

const seedSession = (id: string) =>
  Effect.gen(function* () {
    const repo = yield* ResearchRepository
    const now = new Date(0)
    yield* repo.createSession({
      id,
      initialPrompt: `prompt-${id}`,
      status: ResearchSessionStatus.active,
      createdAt: now,
      updatedAt: now,
    })
  })

describe('ResearchRepository.getStepsAfter', () => {
  it.effect('returns all events when lastEventId is 0', () =>
    Effect.gen(function* () {
      yield* seedSession('s1')
      const repo = yield* ResearchRepository
      for (const event of sampleEvents) {
        yield* repo.appendStep({ sessionId: 's1', event })
      }

      const all = yield* repo.getStepsAfter('s1', 0)
      expect(all).toEqual(sampleEvents)
    }).pipe(Effect.provide(RepositoryInMemoryLive)),
  )

  it.effect('filters out events with stepNumber <= lastEventId', () =>
    Effect.gen(function* () {
      yield* seedSession('s1')
      const repo = yield* ResearchRepository
      for (const event of sampleEvents) {
        yield* repo.appendStep({ sessionId: 's1', event })
      }

      const after3 = yield* repo.getStepsAfter('s1', 3)
      expect(after3).toEqual(sampleEvents.slice(3))

      const after5 = yield* repo.getStepsAfter('s1', 5)
      expect(after5).toEqual(sampleEvents.slice(5))
    }).pipe(Effect.provide(RepositoryInMemoryLive)),
  )

  it.effect('returns an empty array when lastEventId is past the tail', () =>
    Effect.gen(function* () {
      yield* seedSession('s1')
      const repo = yield* ResearchRepository
      for (const event of sampleEvents) {
        yield* repo.appendStep({ sessionId: 's1', event })
      }

      const empty = yield* repo.getStepsAfter('s1', 99)
      expect(empty).toEqual([])
    }).pipe(Effect.provide(RepositoryInMemoryLive)),
  )

  it.effect('orders events by stepNumber even if appended out of order', () =>
    Effect.gen(function* () {
      yield* seedSession('s1')
      const repo = yield* ResearchRepository
      // Append in reverse order — getStepsAfter must restore ordering.
      for (const event of [...sampleEvents].reverse()) {
        yield* repo.appendStep({ sessionId: 's1', event })
      }

      const all = yield* repo.getStepsAfter('s1', 0)
      expect(all).toEqual(sampleEvents)
    }).pipe(Effect.provide(RepositoryInMemoryLive)),
  )

  it.effect('does not leak events from other sessions', () =>
    Effect.gen(function* () {
      yield* seedSession('s1')
      yield* seedSession('s2')
      const repo = yield* ResearchRepository

      yield* repo.appendStep({
        sessionId: 's1',
        event: { id: 1, type: 'agent_thinking', text: 'session-one' },
      })
      yield* repo.appendStep({
        sessionId: 's2',
        event: { id: 1, type: 'agent_thinking', text: 'session-two' },
      })

      const s1 = yield* repo.getStepsAfter('s1', 0)
      expect(s1).toEqual([
        { id: 1, type: 'agent_thinking', text: 'session-one' },
      ])

      const s2 = yield* repo.getStepsAfter('s2', 0)
      expect(s2).toEqual([
        { id: 1, type: 'agent_thinking', text: 'session-two' },
      ])
    }).pipe(Effect.provide(RepositoryInMemoryLive)),
  )

  it.effect('round-trips every AgentEvent variant through appendStep', () =>
    Effect.gen(function* () {
      yield* seedSession('s1')
      const repo = yield* ResearchRepository
      for (const event of sampleEvents) {
        yield* repo.appendStep({ sessionId: 's1', event })
      }
      const reread = yield* repo.getStepsAfter('s1', 0)
      // Bit-equality is the contract: replayed events must match the
      // original emission so the frontend reducer is idempotent.
      expect(reread).toEqual(sampleEvents)
    }).pipe(Effect.provide(RepositoryInMemoryLive)),
  )
})
