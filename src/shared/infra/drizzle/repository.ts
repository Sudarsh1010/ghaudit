/**
 * `ResearchRepository` — the persistence seam for everything Research-Session
 * shaped. Two adapters live behind the tag (`RepositoryD1Live` for Cloudflare
 * D1, `RepositoryInMemoryLive` for tests). The Durable Object and the Worker
 * entry talk to the tag exclusively — neither imports Drizzle.
 *
 * Locality: every `JSON.stringify` / `JSON.parse` for `userReply`, every
 * `eq/and/asc` builder call, and every `STATE_TO_DB` enum mapping live in
 * this file.
 *
 * Read paths decode rows through Effect Schemas (see `./schemas.ts`) so a
 * shape mismatch between Drizzle and the rest of the app surfaces as a
 * `RepositoryRowDecodeError` at the read boundary, not as a crash deeper
 * down.
 */
import { drizzle } from 'drizzle-orm/d1'
import { and, asc, eq, gt } from 'drizzle-orm'
import { Context, Effect, Layer, ParseResult, Ref, Schema } from 'effect'
import {
  type RepositoryError,
  RepositoryNotFound,
  RepositoryRowDecodeError,
  RepositoryUnknownError,
} from '~/shared/domain/errors'
import {
  prdSections,
  researchQuestions,
  researchSessions,
  researchSteps,
  ResearchSessionStatus,
  ResearchStepStatus,
} from './schema'
import {
  type Answer,
  AnswerJson,
  PrdSection,
  ResearchQuestion,
  ResearchSessionRow,
  type SessionStatus,
} from './schemas'
import { AgentEvent } from '~/shared/sse/events'

/* ------------------------------------------------------------------ *
 * Domain inputs (writes)
 * ------------------------------------------------------------------ */

export interface NewSession {
  readonly id: string
  readonly initialPrompt: string
  readonly status: SessionStatus
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * One persisted Research Step = one emitted `AgentEvent`. The repo
 * derives the legacy debug columns (`toolName`, `llmResponse`, etc.)
 * from `event` so they stay populated for ad-hoc SQL, but only the
 * `event` column is read back on the SSE replay path.
 */
export interface NewStep {
  readonly sessionId: string
  readonly event: AgentEvent
}

export interface NewQuestion {
  readonly id: string
  readonly sessionId: string
  readonly question: string
  readonly recommendedAnswer: string
  readonly rationale: string
}

export interface NewPrdSection {
  readonly sessionId: string
  readonly section: string
  readonly content: string
}

/* ------------------------------------------------------------------ *
 * Service tag
 * ------------------------------------------------------------------ */

export class ResearchRepository extends Context.Tag('ResearchRepository')<
  ResearchRepository,
  {
    readonly createSession: (
      input: NewSession,
    ) => Effect.Effect<void, RepositoryError>
    readonly setSessionStatus: (
      id: string,
      status: SessionStatus,
      updatedAt: Date,
    ) => Effect.Effect<void, RepositoryError>
    readonly getSessionById: (
      id: string,
    ) => Effect.Effect<ResearchSessionRow, RepositoryError>
    readonly appendStep: (input: NewStep) => Effect.Effect<void, RepositoryError>
    readonly getStepsAfter: (
      sessionId: string,
      lastEventId: number,
    ) => Effect.Effect<ReadonlyArray<AgentEvent>, RepositoryError>
    readonly recordQuestion: (
      input: NewQuestion,
    ) => Effect.Effect<void, RepositoryError>
    readonly findOpenQuestion: (
      sessionId: string,
      questionId: string,
    ) => Effect.Effect<ResearchQuestion, RepositoryError>
    readonly recordAnswer: (
      questionId: string,
      answer: Answer,
      answeredAt: Date,
    ) => Effect.Effect<void, RepositoryError>
    readonly upsertPrdSection: (
      input: NewPrdSection,
    ) => Effect.Effect<void, RepositoryError>
    readonly listPrdSections: (
      sessionId: string,
    ) => Effect.Effect<ReadonlyArray<PrdSection>, RepositoryError>
  }
>() {}

/* ------------------------------------------------------------------ *
 * Helpers shared by both adapters
 * ------------------------------------------------------------------ */

const tryDb = <A>(thunk: () => Promise<A>): Effect.Effect<A, RepositoryError> =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => new RepositoryUnknownError({ cause }),
  })

