/**
 * Durable Object — one Research Session per instance, keyed by session id.
 *
 * Effect runtime lives at the request boundary: every endpoint compiles
 * an `Effect<Response, AppError, R>` program and runs it through
 * `Effect.runPromise` after providing the live layer. Below the
 * boundary, every method is an Effect — there's no `try/catch`, no
 * `await`, no untyped failures.
 *
 * Endpoints:
 *   POST /stream  — start the Agent Loop, return SSE response
 *   POST /answer  — record the user's reply to an open question
 *   GET  /prd     — assemble the finished PRD as Markdown
 *
 * In-memory state (`this.state`, `this.nextStepNumber`) is the DO's
 * authoritative cache of the session row; D1 is the durable copy.
 */
import type { worker } from '../../alchemy.run'
import { DurableObject } from 'cloudflare:workers'
import {
  Cause,
  Clock,
  Effect,
  Layer,
  ParseResult,
  Ref,
  Schema,
  Stream,
} from 'effect'
import {
  type AppError,
  Conflict,
  SchemaViolation,
  statusForError,
} from '~/shared/domain/errors'
import { makeCatalog, SessionContext } from '~/shared/agent/tools/catalog'
import { builtinTools } from '~/shared/agent/tools/builtin'
import { sessionEventStream } from '~/shared/research/replay'
import { ResearchRepository } from '~/shared/infra/drizzle/repository'
import { ResearchSessionStatus } from '~/shared/infra/drizzle/schema'
import { Answer } from '~/shared/infra/drizzle/schemas'
import {
  type SessionEvent,
  type SessionState,
  transition,
} from '~/shared/session/state-machine'
import { encode, type AgentEvent } from '~/shared/sse/events'
import { MainLive } from '~/shared/runtime/main'

/* ------------------------------------------------------------------ *
 * Request schemas
 * ------------------------------------------------------------------ */

const StreamRequest = Schema.Struct({
  prompt: Schema.String,
  /**
   * The browser's `Last-Event-ID` (forwarded by the worker entry).
   * Defaults to 0 — meaning replay everything if the session has any
   * persisted events, otherwise start fresh.
   */
  lastEventId: Schema.optional(Schema.Number),
})

const AnswerRequest = Schema.Struct({
  questionId: Schema.String,
  kind: Schema.Literal('accept', 'reject', 'custom'),
  value: Schema.optional(Schema.String),
})

const decodeStreamRequest = Schema.decodeUnknown(StreamRequest)
const decodeAnswerRequest = Schema.decodeUnknown(AnswerRequest)

const STATE_TO_DB: Record<SessionState, ResearchSessionStatus> = {
  RUNNING: ResearchSessionStatus.active,
  WAITING_FOR_USER: ResearchSessionStatus.waitingForUser,
  COMPLETED: ResearchSessionStatus.completed,
  FAILED: ResearchSessionStatus.failed,
  ABANDONED: ResearchSessionStatus.abandoned,
}

/* ------------------------------------------------------------------ *
 * Durable Object
 * ------------------------------------------------------------------ */

export class ResearchDO extends DurableObject {
  declare env: typeof worker.Env

  private state: SessionState = 'RUNNING'
  private nextStepNumber = 1

