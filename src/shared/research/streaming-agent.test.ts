import { describe, it, expect, vi } from 'vitest'
import { runStreamingTick } from './streaming-agent'
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

describe('runStreamingTick', () => {
  it('emits agent_thinking → done for a text-only response, ids increment from 1', async () => {
    const emitted: Array<AgentEvent> = []
    await runStreamingTick({
      sessionId: 's1',
      prompt: 'hi',
      groq: groqResponding({ content: 'pondering. final answer.' }),
      emit: async (e: AgentEvent) => {
        emitted.push(e)
      },
    })

    expect(emitted.map((e) => e.type)).toEqual(['agent_thinking', 'done'])
    expect(emitted.map((e) => e.id)).toEqual([1, 2])
    expect(emitted[1]).toMatchObject({
      type: 'done',
      finalText: 'pondering. final answer.',
    })
  })

  it('emits tool_invoked + tool_result when the LLM calls echo', async () => {
    const emitted: Array<AgentEvent> = []
    await runStreamingTick({
      sessionId: 's2',
      prompt: 'echo pong',
      groq: groqResponding({
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'echo',
              arguments: JSON.stringify({ text: 'pong' }),
            },
          },
        ],
      }),
      emit: async (e: AgentEvent) => {
        emitted.push(e)
      },
    })

    expect(emitted.map((e) => e.type)).toEqual([
      'agent_thinking',
      'tool_invoked',
      'tool_result',
      'done',
    ])
    expect(emitted[2]).toMatchObject({
      type: 'tool_result',
      toolName: 'echo',
      result: { text: 'pong' },
    })
  })
})