const decodeRow =
  <A, I>(schema: Schema.Schema<A, I>, entity: string) =>
  (row: unknown): Effect.Effect<A, RepositoryRowDecodeError> =>
    Schema.decodeUnknown(schema)(row).pipe(
      Effect.mapError(
        (cause: ParseResult.ParseError) =>
          new RepositoryRowDecodeError({ entity, cause }),
      ),
    )

const encodeAnswer = Schema.encodeSync(AnswerJson)

/**
 * Project an `AgentEvent` into the row-shape `research_steps` expects.
 * Centralised here so the D1 and in-memory adapters can't drift on the
 * derived columns. The encoded `event` JSON is the source of truth.
 */
const encodeAgentEvent = Schema.encodeSync(AgentEvent)
const decodeAgentEventUnknown = Schema.decodeUnknown(AgentEvent)
const decodeStepEvent = (raw: unknown): Effect.Effect<AgentEvent, RepositoryRowDecodeError> =>
  decodeAgentEventUnknown(raw).pipe(
    Effect.mapError(
      (cause: ParseResult.ParseError) =>
        new RepositoryRowDecodeError({ entity: 'ResearchStep.event', cause }),
    ),
  )

interface StepRowFields {
  readonly sessionId: string
  readonly stepNumber: number
  readonly toolName: string | null
  readonly llmResponse: string | null
  readonly toolRequest: string | null
  readonly toolResponse: string | null
  readonly status: ResearchStepStatus
  readonly event: string
}

const projectStep = (input: NewStep): StepRowFields => {
  const { event } = input
  const encoded = JSON.stringify(encodeAgentEvent(event))
  return {
    sessionId: input.sessionId,
    stepNumber: event.id,
    toolName: 'toolName' in event ? event.toolName : null,
    toolRequest:
      event.type === 'tool_invoked' ? JSON.stringify(event.args) : null,
    toolResponse:
      event.type === 'tool_result' ? JSON.stringify(event.result) : null,
    llmResponse:
      event.type === 'agent_thinking'
        ? event.text
        : event.type === 'done'
          ? event.finalText
          : null,
    status: ResearchStepStatus.success,
    event: encoded,
  }
}

const parseEventColumn = (
  raw: string,
): Effect.Effect<AgentEvent, RepositoryRowDecodeError> =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new RepositoryRowDecodeError({
        entity: 'ResearchStep.event',
        cause: cause as ParseResult.ParseError,
      }),
  }).pipe(Effect.flatMap(decodeStepEvent))

/* ------------------------------------------------------------------ *
 * D1 / Drizzle adapter
 * ------------------------------------------------------------------ */

export const RepositoryD1Live = (env: {
  D1: D1Database
}): Layer.Layer<ResearchRepository> =>
  Layer.succeed(ResearchRepository, makeD1(env))

