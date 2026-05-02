import { describe, it, expect, vi } from 'vitest'
import { runLoop, type LoopHaltReason } from './loop'
import type { GroqClient } from '~/shared/infra/groq/client'

interface CannedTurn {
  content?: string
  tool_calls?: Array<{
    id: string
    function: { name: string; arguments: string }
  }>
}

const cannedGroq = (turns: Array<CannedTurn>): GroqClient => {
  let i = 0
  return {
    chatCompletion: vi.fn(async () => {
      const turn = turns[i++]
      if (!turn) throw new Error(`unexpected turn ${i}`)
      return {
        id: `cmpl_${i}`,
        object: 'chat.completion',
        created: 0,
        model: 'm',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: turn.content ?? '',
              tool_calls: turn.tool_calls?.map((c) => ({
                ...c,
                type: 'function',
              })),
            },
            finish_reason: turn.tool_calls ? 'tool_calls' : 'stop',
            logprobs: null,
          },
        ],
      } as never
    }),
  }
}

describe('agent loop', () => {
  it('halts on HITL pause (askQuestion)', async () => {
    const groq = cannedGroq([
      {
        tool_calls: [
          {
            id: 'c1',
            function: {
              name: 'askQuestion',
              arguments: JSON.stringify({
                question: 'q?',
                recommendation: 'r',
                rationale: 'why',
              }),
            },
          },
        ],
      },
    ])

    const result = await runLoop({
      sessionId: 's',
      prompt: 'go',
      groq,
      emit: async () => {},
      persistQuestion: async () => {},
      generateQuestionId: () => 'q1',
    })

    expect(result.halt).toBe('paused' satisfies LoopHaltReason)
    expect(result.questionId).toBe('q1')
    expect((groq.chatCompletion as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('continues across non-HITL tools and halts on finalize', async () => {
    const groq = cannedGroq([
      {
        tool_calls: [
          {
            id: 'c1',
            function: {
              name: 'echo',
              arguments: JSON.stringify({ text: 'hi' }),
            },
          },
        ],
      },
      {
        tool_calls: [
          {
            id: 'c2',
            function: {
              name: 'writeOutput',
              arguments: JSON.stringify({
                kind: 'prd_section',
                section: 'goal',
                content: 'Build dark mode.',
              }),
            },
          },
        ],
      },
      {
        tool_calls: [
          {
            id: 'c3',
            function: {
              name: 'finalize',
              arguments: JSON.stringify({ summary: 'shipped' }),
            },
          },
        ],
      },
    ])

    const sectionsWritten: Array<string> = []
    const result = await runLoop({
      sessionId: 's',
      prompt: 'go',
      groq,
      emit: async () => {},
      persistQuestion: async () => {},
      writePrdSection: async ({ section }) => {
        sectionsWritten.push(section)
      },
    })

    expect(result.halt).toBe('finalized')
    expect(result.summary).toBe('shipped')
    expect(sectionsWritten).toEqual(['goal'])
    expect((groq.chatCompletion as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3)
  })

  it('hits the hard cap and force-finalizes', async () => {
    const turns: Array<CannedTurn> = []
    for (let i = 0; i < 200; i++) {
      turns.push({
        tool_calls: [
          {
            id: `c${i}`,
            function: {
              name: 'echo',
              arguments: JSON.stringify({ text: `n=${i}` }),
            },
          },
        ],
      })
    }
    const groq = cannedGroq(turns)
    const result = await runLoop({
      sessionId: 's',
      prompt: 'go',
      groq,
      emit: async () => {},
      persistQuestion: async () => {},
      hardCap: 5,
      softCap: 3,
    })

    expect(result.halt).toBe('finalized')
    expect(result.summary).toMatch(/hit step cap/i)
    expect((groq.chatCompletion as ReturnType<typeof vi.fn>).mock.calls.length).toBe(5)
  })
})
