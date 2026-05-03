/**
 * Round-trip every member of the `AgentEvent` union through `encode` /
 * `decode`. Both directions are pure with respect to the wire format —
 * tests stay in `Effect.gen` so the failure tags are observable through
 * `Exit`.
 */
import { describe, it, expect } from '@effect/vitest'
import { Cause, Effect, Exit } from 'effect'
import {
  decode,
  decodeMessageEvent,
  encode,
  type AgentEvent,
} from './events'

const cases: ReadonlyArray<AgentEvent> = [
  { id: 1, type: 'agent_thinking', text: 'pondering…' },
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
  {
    id: 7,
    type: 'error',
    kind: 'retry',
    attempt: 2,
    reason: 'Groq rate-limited (429)',
  },
  {
    id: 8,
    type: 'error',
    kind: 'failed',
    reason: 'Groq retries exhausted',
  },
]

describe('sse events', () => {
  for (const event of cases) {
    it.effect(`round-trips ${event.type}`, () =>
      Effect.gen(function* () {
        const wire = encode(event)
        expect(wire).toContain(`id: ${event.id}`)
        expect(wire).toContain(`event: ${event.type}`)
        expect(wire.endsWith('\n\n')).toBe(true)
        const decoded = yield* decode(wire)
        expect(decoded).toEqual(event)
      }),
    )
  }

  it.effect('decode fails with SchemaViolation on unknown event type', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decode('id: 1\nevent: nope\ndata: {}\n\n'),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(failure._tag).toBe('Some')
        if (failure._tag === 'Some') {
          expect(failure.value._tag).toBe('SchemaViolation')
        }
      }
    }),
  )

  it.effect('decode fails with JsonSyntaxError on malformed frame', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decode('not even close'))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(failure._tag).toBe('Some')
        if (failure._tag === 'Some') {
          expect(failure.value._tag).toBe('JsonSyntaxError')
        }
      }
    }),
  )

  it.effect('decodeMessageEvent reassembles payload from EventSource msg', () =>
    Effect.gen(function* () {
      const event: AgentEvent = {
        id: 7,
        type: 'agent_thinking',
        text: 'browser-side',
      }
      const decoded = yield* decodeMessageEvent('agent_thinking', {
        lastEventId: '7',
        data: JSON.stringify({ text: 'browser-side' }),
      })
      expect(decoded).toEqual(event)
    }),
  )

  it.effect('decodeMessageEvent rejects non-numeric lastEventId', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decodeMessageEvent('agent_thinking', {
          lastEventId: 'abc',
          data: '{}',
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(failure._tag).toBe('Some')
        if (failure._tag === 'Some') {
          expect(failure.value._tag).toBe('JsonSyntaxError')
        }
      }
    }),
  )
})
