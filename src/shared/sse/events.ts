/**
 * Discriminated union of every event the agent loop can emit over SSE.
 * Each event carries an `id` matching the corresponding `research_steps.step_number`,
 * which lets the client request replay via `Last-Event-ID` (Slice 5).
 */
export type AgentEvent =
  | AgentThinkingEvent
  | ToolInvokedEvent
  | ToolResultEvent
  | QuestionAskedEvent
  | PrdSectionWrittenEvent
  | DoneEvent

export interface AgentThinkingEvent {
  id: number
  type: 'agent_thinking'
  text: string
}

export interface ToolInvokedEvent {
  id: number
  type: 'tool_invoked'
  toolName: string
  args: unknown
}

export interface ToolResultEvent {
  id: number
  type: 'tool_result'
  toolName: string
  result: unknown
}

export interface QuestionAskedEvent {
  id: number
  type: 'question_asked'
  questionId: string
  question: string
  recommendation: string
  rationale: string
  kind: 'single'
}

export interface PrdSectionWrittenEvent {
  id: number
  type: 'prd_section_written'
  section: string
  content: string
}

export interface DoneEvent {
  id: number
  type: 'done'
  finalText: string
}

const KNOWN_TYPES = new Set<AgentEvent['type']>([
  'agent_thinking',
  'tool_invoked',
  'tool_result',
  'question_asked',
  'prd_section_written',
  'done',
])

/**
 * Serialise one event to the SSE wire format. The `data` payload is the
 * event minus the envelope fields (`id`, `type`).
 */
export const encode = (event: AgentEvent): string => {
  const { id, type, ...payload } = event as AgentEvent & Record<string, unknown>
  const data = JSON.stringify(payload)
  return `id: ${id}\nevent: ${type}\ndata: ${data}\n\n`
}

/**
 * Parse one SSE frame back into a typed event. Throws on unknown event type
 * so the caller can decide whether to drop or surface the error.
 */
export const parse = (raw: string): AgentEvent => {
  let id: number | null = null
  let type: string | null = null
  let dataRaw: string | null = null

  for (const line of raw.split('\n')) {
    if (line.startsWith('id: ')) id = Number(line.slice(4))
    else if (line.startsWith('event: ')) type = line.slice(7)
    else if (line.startsWith('data: ')) dataRaw = line.slice(6)
  }

  if (id === null || type === null || dataRaw === null) {
    throw new Error('malformed sse frame')
  }
  if (!KNOWN_TYPES.has(type as AgentEvent['type'])) {
    throw new Error(`unknown event type: ${type}`)
  }

  const payload = JSON.parse(dataRaw) as Record<string, unknown>
  return { id, type, ...payload } as AgentEvent
}
