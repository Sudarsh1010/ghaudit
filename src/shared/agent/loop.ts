import type OpenAI from 'openai'
import type { GroqClient } from '~/shared/infra/groq/client'
import type { AgentEvent } from '~/shared/sse/events'
import {
  TOOLS,
  dispatch,
  type ToolDispatchContext,
} from './tools/registry'

export type LoopHaltReason = 'paused' | 'finalized' | 'failed'

export interface LoopResult {
  halt: LoopHaltReason
  /** Set when halt === 'paused'. */
  questionId?: string
  /** Set when halt === 'finalized'. */
  summary?: string
  /** Total LLM calls made. */
  turns: number
  /** Final step number reached. */
  finalStepNumber: number
}

export interface RunLoopInput {
  sessionId: string
  prompt: string
  groq: GroqClient
  emit: (event: AgentEvent) => Promise<void> | void
  persistQuestion: ToolDispatchContext['persistQuestion']
  writePrdSection?: ToolDispatchContext['writePrdSection']
  generateQuestionId?: () => string
  model?: string
  startStepNumber?: number
  /** Soft cap appended as advisory text to the system prompt. Default 50. */
  softCap?: number
  /** Hard cap — when reached, the loop force-finalises. Default 100. */
  hardCap?: number
}

const SYSTEM = (softCap: number) =>
  `You are a Research agent grilling the user about a feature so you can produce a PRD.\n` +
  `Aim to finish in under ${softCap} tool calls. Always pair an askQuestion with a recommendation and rationale. ` +
  `When you have enough material, write PRD sections via writeOutput({ kind: 'prd_section', section, content }) ` +
  `and then call finalize({ summary }).`

/**
 * Multi-turn agent loop.
 *
 * Recurses on every non-HITL tool result (echo, writeOutput) by appending the
 * tool message to the running history and asking the model what to do next.
 * Halts on:
 *   - HITL pause     (askQuestion → caller persists state, resumes via answer)
 *   - finalize       (sumary stored, caller emits done + closes stream)
 *   - hard cap       (force-finalize with a "hit step cap" preamble)
 */
export const runLoop = async (input: RunLoopInput): Promise<LoopResult> => {
  const softCap = input.softCap ?? 50
  const hardCap = input.hardCap ?? 100
  let stepNumber = input.startStepNumber ?? 1
  let turns = 0

  const history: Array<OpenAI.ChatCompletionMessageParam> = [
    { role: 'system', content: SYSTEM(softCap) },
    { role: 'user', content: input.prompt },
  ]

  while (true) {
    if (turns >= hardCap) {
      const summary = `Note: hit step cap (${hardCap}). Forced finalize.`
      await input.emit({ id: stepNumber++, type: 'done', finalText: summary })
      return {
        halt: 'finalized',
        summary,
        turns,
        finalStepNumber: stepNumber - 1,
      }
    }

    const completion = await input.groq.chatCompletion({
      model: input.model ?? 'llama-3.1-8b-instant',
      messages: history,
      tools: TOOLS,
    })
    turns++

    const message = completion.choices[0]?.message
    if (!message) throw new Error('agent: empty completion')

    const text = message.content ?? ''
    await input.emit({ id: stepNumber++, type: 'agent_thinking', text })

    history.push({
      role: 'assistant',
      content: text,
      tool_calls: message.tool_calls,
    } as OpenAI.ChatCompletionAssistantMessageParam)

    if (!message.tool_calls || message.tool_calls.length === 0) {
      // No more tool calls — treat as finalize with the assistant text as summary.
      await input.emit({
        id: stepNumber++,
        type: 'done',
        finalText: text,
      })
      return {
        halt: 'finalized',
        summary: text,
        turns,
        finalStepNumber: stepNumber - 1,
      }
    }

    for (const call of message.tool_calls) {
      if (call.type !== 'function') continue
      const args = safeJson(call.function.arguments)

      await input.emit({
        id: stepNumber++,
        type: 'tool_invoked',
        toolName: call.function.name,
        args,
      })

      const result = await dispatch(
        { name: call.function.name, arguments: args },
        {
          sessionId: input.sessionId,
          persistQuestion: input.persistQuestion,
          writePrdSection: input.writePrdSection,
          generateId: input.generateQuestionId,
        },
      )

      if (result.kind === 'pause') {
        await input.emit({
          id: stepNumber++,
          type: 'question_asked',
          questionId: result.questionId,
          question: result.payload.question,
          recommendation: result.payload.recommendation,
          rationale: result.payload.rationale,
          kind: result.payload.kind,
        })
        return {
          halt: 'paused',
          questionId: result.questionId,
          turns,
          finalStepNumber: stepNumber - 1,
        }
      }

      if (result.kind === 'finalize') {
        await input.emit({
          id: stepNumber++,
          type: 'done',
          finalText: result.summary,
        })
        return {
          halt: 'finalized',
          summary: result.summary,
          turns,
          finalStepNumber: stepNumber - 1,
        }
      }

      const renderable =
        result.kind === 'continue' ? result.result : result.output

      await input.emit({
        id: stepNumber++,
        type: 'tool_result',
        toolName: call.function.name,
        result: renderable,
      })

      if (result.kind === 'write_output') {
        await input.emit({
          id: stepNumber++,
          type: 'prd_section_written',
          section: result.output.section,
          content: result.output.content,
        })
      }

      history.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(renderable),
      })
    }
  }
}

const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
