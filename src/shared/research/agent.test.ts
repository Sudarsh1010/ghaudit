import { describe, it, expect, vi } from 'vitest'
import { tick } from './agent'
import type { GroqClient } from '~/shared/infra/groq/client'

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

describe('research agent tick', () => {
  it('returns the assistant text when the LLM does not call a tool', async () => {
    const groq = groqResponding({ content: 'hello world' })
    const out = await tick({ sessionId: 's1', prompt: 'hi', groq })
    expect(out.text).toBe('hello world')
    expect(out.toolCalls).toEqual([])
  })

  it('executes the echo tool and returns its result when the LLM calls it', async () => {
    const groq = groqResponding({
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
    })
    const out = await tick({ sessionId: 's2', prompt: 'echo pong', groq })
    expect(out.toolCalls).toHaveLength(1)
    expect(out.toolCalls[0].name).toBe('echo')
    expect(out.toolCalls[0].result).toEqual({ text: 'pong' })
  })
})
