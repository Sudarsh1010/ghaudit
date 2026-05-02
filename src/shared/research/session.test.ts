import { describe, it, expect, vi } from 'vitest'
import { createSession } from './session'

describe('createSession', () => {
  it('persists a research_sessions row, runs the DO tick, returns the response text', async () => {
    const insertSession =
      vi.fn<(row: { id: string; initialPrompt: string; status: string }) => Promise<void>>(
        async () => {},
      )
    const spawnAgentTick = vi.fn(async () => ({
      text: 'agent says hi',
      toolCalls: [],
    }))

    const result = await createSession(
      { initialPrompt: 'help me write a PRD' },
      {
        insertSession,
        spawnAgentTick,
        generateId: () => 'rs_fixed',
        now: () => new Date(1700000000000),
      },
    )

    expect(result).toEqual({
      sessionId: 'rs_fixed',
      response: 'agent says hi',
    })

    expect(insertSession).toHaveBeenCalledOnce()
    const firstCall = insertSession.mock.calls[0]!
    expect(firstCall[0]).toMatchObject({
      id: 'rs_fixed',
      initialPrompt: 'help me write a PRD',
      status: 'active',
    })

    expect(spawnAgentTick).toHaveBeenCalledWith(
      'rs_fixed',
      'help me write a PRD',
    )
  })

  it('rejects when initialPrompt is empty', async () => {
    await expect(
      createSession(
        { initialPrompt: '   ' },
        {
          insertSession: vi.fn(),
          spawnAgentTick: vi.fn(),
        },
      ),
    ).rejects.toThrow(/initialPrompt/)
  })
})
