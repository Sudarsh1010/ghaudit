import { describe, it, expect, vi } from 'vitest'
import { createSession } from './session'

describe('createSession', () => {
  it('persists a research_sessions row and returns the SSE stream URL', async () => {
    const insertSession =
      vi.fn<(row: { id: string; initialPrompt: string; status: string }) => Promise<void>>(
        async () => {},
      )

    const result = await createSession(
      { initialPrompt: 'help me write a PRD' },
      {
        insertSession,
        buildEventStreamUrl: (id) => `/session/${id}/stream`,
        generateId: () => 'rs_fixed',
        now: () => new Date(1700000000000),
      },
    )

    expect(result).toEqual({
      sessionId: 'rs_fixed',
      eventStreamUrl: '/session/rs_fixed/stream',
    })

    expect(insertSession).toHaveBeenCalledOnce()
    const firstCall = insertSession.mock.calls[0]!
    expect(firstCall[0]).toMatchObject({
      id: 'rs_fixed',
      initialPrompt: 'help me write a PRD',
      status: 'active',
    })
  })

  it('rejects when initialPrompt is empty', async () => {
    await expect(
      createSession(
        { initialPrompt: '   ' },
        {
          insertSession: vi.fn(),
          buildEventStreamUrl: () => '/x',
        },
      ),
    ).rejects.toThrow(/initialPrompt/)
  })
})
