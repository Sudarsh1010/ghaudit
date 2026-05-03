/**
 * Tool catalogue — the single dispatcher between the Agent Loop and the
 * collection of `AITool`s.
 *
 *   makeCatalog([tool, …]) ─▶ { openAITools, dispatch }
 *
 * `openAITools` is what we pass to `chat.completions.create({ tools })`.
 * `dispatch(call)` takes one LLM-issued tool call and runs it end-to-end:
 *
 *     1. look up the tool by name        → ToolUnknownError
 *     2. JSON-parse the raw arguments    → ToolInputJsonError
 *     3. Schema-decode the parsed value  → ToolInputParseError
 *     4. run the tool's `execute`        → ToolOutcome | tool-specific E
 *
 * Everything the loop has to know about a tool flows through this seam.
 * Adding a tool is one entry in the catalogue array — the dispatcher
 * doesn't change.
 *
 * `SessionContext` is the read-only thread of identifiers (sessionId,
 * optionally stepId) the loop hands tools that need to know "which
 * session / step are we in." Tools depend on it via `R`; the loop
 * provides it with `Layer.succeed(SessionContext, …)` per run.
 */
import { Context, Effect, ParseResult, Schema } from 'effect'
import type OpenAI from 'openai'
import {
  type ToolError,
  ToolInputJsonError,
  ToolInputParseError,
  ToolUnknownError,
} from '~/shared/domain/errors'
import {
  type AITool,
  type ToolOutcome,
  toOpenAITool,
} from '~/shared/infra/ai/tool'

/* ------------------------------------------------------------------ *
 * SessionContext — provided by the Loop, consumed by Tools
 * ------------------------------------------------------------------ */

export class SessionContext extends Context.Tag('SessionContext')<
  SessionContext,
  {
    readonly sessionId: string
  }
>() {}

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

// Type-erased AITool used inside the dispatcher's Map. The public
// `makeCatalog` signature reconstructs the precise R/E unions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = AITool<Schema.Schema.Any, any, any>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolR<T> = T extends AITool<any, infer R, any> ? R : never
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolE<T> = T extends AITool<any, any, infer E> ? E : never

export interface ToolCatalog<R, E> {
  readonly openAITools: ReadonlyArray<OpenAI.ChatCompletionTool>
  readonly dispatch: (call: {
    readonly name: string
    readonly rawArguments: string
  }) => Effect.Effect<ToolOutcome, ToolError | E, R>
}

export const makeCatalog = <const Tools extends ReadonlyArray<AnyTool>>(
  tools: Tools,
): ToolCatalog<ToolR<Tools[number]>, ToolE<Tools[number]>> => {
  const map = new Map<string, AnyTool>(tools.map((t) => [t.name, t]))
  const openAITools = tools.map(toOpenAITool)

  const dispatch = (call: {
    readonly name: string
    readonly rawArguments: string
  }) =>
    Effect.gen(function* () {
      const tool = map.get(call.name)
      if (!tool) {
        return yield* new ToolUnknownError({ toolName: call.name })
      }

      const parsed = yield* Effect.try({
        try: () => JSON.parse(call.rawArguments) as unknown,
        catch: (cause) =>
          new ToolInputJsonError({
            toolName: call.name,
            raw: call.rawArguments,
            cause,
          }),
      })

      const decoded = yield* Schema.decodeUnknown(tool.inputSchema)(parsed).pipe(
        Effect.mapError(
          (cause: ParseResult.ParseError) =>
            new ToolInputParseError({
              toolName: call.name,
              raw: parsed,
              cause,
            }),
        ),
      )

      return yield* tool.execute(decoded)
    })

  return {
    openAITools,
    dispatch: dispatch as ToolCatalog<
      ToolR<Tools[number]>,
      ToolE<Tools[number]>
    >['dispatch'],
  }
}
