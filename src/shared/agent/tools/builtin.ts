/**
 * Built-in tool definitions — the four tools the Agent Loop ships with.
 *
 *   - `echoTool`         — diagnostic; replays its argument back to the LLM.
 *   - `askQuestionTool`  — HITL pause; persists a Question and signals the
 *                          loop to wait for the user.
 *   - `writeOutputTool`  — appends/overwrites a PRD section.
 *   - `finalizeTool`     — closes the session.
 *
 * Each tool's input shape is an Effect Schema so the dispatcher can
 * decode raw JSON arguments before `execute` runs. The Schemas are also
 * what `toOpenAITool` serialises into the JSON Schema we hand to the
 * model — so the model and the dispatcher can never disagree on field
 * names or required fields.
 */
import { Effect, Schema } from 'effect'
import { Ids } from '~/shared/domain/ids'
import { ResearchRepository } from '~/shared/infra/drizzle/repository'
import {
  Continue,
  defineTool,
  Finalise,
  Pause,
  WroteOutput,
} from '~/shared/infra/ai/tool'
import { SessionContext } from './catalog'

/* ------------------------------------------------------------------ *
 * echo
 * ------------------------------------------------------------------ */

const EchoInput = Schema.Struct({
  text: Schema.String,
})

export const echoTool = defineTool({
  name: 'echo',
  description: 'Echoes the supplied text back to the caller verbatim.',
  inputSchema: EchoInput,
  execute: (input) => Effect.succeed(Continue({ text: input.text })),
})

/* ------------------------------------------------------------------ *
 * askQuestion
 * ------------------------------------------------------------------ */

const AskQuestionInput = Schema.Struct({
  question: Schema.String,
  recommendation: Schema.String,
  rationale: Schema.String,
})

export const askQuestionTool = defineTool({
  name: 'askQuestion',
  description:
    'Pause the loop and ask the user a single question. Always include your own recommendation and rationale.',
  inputSchema: AskQuestionInput,
  execute: (input) =>
    Effect.gen(function* () {
      const ids = yield* Ids
      const repo = yield* ResearchRepository
      const ctx = yield* SessionContext
      const id = yield* ids.mint('q_')
      yield* repo.recordQuestion({
        id,
        sessionId: ctx.sessionId,
        question: input.question,
        recommendedAnswer: input.recommendation,
        rationale: input.rationale,
      })
      return Pause({
        questionId: id,
        question: input.question,
        recommendation: input.recommendation,
        rationale: input.rationale,
      })
    }),
})

/* ------------------------------------------------------------------ *
 * writeOutput
 * ------------------------------------------------------------------ */

const WriteOutputInput = Schema.Struct({
  kind: Schema.Literal('prd_section'),
  section: Schema.String,
  content: Schema.String,
})

export const writeOutputTool = defineTool({
  name: 'writeOutput',
  description:
    'Write a section of the PRD. The only kind currently supported is `prd_section`.',
  inputSchema: WriteOutputInput,
  execute: (input) =>
    Effect.gen(function* () {
      const repo = yield* ResearchRepository
      const ctx = yield* SessionContext
      yield* repo.upsertPrdSection({
        sessionId: ctx.sessionId,
        section: input.section,
        content: input.content,
      })
      return WroteOutput({ section: input.section, content: input.content })
    }),
})

/* ------------------------------------------------------------------ *
 * finalize
 * ------------------------------------------------------------------ */

const FinalizeInput = Schema.Struct({
  summary: Schema.String,
})

export const finalizeTool = defineTool({
  name: 'finalize',
  description:
    'Close the Research Session and ship the PRD. Call this only after every section is written.',
  inputSchema: FinalizeInput,
  execute: (input) => Effect.succeed(Finalise(input.summary)),
})

/* ------------------------------------------------------------------ *
 * Default catalogue contents
 * ------------------------------------------------------------------ */

export const builtinTools = [
  echoTool,
  askQuestionTool,
  writeOutputTool,
  finalizeTool,
] as const
