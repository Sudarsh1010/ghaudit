import { describe, it, expect, vi } from 'vitest'
import { createSession } from './session'

/**
 * Slice 2 happy-path: simulates what the worker entry does for `POST /session`
 * by wiring `createSession` to an in-memory "table" and a fake URL builder.
 * The actual streaming is exercised by `streaming-agent.test.ts`.
 */
describe('POST /session happy path (slice 2)', () => {
  it('persists a session row and returns the eventStreamUrl', async () => {
    const sessionsTable: Array<unknown> = []
    const buildEventStreamUrl = vi.fn(
      (id: string) => `/session/${id}/stream`,
    )

    const result = await createSession(
      { initialPrompt: 'help me write a PRD' },
      {
        insertSession: async (row) => {
          sessionsTable.push(row)
        },
        buildEventStreamUrl,
      },
    )

    expect(result.sessionId).toMatch(/^rs_/)
    expect(result.eventStreamUrl).toBe(`/session/${result.sessionId}/stream`)
    expect(sessionsTable).toHaveLength(1)
    expect(buildEventStreamUrl).toHaveBeenCalledOnce()
  })
})
