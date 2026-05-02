import type { GroqClient } from '~/shared/infra/groq/client'
import type { AgentEvent } from '~/shared/sse/events'
import { echoTool } from './agent'

export interface RunStreamingTickInput {
  sessionId: string
  prompt: string
  groq: GroqClient
  /**
   * Called once per event in emission order. Hosts (DO, tests) decide what to
   * do with each event — persist to research_steps, write to the SSE stream,
   * collect for assertions, etc.
   */
  emit: (event: AgentEvent) => Promise<void> | void
  model?: string
}

/**
 * One tick of the Agent Loop, emitting events as it goes.
 *
 * Slice 2 scope: a single LLM round-trip, with `agent_thinking → (tool_invoked
 * → tool_result)* → done` framing. Event ids start at 1 and increment, so they
 * line up with `research_steps.step_number`.
 */
export const runStreamingTick = async (
  input: RunStreamingTickInput,
): Promise<void> => {
  let nextId = 1
  const emit = async (event: AgentEvent): Promise<void> => {
    await input.emit(event)
  }

  const completion = await input.groq.chatCompletion({
    model: input.model ?? 'llama-3.1-8b-instant',
    messages: [{ role: 'user', content: input.prompt }],
    tools: [echoTool],
  })

  const message = completion.choices[0]?.message
  const text = message?.content ?? ''

  await emit({ id: nextId++, type: 'agent_thinking', text })

  for (const call of message?.tool_calls ?? []) {
    if (call.type !== 'function') continue
    const args = safeJson(call.function.arguments)
    await emit({
      id: nextId++,
      type: 'tool_invoked',
      toolName: call.function.name,
      args,
    })
    const result = runEcho(args)
    await emit({
      id: nextId++,
      type: 'tool_result',
      toolName: call.function.name,
      result,
    })
  }

  await emit({ id: nextId++, type: 'done', finalText: text })
}

const safeJson = (raw: string): unknown => {
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
