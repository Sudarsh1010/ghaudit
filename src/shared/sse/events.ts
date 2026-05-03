/**
 * `AgentEvent` — every event the Agent Loop can emit, defined once as an
 * Effect Schema and consumed by both the Durable Object emitter and the
 * browser EventSource consumer.
 *
 * Wire format (unchanged from the pre-Effect codec):
 *
 *     id: <stepNumber>\n
 *     event: <type>\n
 *     data: <json payload, sans id+type>\n
 *     \n
 *
 * The Schema encodes the *full* record (including id+type); the wire codec
 * adapts that record into the SSE envelope.
 */
import { Effect, ParseResult, Schema } from 'effect'
import { JsonSyntaxError, SchemaViolation } from '~/shared/domain/errors'

/* ------------------------------------------------------------------ *
 * Per-event Schemas
 * ------------------------------------------------------------------ */

export const AgentThinkingEvent = Schema.Struct({
  id: Schema.Number,
  type: Schema.Literal('agent_thinking'),
  text: Schema.String,
})
export type AgentThinkingEvent = Schema.Schema.Type<typeof AgentThinkingEvent>

export const ToolInvokedEvent = Schema.Struct({
  id: Schema.Number,
  type: Schema.Literal('tool_invoked'),
  toolName: Schema.String,
  args: Schema.Unknown,
})
export type ToolInvokedEvent = Schema.Schema.Type<typeof ToolInvokedEvent>

export const ToolResultEvent = Schema.Struct({
  id: Schema.Number,
  type: Schema.Literal('tool_result'),
  toolName: Schema.String,
  result: Schema.Unknown,
})
export type ToolResultEvent = Schema.Schema.Type<typeof ToolResultEvent>

export const QuestionAskedEvent = Schema.Struct({
  id: Schema.Number,
  type: Schema.Literal('question_asked'),
  questionId: Schema.String,
  question: Schema.String,
  recommendation: Schema.String,
  rationale: Schema.String,
  kind: Schema.Literal('single'),
})
export type QuestionAskedEvent = Schema.Schema.Type<typeof QuestionAskedEvent>

export const PrdSectionWrittenEvent = Schema.Struct({
  id: Schema.Number,
  type: Schema.Literal('prd_section_written'),
  section: Schema.String,
  content: Schema.String,
})
export type PrdSectionWrittenEvent = Schema.Schema.Type<
  typeof PrdSectionWrittenEvent
>

export const DoneEvent = Schema.Struct({
  id: Schema.Number,
  type: Schema.Literal('done'),
  finalText: Schema.String,
})
export type DoneEvent = Schema.Schema.Type<typeof DoneEvent>

/**
 * `ErrorEvent` — surfaces transient retries during backoff windows
 * (`kind: 'retry'`) and the final failure when the loop transitions to
 * `FAILED` (`kind: 'failed'`). The frontend keys off `kind` to render a
 * dismiss-able banner vs. a persistent one.
 */
export const ErrorEvent = Schema.Struct({
  id: Schema.Number,
  type: Schema.Literal('error'),
  kind: Schema.Literal('retry', 'failed'),
  /** Only present on retry events; 1-indexed attempt number. */
  attempt: Schema.optional(Schema.Number),
  reason: Schema.String,
})
export type ErrorEvent = Schema.Schema.Type<typeof ErrorEvent>

export const AgentEvent = Schema.Union(
  AgentThinkingEvent,
  ToolInvokedEvent,
  ToolResultEvent,
  QuestionAskedEvent,
  PrdSectionWrittenEvent,
  DoneEvent,
  ErrorEvent,
)
export type AgentEvent = Schema.Schema.Type<typeof AgentEvent>

/* ------------------------------------------------------------------ *
 * Wire codec
 * ------------------------------------------------------------------ */

const encodeAgentEvent = Schema.encodeSync(AgentEvent)
const decodeAgentEventEffect = Schema.decodeUnknown(AgentEvent)

/**
 * Render one event as an SSE frame. Internally encodes through the Schema
 * (so the frame body always matches the declared shape) and then peels off
 * the envelope fields into the SSE prelude.
 */
export const encode = (event: AgentEvent): string => {
  const encoded = encodeAgentEvent(event) as Record<string, unknown> & {
    id: number
    type: string
  }
  const { id, type, ...payload } = encoded
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}

/**
 * Parse one SSE frame back into a typed `AgentEvent`. Fails with
 * `JsonSyntaxError` if the data line isn't JSON, or `SchemaViolation` if
 * the assembled record doesn't satisfy the union (unknown event type
 * shows up here as `SchemaViolation`).
 */
export const decode = (
  raw: string,
): Effect.Effect<AgentEvent, JsonSyntaxError | SchemaViolation> =>
  Effect.gen(function* () {
    let id: number | null = null
    let type: string | null = null
    let dataRaw: string | null = null

    for (const line of raw.split('\n')) {
      if (line.startsWith('id: ')) id = Number(line.slice(4))
      else if (line.startsWith('event: ')) type = line.slice(7)
      else if (line.startsWith('data: ')) dataRaw = line.slice(6)
    }

    if (id === null || Number.isNaN(id) || type === null || dataRaw === null) {
      return yield* new JsonSyntaxError({
        cause: 'malformed sse frame',
      })
    }

    const payload = yield* Effect.try({
      try: () => JSON.parse(dataRaw) as Record<string, unknown>,
      catch: (cause) => new JsonSyntaxError({ cause }),
    })

    return yield* decodeAgentEventEffect({ id, type, ...payload }).pipe(
      Effect.mapError(
        (cause: ParseResult.ParseError) => new SchemaViolation({ cause }),
      ),
    )
  })

/**
 * Decode an SSE `MessageEvent` (browser side). Reassembles `lastEventId`
 * and the `type` from the EventSource into the same record shape used on
 * the wire.
 */
export const decodeMessageEvent = (
  type: AgentEvent['type'],
  msg: { lastEventId: string; data: string },
): Effect.Effect<AgentEvent, JsonSyntaxError | SchemaViolation> =>
  Effect.gen(function* () {
    const id = Number(msg.lastEventId)
    if (Number.isNaN(id)) {
      return yield* new JsonSyntaxError({
        cause: `non-numeric lastEventId: ${msg.lastEventId}`,
      })
    }
    const payload = yield* Effect.try({
      try: () => JSON.parse(msg.data) as Record<string, unknown>,
      catch: (cause) => new JsonSyntaxError({ cause }),
    })
    return yield* decodeAgentEventEffect({ id, type, ...payload }).pipe(
      Effect.mapError(
        (cause: ParseResult.ParseError) => new SchemaViolation({ cause }),
      ),
    )
  })
