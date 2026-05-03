/**
 * Effect Schemas mirroring the Drizzle table shapes in `./schema.ts`.
 *
 * Drizzle stays the source of truth for migrations and the query DSL;
 * these Schemas are what the Repository decodes selected rows through, so
 * the rest of the app sees parsed-and-validated domain objects (e.g.
 * `userReply` arrives as `Answer`, not as the JSON string the column
 * holds).
 *
 * If a column is added to Drizzle and not mirrored here, the
 * `repository.test.ts` shape-equivalence assertions will catch it.
 */
import { Schema } from 'effect'
import {
  ResearchSessionStatus,
  ResearchStepStatus,
} from '~/shared/infra/drizzle/schema'

/* ------------------------------------------------------------------ *
 * Domain values
 * ------------------------------------------------------------------ */

export const SessionStatusSchema = Schema.Literal(
  ResearchSessionStatus.active,
  ResearchSessionStatus.waitingForUser,
  ResearchSessionStatus.finalising,
  ResearchSessionStatus.completed,
  ResearchSessionStatus.abandoned,
  ResearchSessionStatus.failed,
)
export type SessionStatus = Schema.Schema.Type<typeof SessionStatusSchema>

export const StepStatusSchema = Schema.Literal(
  ResearchStepStatus.success,
  ResearchStepStatus.failure,
)
export type StepStatus = Schema.Schema.Type<typeof StepStatusSchema>

/* ------------------------------------------------------------------ *
 * Answer (the user's reply to a Question)
 *
 * Stored in research_questions.user_reply as a JSON string. Decoded into
 * this struct on the read path via Schema.parseJson.
 * ------------------------------------------------------------------ */

export const AnswerKind = Schema.Literal('accept', 'reject', 'custom')
export type AnswerKind = Schema.Schema.Type<typeof AnswerKind>

export const Answer = Schema.Struct({
  kind: AnswerKind,
  value: Schema.optional(Schema.String),
})
export type Answer = Schema.Schema.Type<typeof Answer>

/** Wire-encoded form of Answer (JSON string in the column). */
export const AnswerJson = Schema.parseJson(Answer)

/* ------------------------------------------------------------------ *
 * Row schemas
 * ------------------------------------------------------------------ */

export const ResearchSessionRow = Schema.Struct({
  id: Schema.String,
  initialPrompt: Schema.String,
  status: SessionStatusSchema,
  ownerId: Schema.String,
  createdAt: Schema.ValidDateFromSelf,
  updatedAt: Schema.ValidDateFromSelf,
})
export type ResearchSessionRow = Schema.Schema.Type<typeof ResearchSessionRow>

export const ResearchStepRow = Schema.Struct({
  id: Schema.Number,
  sessionId: Schema.String,
  stepNumber: Schema.Number,
  toolName: Schema.NullOr(Schema.String),
  llmPrompt: Schema.NullOr(Schema.String),
  llmResponse: Schema.NullOr(Schema.String),
  toolRequest: Schema.NullOr(Schema.String),
  toolResponse: Schema.NullOr(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
  status: StepStatusSchema,
  createdAt: Schema.ValidDateFromSelf,
})
export type ResearchStepRow = Schema.Schema.Type<typeof ResearchStepRow>

/**
 * Outward-facing `ResearchQuestion` — the JSON-encoded `userReply` column
 * decodes into a typed `Answer` value, so callers never see the raw
 * string.
 */
export const ResearchQuestion = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  stepId: Schema.NullOr(Schema.Number),
  question: Schema.String,
  recommendedAnswer: Schema.String,
  rationale: Schema.String,
  userReply: Schema.NullOr(AnswerJson),
  askedAt: Schema.ValidDateFromSelf,
  answeredAt: Schema.NullOr(Schema.ValidDateFromSelf),
})
export type ResearchQuestion = Schema.Schema.Type<typeof ResearchQuestion>

export const PrdSection = Schema.Struct({
  id: Schema.Number,
  sessionId: Schema.String,
  section: Schema.String,
  content: Schema.String,
  updatedAt: Schema.ValidDateFromSelf,
})
export type PrdSection = Schema.Schema.Type<typeof PrdSection>
