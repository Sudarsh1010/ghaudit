import type OpenAI from 'openai'
import type { GroqClient } from '~/shared/infra/groq/client'

export interface AgentTickInput {
  sessionId: string
  prompt: string
  groq: GroqClient
  model?: string
}

export interface AgentToolCall {
  id: string
  name: string
  arguments: unknown
  result: unknown
}

export interface AgentTickOutput {
  text: string
  toolCalls: Array<AgentToolCall>
}

/**
 * Slice 1's only tool: echoes the input text. Replaced in later slices by
 * real research tools and the HITL askQuestion tool.
 */
export const echoTool: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'echo',
    description: 'Echoes the supplied text back to the caller verbatim.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
}

/**
 * One iteration of the Agent Loop.
 *
 * Slice 1 scope: a single LLM round-trip with the `echo` tool registered.
 * If the model calls the tool, the tool runs and the result is returned;
 * otherwise the assistant's text is returned. No multi-turn, no streaming,
 * no HITL — those arrive in later slices.
 */
export const tick = async (
  input: AgentTickInput,
): Promise<AgentTickOutput> => {
  const completion = await input.groq.chatCompletion({
    model: input.model ?? 'llama-3.1-8b-instant',
    messages: [{ role: 'user', content: input.prompt }],
    tools: [echoTool],
  })

  const message = completion.choices[0]?.message
  const toolCalls: Array<AgentToolCall> = []

  for (const call of message?.tool_calls ?? []) {
    if (call.type !== 'function') continue
    const args = safeParseJson(call.function.arguments)
    const result = runEcho(args)
    toolCalls.push({
      id: call.id,
      name: call.function.name,
      arguments: args,
      result,
    })
  }

  return { text: message?.content ?? '', toolCalls }
}

const safeParseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

const runEcho = (args: unknown): { text: string } => {
  const text =
    typeof args === 'object' && args !== null && 'text' in args
      ? String((args as { text: unknown }).text ?? '')
      : ''
  return { text }
}