const makeD1 = (env: { D1: D1Database }) => {
  const db = drizzle(env.D1, { casing: 'snake_case' })
  const decodeSession = decodeRow(ResearchSessionRow, 'ResearchSession')
  const decodeQuestion = decodeRow(ResearchQuestion, 'ResearchQuestion')
  const decodePrdSection = decodeRow(PrdSection, 'PrdSection')

  return ResearchRepository.of({
    createSession: (input) =>
      tryDb(async () => {
        await db.insert(researchSessions).values({
          id: input.id,
          initialPrompt: input.initialPrompt,
          status: input.status,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        })
      }),

    setSessionStatus: (id, status, updatedAt) =>
      tryDb(async () => {
        await db
          .update(researchSessions)
          .set({ status, updatedAt })
          .where(eq(researchSessions.id, id))
      }),

    getSessionById: (id) =>
      Effect.gen(function* () {
        const rows = yield* tryDb(() =>
          db
            .select()
            .from(researchSessions)
            .where(eq(researchSessions.id, id))
            .limit(1),
        )
        const row = rows[0]
        if (!row) {
          return yield* new RepositoryNotFound({ entity: 'ResearchSession', id })
        }
        return yield* decodeSession(row)
      }),

    appendStep: (input) =>
      tryDb(async () => {
        const row = projectStep(input)
        await db.insert(researchSteps).values(row)
      }),

    getStepsAfter: (sessionId, lastEventId) =>
      Effect.gen(function* () {
        const rows = yield* tryDb(() =>
          db
            .select({ event: researchSteps.event })
            .from(researchSteps)
            .where(
              and(
                eq(researchSteps.sessionId, sessionId),
                gt(researchSteps.stepNumber, lastEventId),
              ),
            )
            .orderBy(asc(researchSteps.stepNumber)),
        )
        return yield* Effect.forEach(rows, (r) => parseEventColumn(r.event))
      }),

    recordQuestion: (input) =>
      tryDb(async () => {
        await db.insert(researchQuestions).values({
          id: input.id,
          sessionId: input.sessionId,
          question: input.question,
          recommendedAnswer: input.recommendedAnswer,
          rationale: input.rationale,
        })
      }),

    findOpenQuestion: (sessionId, questionId) =>
      Effect.gen(function* () {
        const rows = yield* tryDb(() =>
          db
            .select()
            .from(researchQuestions)
            .where(
              and(
                eq(researchQuestions.id, questionId),
                eq(researchQuestions.sessionId, sessionId),
              ),
            )
            .limit(1),
        )
        const row = rows[0]
        if (!row) {
          return yield* new RepositoryNotFound({
            entity: 'ResearchQuestion',
            id: questionId,
          })
        }
        const decoded = yield* decodeQuestion(row)
        if (decoded.userReply !== null) {
          return yield* new RepositoryNotFound({
            entity: 'OpenResearchQuestion',
            id: questionId,
          })
        }
        return decoded
      }),

    recordAnswer: (questionId, answer, answeredAt) =>
      tryDb(async () => {
        await db
          .update(researchQuestions)
          .set({ userReply: encodeAnswer(answer), answeredAt })
          .where(eq(researchQuestions.id, questionId))
      }),

    upsertPrdSection: (input) =>
      tryDb(async () => {
        await db
          .insert(prdSections)
          .values({
            sessionId: input.sessionId,
            section: input.section,
            content: input.content,
          })
          .onConflictDoUpdate({
            target: [prdSections.sessionId, prdSections.section],
            set: { content: input.content, updatedAt: new Date() },
          })
      }),

    listPrdSections: (sessionId) =>
      Effect.gen(function* () {
        const rows = yield* tryDb(() =>
          db
            .select()
            .from(prdSections)
            .where(eq(prdSections.sessionId, sessionId))
            .orderBy(asc(prdSections.id)),
        )
        return yield* Effect.forEach(rows, (r) => decodePrdSection(r))
      }),
  })
}

/* ------------------------------------------------------------------ *
 * In-memory adapter (tests)
 *
 * Stores the *encoded* row shape (so `userReply` is a JSON string just
 * like in D1). Reads decode through the same Schemas the D1 adapter uses,
 * so the two adapters can't drift on parse semantics.
 * ------------------------------------------------------------------ */

interface RawQuestionRow {
  id: string
  sessionId: string
  stepId: number | null
  question: string
  recommendedAnswer: string
  rationale: string
  userReply: string | null
  askedAt: Date
  answeredAt: Date | null
}

interface RawPrdSectionRow {
  id: number
  sessionId: string
  section: string
  content: string
  updatedAt: Date
}

