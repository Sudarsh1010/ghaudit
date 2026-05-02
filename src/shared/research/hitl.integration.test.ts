import { describe, it, expect, vi } from 'vitest'
import { runStreamingTick } from './streaming-agent'
import { transition } from '~/shared/session/state-machine'
import type { GroqClient } from '~/shared/infra/groq/client'
import type { AgentEvent } from '~/shared/sse/events'

const groqResponding = (
  message: { content?: string; tool_calls?: Array<unknown> },
): GroqClient => ({
  chatCompletion: vi.fn(async () =>
    ({
      id: 'cmpl',
      object: 'chat.completion',
      created: 0,
      model: 'm',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', ...message },
          finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
          logprobs: null,
        },
      ],
    }) as never,
  ),
})

/**
 * Walks one full HITL cycle: agent calls askQuestion → state goes to
 * WAITING_FOR_USER → user answers → state goes back to RUNNING → second
 * tick produces `done`.
 */
describe('HITL ask → answer → resume', () => {
  it('runs the full cycle and persists the question', async () => {
    const persisted: Array<{ id: string; question: string }> = []
    const persistQuestion = vi.fn(async (q: { id: string; question: string }) => {
      persisted.push({ id: q.id, question: q.question })
    })

    let state = 'RUNNING' as const

    // Tick 1: agent asks a question.
    const eventsT1: Array<AgentEvent> = []
    const tick1 = await runStreamingTick({
      sessionId: 's1',
      prompt: 'design a cache',
      groq: groqResponding({
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'askQuestion',
              arguments: JSON.stringify({
                question: 'TTL?',
                recommendation: '5 minutes',
                rationale: 'Hot reads dominate.',
              }),
            },
          },
        ],
      }),
      emit: async (e: AgentEvent) => {
        eventsT1.push(e)
      },
      persistQuestion,
      generateQuestionId: () => 'q_1',
    })

    expect(tick1).toEqual({ kind: 'paused', questionId: 'q_1' })
    expect(eventsT1.map((e) => e.type)).toEqual([
      'agent_thinking',
      'tool_invoked',
      'question_asked',
    ])
    expect(persisted).toEqual([{ id: 'q_1', question: 'TTL?' }])

    const t1 = transition(state, 'askQuestion')
    expect(t1).toEqual({ ok: true, state: 'WAITING_FOR_USER' })
    const next1 = (t1 as { state: 'WAITING_FOR_USER' }).state

    // User answers.
    const t2 = transition(next1, 'answer')
    expect(t2).toEqual({ ok: true, state: 'RUNNING' })

    // Tick 2: agent finalises.
    const eventsT2: Array<AgentEvent> = []
    const tick2 = await runStreamingTick({
      sessionId: 's1',
      prompt: 'continue, TTL=5min',
      groq: groqResponding({ content: 'all set' }),
      emit: async (e: AgentEvent) => {
        eventsT2.push(e)
      },
      startStepNumber: eventsT1.length + 1,
    })

    expect(tick2).toEqual({ kind: 'done', finalText: 'all set' })
    expect(eventsT2.map((e) => e.type)).toEqual(['agent_thinking', 'done'])
    // Step numbers continue past tick 1.
    expect(eventsT2.map((e) => e.id)).toEqual([
      eventsT1.length + 1,
      eventsT1.length + 2,
    ])
  })
})
