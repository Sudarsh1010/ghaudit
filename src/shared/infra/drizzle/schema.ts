import { sql } from 'drizzle-orm'
import { sqliteTable, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * Lifecycle of a Research Session.
 * The 5-state machine matures across slices; only `active`, `completed`,
 * `abandoned` are actually written by Slice 1.
 */
export enum ResearchSessionStatus {
  active = 'active',
  waitingForUser = 'waiting_for_user',
  finalising = 'finalising',
  completed = 'completed',
  abandoned = 'abandoned',
  failed = 'failed',
}

export enum ResearchStepStatus {
  success = 'success',
  failure = 'failure',
}

/**
 * One end-to-end interview producing one PRD.
 */
export const researchSessions = sqliteTable(
  'research_sessions',
  (schema) => ({
    id: schema.text({ length: 40 }).primaryKey(), // e.g. rs_xxxxxx
    initialPrompt: schema.text().notNull(),
    status: schema
      .text({
        mode: 'text',
        length: 20,
        enum: Object.values(ResearchSessionStatus) as [
          ResearchSessionStatus,
          ...ResearchSessionStatus[],
        ],
      })
      .notNull(),
    createdAt: schema
      .integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: schema
      .integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  }),
)

/**
 * Append-only log of every iteration of the Agent Loop for a Research
 * Session. Persists prompts, responses, tool calls and outcomes.
 */
export const researchSteps = sqliteTable('research_steps', (schema) => ({
  id: schema.integer().primaryKey({ autoIncrement: true }),
  sessionId: schema
    .text({ length: 40 })
    .notNull()
    .references(() => researchSessions.id, { onDelete: 'cascade' }),
  stepNumber: schema.integer().notNull(),
  toolName: schema.text(),
  llmPrompt: schema.text(),
  llmResponse: schema.text(),
  toolRequest: schema.text(),
  toolResponse: schema.text(),
  errorMessage: schema.text(),
  /**
   * Source-of-truth for SSE replay (Slice 5): the full encoded
   * `AgentEvent` (id + type + payload) as JSON. The other columns above
   * are kept for legibility and ad-hoc SQL — they're derived from this
   * one and not read by the app.
   */
  event: schema.text().notNull(),
  status: schema
    .text({
      mode: 'text',
      length: 7,
      enum: Object.values(ResearchStepStatus) as [
        ResearchStepStatus,
        ...ResearchStepStatus[],
      ],
    })
    .notNull(),
  createdAt: schema
    .integer({ mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}))

/**
 * Each HITL askQuestion call recorded with its recommended answer and the
 * user's eventual reply. Empty in Slice 1.
 */
export const researchQuestions = sqliteTable(
  'research_questions',
  (schema) => ({
    id: schema.text({ length: 40 }).primaryKey(),
    sessionId: schema
      .text({ length: 40 })
      .notNull()
      .references(() => researchSessions.id, { onDelete: 'cascade' }),
    stepId: schema
      .integer()
      .references(() => researchSteps.id, { onDelete: 'set null' }),
    question: schema.text().notNull(),
    recommendedAnswer: schema.text().notNull(),
    rationale: schema.text().notNull(),
    userReply: schema.text(),
    askedAt: schema
      .integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    answeredAt: schema.integer({ mode: 'timestamp' }),
  }),
)

/**
 * Glossary terms collected during the interview. Empty in Slice 1.
 */
export const researchGlossary = sqliteTable(
  'research_glossary',
  (schema) => ({
    id: schema.integer().primaryKey({ autoIncrement: true }),
    sessionId: schema
      .text({ length: 40 })
      .notNull()
      .references(() => researchSessions.id, { onDelete: 'cascade' }),
    term: schema.text().notNull(),
    definition: schema.text().notNull(),
    avoidTerms: schema.text(), // JSON array string
    createdAt: schema
      .integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  }),
)

/**
 * Open questions surfaced during the interview but deferred to the PRD's
 * Open Questions section. Empty in Slice 1.
 */
export const researchOpenQs = sqliteTable('research_open_qs', (schema) => ({
  id: schema.integer().primaryKey({ autoIncrement: true }),
  sessionId: schema
    .text({ length: 40 })
    .notNull()
    .references(() => researchSessions.id, { onDelete: 'cascade' }),
  question: schema.text().notNull(),
  context: schema.text(),
  createdAt: schema
    .integer({ mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}))

/**
 * Named sections of the PRD as the agent writes them via writeOutput.
 * Empty in Slice 1.
 */
export const prdSections = sqliteTable(
  'prd_sections',
  (schema) => ({
    id: schema.integer().primaryKey({ autoIncrement: true }),
    sessionId: schema
      .text({ length: 40 })
      .notNull()
      .references(() => researchSessions.id, { onDelete: 'cascade' }),
    section: schema.text().notNull(),
    content: schema.text().notNull(),
    updatedAt: schema
      .integer({ mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  }),
  (table) => [uniqueIndex('prd_sections_session_section_uq').on(
    table.sessionId,
    table.section,
  )],
)
