import type { GroqClient } from '~/shared/infra/groq/client'
import type { AgentEvent } from '~/shared/sse/events'
import {
  TOOLS,
  dispatch,
  type ToolDispatchContext,
  type ToolResult,
} from '~/shared/agent/tools/registry'

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
  /**
   * Persists a HITL question. Required for the askQuestion tool to work.
   * Defaults to a no-op so existing tests can keep using runStreamingTick
   * without touching the questions table.
   */
  persistQuestion?: ToolDispatchContext['persistQuestion']
  generateQuestionId?: () => string
  model?: string
  /** Step number to start emitting at — for resume after answer. */
  startStepNumber?: number
}

export type TickOutcome =
  | { kind: 'done'; finalText: string }
  | { kind: 'paused'; questionId: string }

/**
 * One tick of the Agent Loop.
 *
 * Slice 3: a tool call may now be a `pause` (askQuestion). When the registry
 * returns `pause`, we emit `question_asked` and exit early WITHOUT emitting
 * `done`, so the host can transition to WAITING_FOR_USER.
 */
export const runStreamingTick = async (
  input: RunStreamingTickInput,
): Promise<TickOutcome> => {
  let nextId = input.startStepNumber ?? 1
  const emit = async (event: AgentEvent): Promise<void> => {
    await input.emit(event)
  }

  const completion = await input.groq.chatCompletion({
    model: input.model ?? 'llama-3.1-8b-instant',
    messages: [{ role: 'user', content: input.prompt }],
    tools: TOOLS,
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

    const result: ToolResult = await dispatch(
      { name: call.function.name, arguments: args },
      {
        sessionId: input.sessionId,
        persistQuestion: input.persistQuestion ?? (async () => {}),
        generateId: input.generateQuestionId,
      },
    )

    if (result.kind === 'pause') {
      await emit({
        id: nextId++,
        type: 'question_asked',
        questionId: result.questionId,
        question: result.payload.question,
        recommendation: result.payload.recommendation,
        rationale: result.payload.rationale,
        kind: result.payload.kind,
      })
      return { kind: 'paused', questionId: result.questionId }
    }

    await emit({
      id: nextId++,
      type: 'tool_result',
      toolName: call.function.name,
      result: result.result,
    })
  }

  await emit({ id: nextId++, type: 'done', finalText: text })
  return { kind: 'done', finalText: text }
}

const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