export const RepositoryInMemoryLive: Layer.Layer<ResearchRepository> =
  Layer.scoped(
    ResearchRepository,
    Effect.gen(function* () {
      const sessions = yield* Ref.make(
        new Map<string, ResearchSessionRow>(),
      )
      const steps = yield* Ref.make<Array<StepRowFields>>([])
      const questions = yield* Ref.make(new Map<string, RawQuestionRow>())
      const prdSeq = yield* Ref.make(0)
      const prdRows = yield* Ref.make<Array<RawPrdSectionRow>>([])

      const decodeQuestion = decodeRow(ResearchQuestion, 'ResearchQuestion')
      const decodePrdSection = decodeRow(PrdSection, 'PrdSection')

      return ResearchRepository.of({
        createSession: (input) =>
          Ref.update(sessions, (m) => {
            const next = new Map(m)
            next.set(input.id, {
              id: input.id,
              initialPrompt: input.initialPrompt,
              status: input.status,
              createdAt: input.createdAt,
              updatedAt: input.updatedAt,
            })
            return next
          }),

        setSessionStatus: (id, status, updatedAt) =>
          Effect.gen(function* () {
            const m = yield* Ref.get(sessions)
            const row = m.get(id)
            if (!row) {
              return yield* new RepositoryNotFound({
                entity: 'ResearchSession',
                id,
              })
            }
            yield* Ref.update(sessions, (cur) =>
              new Map(cur).set(id, { ...row, status, updatedAt }),
            )
          }),

        getSessionById: (id) =>
          Effect.gen(function* () {
            const m = yield* Ref.get(sessions)
            const row = m.get(id)
            if (!row) {
              return yield* new RepositoryNotFound({
                entity: 'ResearchSession',
                id,
              })
            }
            return row
          }),

        appendStep: (input) =>
          Ref.update(steps, (arr) => [...arr, projectStep(input)]),

        getStepsAfter: (sessionId, lastEventId) =>
          Effect.gen(function* () {
            const arr = yield* Ref.get(steps)
            const filtered = arr
              .filter(
                (r) => r.sessionId === sessionId && r.stepNumber > lastEventId,
              )
              .sort((a, b) => a.stepNumber - b.stepNumber)
            return yield* Effect.forEach(filtered, (r) =>
              parseEventColumn(r.event),
            )
          }),

        recordQuestion: (input) =>
          Ref.update(questions, (m) => {
            const next = new Map(m)
            next.set(input.id, {
              id: input.id,
              sessionId: input.sessionId,
              stepId: null,
              question: input.question,
              recommendedAnswer: input.recommendedAnswer,
              rationale: input.rationale,
              userReply: null,
              askedAt: new Date(),
              answeredAt: null,
            })
            return next
          }),

        findOpenQuestion: (sessionId, questionId) =>
          Effect.gen(function* () {
            const m = yield* Ref.get(questions)
            const row = m.get(questionId)
            if (!row || row.sessionId !== sessionId) {
              return yield* new RepositoryNotFound({
                entity: 'ResearchQuestion',
                id: questionId,
              })
            }
            const decoded = yield* decodeQuestion(row)
            if (decoded.userReply !== null) {
              return yield* new RepositoryNotFound({
                entity: 'OpenResearchQuestion',
                id: questionId,
              })
            }
            return decoded
          }),

        recordAnswer: (questionId, answer, answeredAt) =>
          Effect.gen(function* () {
            const m = yield* Ref.get(questions)
            const row = m.get(questionId)
            if (!row) {
              return yield* new RepositoryNotFound({
                entity: 'ResearchQuestion',
                id: questionId,
              })
            }
            yield* Ref.update(questions, (cur) =>
              new Map(cur).set(questionId, {
                ...row,
                userReply: encodeAnswer(answer),
                answeredAt,
              }),
            )
          }),

        upsertPrdSection: (input) =>
          Effect.gen(function* () {
            const arr = yield* Ref.get(prdRows)
            const existing = arr.find(
              (r) =>
                r.sessionId === input.sessionId && r.section === input.section,
            )
            if (existing) {
              yield* Ref.update(prdRows, (cur) =>
                cur.map((r) =>
                  r === existing
                    ? { ...r, content: input.content, updatedAt: new Date() }
                    : r,
                ),
              )
            } else {
              const id = yield* Ref.modify(prdSeq, (n) => [n + 1, n + 1])
              yield* Ref.update(prdRows, (cur) => [
                ...cur,
                {
                  id,
                  sessionId: input.sessionId,
                  section: input.section,
                  content: input.content,
                  updatedAt: new Date(),
                },
              ])
            }
          }),

        listPrdSections: (sessionId) =>
          Effect.gen(function* () {
            const arr = yield* Ref.get(prdRows)
            const filtered = arr
              .filter((r) => r.sessionId === sessionId)
              .sort((a, b) => a.id - b.id)
            return yield* Effect.forEach(filtered, (r) => decodePrdSection(r))
          }),
      })
    }),
  )

export { ResearchSessionStatus }