  get sessionId(): string {
    return this.ctx.id.toString()
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/stream') {
      return this.dispatchStream(request)
    }
    if (request.method === 'POST' && url.pathname === '/answer') {
      return this.runWithLayer(this.handleAnswer(request))
    }
    if (request.method === 'GET' && url.pathname === '/prd') {
      return this.runWithLayer(this.assemblePrd())
    }
    return new Response('Not found', { status: 404 })
  }

  /* ---------------------------------------------------------------- *
   * Layer composition (per-request)
   * ---------------------------------------------------------------- */

  private layer() {
    const env = this.env as unknown as {
      D1: D1Database
      GROQ_API_KEY?: string
    }
    return Layer.merge(
      MainLive({
        D1: env.D1,
        groq: { apiKey: env.GROQ_API_KEY },
      }),
      Layer.succeed(SessionContext, { sessionId: this.sessionId }),
    )
  }

  private runWithLayer(
    program: Effect.Effect<Response, AppError, ResearchRepository>,
  ): Promise<Response> {
    return Effect.runPromise(
      program.pipe(
        Effect.catchAll((err) => Effect.succeed(toErrorResponse(err))),
        Effect.provide(this.layer()),
        Effect.catchAllCause((cause) =>
          Effect.succeed(
            new Response(`internal error: ${Cause.pretty(cause)}`, {
              status: 500,
            }),
          ),
        ),
      ),
    )
  }

  /* ---------------------------------------------------------------- *
   * /stream — start the Agent Loop, write SSE frames as they arrive
   * ---------------------------------------------------------------- */

  private async dispatchStream(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as unknown
    const decoded = await Effect.runPromise(
      decodeStreamRequest(body).pipe(
        Effect.either,
      ),
    )
    if (decoded._tag === 'Left') {
      return toErrorResponse(new SchemaViolation({ cause: decoded.left }))
    }

    return this.openStream(decoded.right.prompt, decoded.right.lastEventId ?? 0)
  }

  private openStream(prompt: string, lastEventId: number): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()
    const sessionId = this.sessionId

    const program = Effect.gen(this, function* (this: ResearchDO) {
      const repo = yield* ResearchRepository
      const catalog = makeCatalog(builtinTools)
      const lastEventTypeRef = yield* Ref.make<AgentEvent['type'] | undefined>(
        undefined,
      )

      const persistStep = (event: AgentEvent) =>
        repo.appendStep({ sessionId, event })

      const writeFrame = (event: AgentEvent) =>
        Effect.promise(() => writer.write(encoder.encode(encode(event))))

      // sessionEventStream emits replay events first (already persisted —
      // we only write frames), then live events (which run through
      // `persistLive`). Frame writes happen for both so the browser sees
      // a continuous stream from `lastEventId + 1` onwards.
      yield* sessionEventStream({
        prompt,
        sessionId,
        lastEventId,
        catalog,
        persistLive: persistStep,
      }).pipe(
        Stream.tap((event) =>
          Effect.gen(this, function* (this: ResearchDO) {
            yield* writeFrame(event)
            yield* Ref.set(lastEventTypeRef, event.type)
            if (event.id + 1 > this.nextStepNumber) {
              this.nextStepNumber = event.id + 1
            }
          }),
        ),
        Stream.runDrain,
      )

      const lastType = yield* Ref.get(lastEventTypeRef)
      const transitionEvent: SessionEvent =
        lastType === 'question_asked' ? 'askQuestion' : 'finalize'
      yield* this.transitionTo(transitionEvent)
    })

    void Effect.runPromise(
      program.pipe(
        Effect.catchAllCause((cause) =>
          Effect.gen(this, function* (this: ResearchDO) {
            const summary = `error: ${Cause.pretty(cause)}`
            const event: AgentEvent = {
              id: this.nextStepNumber,
              type: 'done',
              finalText: summary,
            }
            this.nextStepNumber++
            yield* Effect.promise(() =>
              writer.write(encoder.encode(encode(event))).catch(() => {}),
            )
            yield* this.transitionTo('fail').pipe(Effect.ignore)
          }),
        ),
        Effect.provide(this.layer()),
        Effect.ensuring(
          Effect.promise(() => writer.close().catch(() => {})),
        ),
      ),
    )

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    })
  }

  /* ---------------------------------------------------------------- *
   * /answer — record the user's reply to an open question
   * ---------------------------------------------------------------- */

  private handleAnswer(
    request: Request,
  ): Effect.Effect<Response, AppError, ResearchRepository> {
    return Effect.gen(this, function* (this: ResearchDO) {
      if (this.state !== 'WAITING_FOR_USER') {
        return yield* new Conflict({
          reason: `cannot answer in state ${this.state}`,
        })
      }

      const raw = yield* Effect.tryPromise({
        try: () => request.json() as Promise<unknown>,
        catch: (cause) =>
          new SchemaViolation({
            cause: cause as ParseResult.ParseError,
          }),
      })

      const body = yield* decodeAnswerRequest(raw).pipe(
        Effect.mapError(
          (cause: ParseResult.ParseError) => new SchemaViolation({ cause }),
        ),
      )

      const repo = yield* ResearchRepository
      // Verify the question is open before recording — repo raises a
      // RepositoryNotFound (mapped to 404) if the question is missing
      // or already answered.
      yield* repo.findOpenQuestion(this.sessionId, body.questionId)

      const millis = yield* Clock.currentTimeMillis
      const now = new Date(millis)
      yield* repo.recordAnswer(
        body.questionId,
        Answer.make({ kind: body.kind, value: body.value }),
        now,
      )

      yield* this.transitionTo('answer')

      return Response.json({ ok: true, state: this.state })
    })
  }

  /* ---------------------------------------------------------------- *
   * /prd — assemble the PRD from prd_sections + initial prompt
   * ---------------------------------------------------------------- */

  private assemblePrd(): Effect.Effect<Response, AppError, ResearchRepository> {
    return Effect.gen(this, function* (this: ResearchDO) {
      const repo = yield* ResearchRepository
      const session = yield* repo.getSessionById(this.sessionId)

      if (session.status !== ResearchSessionStatus.completed) {
        return yield* new Conflict({
          reason: `PRD not ready (session is ${session.status}). Finalize the session first.`,
        })
      }

      const sections = yield* repo.listPrdSections(this.sessionId)
      const body = sections
        .map((s) => `## ${humanise(s.section)}\n\n${s.content}\n`)
        .join('\n')
      const md = `# PRD: ${session.initialPrompt}\n\n${body || '_(no sections written)_'}\n`

      return new Response(md, {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="prd-${this.sessionId}.md"`,
        },
      })
    })
  }

  /* ---------------------------------------------------------------- *
   * State transitions — invalid transitions are silent no-ops, same as
   * the pre-Effect code. (Surfacing every drop would crash the DO on
   * benign races; logging is the right escalation later.)
   * ---------------------------------------------------------------- */

  private transitionTo(
    event: SessionEvent,
  ): Effect.Effect<void, never, ResearchRepository> {
    return Effect.gen(this, function* (this: ResearchDO) {
      const next = yield* transition(this.state, event).pipe(
        Effect.orElseSucceed(() => this.state),
      )
      if (next === this.state) return
      const repo = yield* ResearchRepository
      const millis = yield* Clock.currentTimeMillis
      yield* repo
        .setSessionStatus(this.sessionId, STATE_TO_DB[next], new Date(millis))
        .pipe(Effect.ignore)
      this.state = next
    })
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const toErrorResponse = (err: AppError): Response =>
  Response.json(
    { error: err._tag, detail: ('reason' in err ? err.reason : undefined) },
    { status: statusForError(err) },
  )

const humanise = (slug: string): string =>
  slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
