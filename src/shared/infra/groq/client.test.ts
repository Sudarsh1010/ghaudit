import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createGroqClient } from './client'

describe('groq client', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('GROQ_API_KEY', 'test-key')
  })

  it('posts chat.completions to the Groq base URL with the API key', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'cmpl_1',
          object: 'chat.completion',
          created: 0,
          model: 'llama-3.1-8b-instant',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hello' },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    const client = createGroqClient({ apiKey: 'test-key', fetch: fetchMock })

    const res = await client.chatCompletion({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(String(url)).toContain('https://api.groq.com/openai/v1')
    expect(String(url)).toContain('/chat/completions')
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer test-key')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('llama-3.1-8b-instant')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])

    expect(res.choices[0].message.content).toBe('hello')
  })

  it('forwards tool definitions in the request body', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'cmpl_2',
          object: 'chat.completion',
          created: 0,
          model: 'm',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '' },
              finish_reason: 'tool_calls',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    const client = createGroqClient({ apiKey: 'k', fetch: fetchMock })

    await client.chatCompletion({
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'echo',
            description: 'echo back',
            parameters: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        },
      ],
    })

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(init.body as string)
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0].function.name).toBe('echo')
  })

  it('throws when GROQ_API_KEY is missing', () => {
    vi.stubEnv('GROQ_API_KEY', '')
    expect(() => createGroqClient()).toThrow(/GROQ_API_KEY/)
  })
})
