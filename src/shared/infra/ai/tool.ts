/**
 * `AITool` — the Tool seam.
 *
 * A Tool is the unit the Agent Loop dispatches to when the LLM emits a
 * tool call. Each Tool declares:
 *
 *   - `inputSchema` — Effect Schema the dispatcher decodes raw JSON
 *     arguments through; a parse failure surfaces as `ToolInputParseError`
 *     before `execute` is ever called.
 *   - `execute` — pure-Effect business logic. Returns a `ToolOutcome`
 *     that tells the Loop what to do next (continue with a result, pause
 *     for the user, write a PRD section, or finalise).
 *
 * Encoding "what happens next" in the *return value* keeps the Loop
 * itself a flat consumer of outcomes — it never branches on tool name.
 *
 * `R` carries any services the Tool needs (e.g. `ResearchRepository`,
 * `Ids`); the Loop's environment must satisfy the union of every Tool
 * in the catalog. `E` carries any extra failure modes the Tool surfaces
 * through (defaults to `never` — most tools either succeed or are
 * already total once their input validates).
 */
import { Effect, JSONSchema, type Schema } from 'effect'
import type OpenAI from 'openai'
import type { FunctionParameters } from 'openai/resources/shared'

/* ------------------------------------------------------------------ *
 * ToolOutcome — Tool ↔ Loop contract
 * ------------------------------------------------------------------ */

/**
 * Tagged union of everything a Tool's `execute` can produce.
 *
 *   - `Continue`  — feed `result` back to the LLM and keep stepping.
 *   - `Pause`     — HITL: persist a Question, transition the session to
 *                   `WAITING_FOR_USER`, halt the Loop until the user
 *                   replies.
 *   - `WroteOutput` — a PRD section was written; emit a
 *                   `prd_section_written` event and continue.
 *   - `Finalise`  — close the session; emit `done` and stop.
 */
export type ToolOutcome =
  | {
      readonly _tag: 'Continue'
      readonly result: unknown
    }
  | {
      readonly _tag: 'Pause'
      readonly questionId: string
      readonly question: string
      readonly recommendation: string
      readonly rationale: string
      readonly kind: 'single'
    }
  | {
      readonly _tag: 'WroteOutput'
      readonly section: string
      readonly content: string
    }
  | {
      readonly _tag: 'Finalise'
      readonly summary: string
    }

export const Continue = (result: unknown): ToolOutcome => ({
  _tag: 'Continue',
  result,
})

export const Pause = (q: {
  readonly questionId: string
  readonly question: string
  readonly recommendation: string
  readonly rationale: string
}): ToolOutcome => ({
  _tag: 'Pause',
  kind: 'single',
  questionId: q.questionId,
  question: q.question,
  recommendation: q.recommendation,
  rationale: q.rationale,
})

export const WroteOutput = (output: {
  readonly section: string
  readonly content: string
}): ToolOutcome => ({
  _tag: 'WroteOutput',
  section: output.section,
  content: output.content,
})

export const Finalise = (summary: string): ToolOutcome => ({
  _tag: 'Finalise',
  summary,
})

/* ------------------------------------------------------------------ *
 * AITool
 * ------------------------------------------------------------------ */

export interface AITool<
  Input extends Schema.Schema.Any = Schema.Schema.Any,
  R = never,
  E = never,
> {
  readonly name: string
  readonly description: string
  readonly inputSchema: Input
  readonly execute: (
    input: Schema.Schema.Type<Input>,
  ) => Effect.Effect<ToolOutcome, E, R>
}

/**
 * Serialise a Tool's `inputSchema` to JSON Schema and wrap it in the
 * shape `chat.completions.create({ tools })` expects.
 */
export const toOpenAITool = <Input extends Schema.Schema.Any, R, E>(
  tool: AITool<Input, R, E>,
): OpenAI.ChatCompletionTool => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: JSONSchema.make(
      tool.inputSchema,
    ) as unknown as FunctionParameters,
  },
})

/**
 * Identity-typed constructor — exists purely so call sites get
 * inference for `Input`, `R`, and `E` from the spec object without
 * having to spell out the generics.
 */
export const defineTool = <
  Input extends Schema.Schema.Any,
  R = never,
  E = never,
>(spec: {
  readonly name: string
  readonly description: string
  readonly inputSchema: Input
  readonly execute: (
    input: Schema.Schema.Type<Input>,
  ) => Effect.Effect<ToolOutcome, E, R>
}): AITool<Input, R, E> => spec

/* ------------------------------------------------------------------ *
 * Re-export Effect for the rare call site that needs to construct
 * tools without importing Effect themselves (kept narrow on purpose —
 * pulling in the whole module would defeat tree-shaking).
 * ------------------------------------------------------------------ */

export { Effect }
