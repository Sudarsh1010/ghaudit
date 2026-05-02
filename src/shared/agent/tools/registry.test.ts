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

  it('writeOutput(prd_section) persists the section and returns write_output', async () => {
    const written: Array<{ section: string; content: string }> = []
    const result = await dispatch(
      {
        name: 'writeOutput',
        arguments: {
          kind: 'prd_section',
          section: 'goal',
          content: 'Build dark mode.',
        },
      },
      {
        sessionId: 's',
        persistQuestion: async () => {},
        writePrdSection: async (input) => {
          written.push(input)
        },
      },
    )
    expect(result).toEqual({
      kind: 'write_output',
      output: { kind: 'prd_section', section: 'goal', content: 'Build dark mode.' },
    })
    expect(written).toEqual([
      { section: 'goal', content: 'Build dark mode.' },
    ])
  })

  it('writeOutput with unsupported kind returns not_implemented', async () => {
    const result = await dispatch(
      {
        name: 'writeOutput',
        arguments: { kind: 'open_question', section: 'x', content: 'y' },
      },
      {
        sessionId: 's',
        persistQuestion: async () => {},
      },
    )
    expect(result).toEqual({
      kind: 'continue',
      result: { status: 'not_implemented', kind: 'open_question' },
    })
  })

  it('finalize requires a summary and returns finalize', async () => {
    const result = await dispatch(
      { name: 'finalize', arguments: { summary: 'shipped' } },
      { sessionId: 's', persistQuestion: async () => {} },
    )
    expect(result).toEqual({ kind: 'finalize', summary: 'shipped' })

    await expect(
      dispatch(
        { name: 'finalize', arguments: {} },
        { sessionId: 's', persistQuestion: async () => {} },
      ),
    ).rejects.toThrow(/summary/)
  })
})
