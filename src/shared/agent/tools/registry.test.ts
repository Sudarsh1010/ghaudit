import { describe, it, expect } from 'vitest'
import {
  dispatch,
  type ToolDispatchContext,
  type PersistQuestionInput,
} from './registry'

interface TestCtx extends ToolDispatchContext {
  persisted: Array<{ id: string; question: string }>
}

const ctx = (): TestCtx => {
  const persisted: Array<{ id: string; question: string }> = []
  return {
    sessionId: 's1',
    persistQuestion: async (q: PersistQuestionInput) => {
      persisted.push({ id: q.id, question: q.question })
    },
    generateId: () => 'q_fixed',
    persisted,
  }
}

describe('tool registry dispatch', () => {
  it('dispatches askQuestion → pause + persisted question', async () => {
    const c = ctx()
    const result = await dispatch(
      {
        name: 'askQuestion',
        arguments: {
          question: 'Should we cache?',
          recommendation: 'Yes — TTL 5min',
          rationale: 'Hot reads dominate.',
        },
      },
      c,
    )
    expect(result).toEqual({
      kind: 'pause',
      questionId: 'q_fixed',
      payload: {
        question: 'Should we cache?',
        recommendation: 'Yes — TTL 5min',
        rationale: 'Hot reads dominate.',
        kind: 'single',
      },
    })
    expect(c.persisted).toEqual([
      { id: 'q_fixed', question: 'Should we cache?' },
    ])
  })

  it('rejects askQuestion when required fields are missing', async () => {
    const c = ctx()
    await expect(
      dispatch(
        { name: 'askQuestion', arguments: { question: 'why?' } },
        c,
      ),
    ).rejects.toThrow(/recommendation/)
  })

  it('returns continue for the echo tool', async () => {
    const c = ctx()
    const result = await dispatch(
      { name: 'echo', arguments: { text: 'pong' } },
      c,
    )
    expect(result).toEqual({ kind: 'continue', result: { text: 'pong' } })
  })

  it('throws on unknown tool', async () => {
    const c = ctx()
    await expect(
      dispatch({ name: 'mystery', arguments: {} }, c),
    ).rejects.toThrow(/unknown tool/i)
  })
})
