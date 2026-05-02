import type OpenAI from 'openai'

/**
 * Tool registry — dispatches one LLM-issued tool call to either a pure
 * "continue" result (research tools, echo) or a "pause" signal (HITL tools
 * like askQuestion that must wait for user input).
 *
 * Tools are validated at the boundary so the agent loop never has to know
 * how each tool's input is shaped.
 */

export interface PersistQuestionInput {
  id: string
  question: string
  recommendation: string
  rationale: string
  kind: 'single'
}

export interface ToolDispatchContext {
  sessionId: string
  persistQuestion: (input: PersistQuestionInput) => Promise<void>
  generateId?: () => string
}

export interface ToolCall {
  name: string
  arguments: unknown
}

export type ToolResult =
  | { kind: 'continue'; result: unknown }
  | {
      kind: 'pause'
      questionId: string
      payload: {
        question: string
        recommendation: string
        rationale: string
        kind: 'single'
      }
    }

export const dispatch = async (
  call: ToolCall,
  ctx: ToolDispatchContext,
): Promise<ToolResult> => {
  switch (call.name) {
    case 'askQuestion':
      return dispatchAskQuestion(call.arguments, ctx)
    case 'echo':
      return { kind: 'continue', result: parseEchoArgs(call.arguments) }
    default:
      throw new Error(`Unknown tool: ${call.name}`)
  }
}

const dispatchAskQuestion = async (
  args: unknown,
  ctx: ToolDispatchContext,
): Promise<ToolResult> => {
  if (!isObject(args)) throw new Error('askQuestion: arguments must be object')
  const question = requireString(args, 'question')
  const recommendation = requireString(args, 'recommendation')
  const rationale = requireString(args, 'rationale')

  const id = (ctx.generateId ?? defaultId)()
  await ctx.persistQuestion({
    id,
    question,
    recommendation,
    rationale,
    kind: 'single',
  })

  return {
    kind: 'pause',
    questionId: id,
    payload: { question, recommendation, rationale, kind: 'single' },
  }
}

const parseEchoArgs = (args: unknown): { text: string } => {
  if (!isObject(args)) return { text: '' }
  return { text: String(args.text ?? '') }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

const requireString = (
  args: Record<string, unknown>,
  key: string,
): string => {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing or empty string field: ${key}`)
  }
  return value
}

const defaultId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `q_${hex}`
}

/**
 * OpenAI tool definitions for everything the agent can call. Slice 3 adds
 * `askQuestion` alongside `echo`.
 */
export const TOOLS: Array<OpenAI.ChatCompletionTool> = [
  {
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
  },
  {
    type: 'function',
    function: {
      name: 'askQuestion',
      description:
        'Pause the loop and ask the user a single question. Always include your own recommendation and rationale.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask.' },
          recommendation: {
            type: 'string',
            description: "Your own answer — what you'd choose, and any caveats.",
          },
          rationale: {
            type: 'string',
            description: 'Why this is the right recommendation.',
          },
        },
        required: ['question', 'recommendation', 'rationale'],
        additionalProperties: false,
      },
    },
  },
]
