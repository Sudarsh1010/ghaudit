import { describe, it, expect } from 'vitest'
import { encode, parse, type AgentEvent } from './events'

describe('sse events round-trip', () => {
  const cases: Array<AgentEvent> = [
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
    { id: 4, type: 'done', finalText: 'all good' },
  ]

  for (const event of cases) {
    it(`round-trips ${event.type}`, () => {
      const wire = encode(event)
      expect(wire).toContain(`id: ${event.id}`)
      expect(wire).toContain(`event: ${event.type}`)
      expect(wire.endsWith('\n\n')).toBe(true)
      expect(parse(wire)).toEqual(event)
    })
  }

  it('throws on unknown event type', () => {
    expect(() => parse('id: 1\nevent: nope\ndata: {}\n\n')).toThrow(
      /unknown event type/i,
    )
  })
})
