import { describe, it, expect, vi } from 'vitest'
import { createSession } from './session'
import type { AgentTickOutput } from './agent'

/**
 * Slice 1 happy-path: simulates what the worker entry does for `POST /session`
 * by wiring `createSession` to an in-memory "table" and a fake DO stub that
 * resolves a canned tick result.
 */
describe('POST /session happy path (mocked DO + LLM)', () => {
  it('persists a session row, calls the DO once, and returns the response', async () => {
    const sessionsTable: Array<unknown> = []

    const fakeDoFetch = vi.fn(
      async (): Promise<AgentTickOutput> => ({
        text: 'agent says hi',
        toolCalls: [],
      }),
    )

    const result = await createSession(
      { initialPrompt: 'help me write a PRD' },
      {
        insertSession: async (row) => {
          sessionsTable.push(row)
        },
        spawnAgentTick: async (sessionId, prompt) => {
          // Simulate the worker dispatching to the Durable Object.
          expect(sessionId).toMatch(/^rs_/)
          expect(prompt).toBe('help me write a PRD')
          return fakeDoFetch()
        },
      },
    )

    expect(result.sessionId).toMatch(/^rs_/)
    expect(result.response).toBe('agent says hi')
    expect(sessionsTable).toHaveLength(1)
    expect(fakeDoFetch).toHaveBeenCalledOnce()
  })
})
