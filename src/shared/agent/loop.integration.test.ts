import { describe, it, expect, vi } from 'vitest'
import { runLoop } from './loop'
import type { GroqClient } from '~/shared/infra/groq/client'
import type { AgentEvent } from '~/shared/sse/events'

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

/**
 * 3-question session that ends with a populated PRD. Verifies the full
 * Slice 4 happy path: ask → answer (resume) → ask → answer → ask → answer →
 * write PRD sections → finalize, with sections persisted via writePrdSection.
 */
describe('Slice 4 happy path: 3-question session → PRD', () => {
  const askQuestionCall = (
    id: string,
    q: { question: string; recommendation: string; rationale: string },
  ) => ({
    id,
    function: {
      name: 'askQuestion',
      arguments: JSON.stringify(q),
    },
  })

  const writeOutputCall = (id: string, section: string, content: string) => ({
    id,
    function: {
      name: 'writeOutput',
      arguments: JSON.stringify({ kind: 'prd_section', section, content }),
    },
  })

  const finalizeCall = (id: string, summary: string) => ({
    id,
    function: { name: 'finalize', arguments: JSON.stringify({ summary }) },
  })

  it('runs 3 ticks with HITL pauses and ends with a finalized PRD', async () => {
    const persisted = {
      questions: [] as Array<{ id: string }>,
      sections: [] as Array<{ section: string; content: string }>,
    }
    const persistQuestion = async (q: { id: string }) => {
      persisted.questions.push({ id: q.id })
    }
    const writePrdSection = async (s: { section: string; content: string }) => {
      persisted.sections.push(s)
    }

    let qSeq = 0
    const nextQid = () => `q_${++qSeq}`

    // Tick 1: ask question 1.
    const groq1 = cannedGroq([
      { tool_calls: [askQuestionCall('c1', {
        question: 'Who are the users?',
        recommendation: 'Power users on Linux',
        rationale: 'They tolerate complexity.',
      })] },
    ])
    const events1: Array<AgentEvent> = []
    const r1 = await runLoop({
      sessionId: 's',
      prompt: 'Build me a CLI dark mode toggler',
      groq: groq1,
      emit: async (e: AgentEvent) => { events1.push(e) },
      persistQuestion,
      writePrdSection,
      generateQuestionId: nextQid,
    })
    expect(r1.halt).toBe('paused')
    expect(r1.questionId).toBe('q_1')

    // Tick 2: ask question 2.
    const groq2 = cannedGroq([
      { tool_calls: [askQuestionCall('c2', {
        question: 'Should we ship as a library or a binary?',
        recommendation: 'Both',
        rationale: 'Library for embedders, binary for end users.',
      })] },
    ])
    const events2: Array<AgentEvent> = []
    const r2 = await runLoop({
      sessionId: 's',
      prompt: 'Power users on Linux is fine',
      groq: groq2,
      emit: async (e: AgentEvent) => { events2.push(e) },
      persistQuestion,
      writePrdSection,
      generateQuestionId: nextQid,
      startStepNumber: r1.finalStepNumber + 1,
    })
    expect(r2.halt).toBe('paused')
    expect(r2.questionId).toBe('q_2')

    // Tick 3: ask question 3.
    const groq3 = cannedGroq([
      { tool_calls: [askQuestionCall('c3', {
        question: 'Are there non-goals?',
        recommendation: 'Windows support is out of scope',
        rationale: 'Limits surface area.',
      })] },
    ])
    const events3: Array<AgentEvent> = []
    const r3 = await runLoop({
      sessionId: 's',
      prompt: 'Both is good',
      groq: groq3,
      emit: async (e: AgentEvent) => { events3.push(e) },
      persistQuestion,
      writePrdSection,
      generateQuestionId: nextQid,
      startStepNumber: r2.finalStepNumber + 1,
    })
    expect(r3.halt).toBe('paused')
    expect(r3.questionId).toBe('q_3')

    // Final tick: write 3 sections + finalize.
    const groq4 = cannedGroq([
      {
        tool_calls: [
          writeOutputCall('w1', 'goal', 'Toggle dark mode from a CLI.'),
          writeOutputCall('w2', 'users', 'Power users on Linux.'),
          writeOutputCall('w3', 'non_goals', 'Windows support.'),
        ],
      },
      { tool_calls: [finalizeCall('f1', 'PRD ready to ship.')] },
    ])
    const events4: Array<AgentEvent> = []
    const r4 = await runLoop({
      sessionId: 's',
      prompt: 'No, those three were the only questions',
      groq: groq4,
      emit: async (e: AgentEvent) => { events4.push(e) },
      persistQuestion,
      writePrdSection,
      startStepNumber: r3.finalStepNumber + 1,
    })

    expect(r4.halt).toBe('finalized')
    expect(r4.summary).toBe('PRD ready to ship.')
    expect(persisted.questions).toEqual([
      { id: 'q_1' },
      { id: 'q_2' },
      { id: 'q_3' },
    ])
    expect(persisted.sections.map((s) => s.section)).toEqual([
      'goal',
      'users',
      'non_goals',
    ])
    expect(events4.filter((e) => e.type === 'prd_section_written')).toHaveLength(3)
    expect(events4[events4.length - 1].type).toBe('done')
  })
})
