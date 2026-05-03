/**
 * Slice 12 — failure persistence tests.
 *
 * Drives the agent loop through a pipeline that mirrors what the Durable
 * Object does in production:
 *
 *   1. Run the loop, threading each emitted `AgentEvent` through
 *      `persistStepForEvent` (writes the step row).
 *   2. After the stream drains, look at the *last* event and call
 *      `transitionEventForLastEvent` to derive the FSM event the host
 *      should fire.
 *   3. Apply that transition to a `Ref<SessionState>` and persist the new
 *      session status through the same in-memory repo.
 *
 * The DO has the same exact two-step pipeline; testing it here lets us
 * assert on persisted side-effects without standing up a real DO.
 */
import { describe, it, expect } from '@effect/vitest'
import { Chunk, Clock, Effect, Layer, Ref, Stream } from 'effect'
import type OpenAI from 'openai'
import { IdsTest } from '~/shared/domain/ids'
import { GroqRateLimitError } from '~/shared/domain/errors'
import { BraveStub } from '~/shared/infra/brave/client'
import { Context7Stub } from '~/shared/infra/context7/client'
import { UrlFetcherStub } from '~/shared/infra/url-fetcher/client'
import { GroqStub, type GroqStubTurn } from '~/shared/infra/groq/client'
import {
  RepositoryInMemoryLive,
  ResearchRepository,
} from '~/shared/infra/drizzle/repository'
import {
  ResearchSessionStatus,
  ResearchStepStatus,
} from '~/shared/infra/drizzle/schema'
import { runLoop } from '~/shared/agent/loop'
import { makeCatalog, SessionContext } from '~/shared/agent/tools/catalog'
import { builtinTools } from '~/shared/agent/tools/builtin'
import {
  type SessionEvent,
  type SessionState,
  transition,
} from '~/shared/session/state-machine'
import {
  STATE_TO_DB,
  persistStepForEvent,
  transitionEventForLastEvent,
} from './orchestrator'
import type { AgentEvent } from '~/shared/sse/events'

const SessionFixed = Layer.succeed(SessionContext, { sessionId: 'rs_fail' })

// Empty research-tool stubs — these tests don't drive the search path, so
// nothing needs canned responses; we just have to satisfy the requirements
// the catalog declares (Slice 11 added them).
const TestEnv = Layer.mergeAll(
  RepositoryInMemoryLive,
  IdsTest,
  SessionFixed,
  BraveStub.layer([]),
  Context7Stub.layer({}),
  UrlFetcherStub.layer([]),
)

const catalog = makeCatalog(builtinTools)

const completion = (
  cmplId: string,
  opts: {
    content?: string
    toolCalls?: ReadonlyArray<{
      id: string
      name: string
      args: Record<string, unknown>
    }>
  },
): OpenAI.ChatCompletion =>
  ({
    id: cmplId,
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: opts.content ?? '',
          refusal: null,
          tool_calls: opts.toolCalls?.map((c) => ({
            id: c.id,
            type: 'function',
            function: {
              name: c.name,
              arguments: JSON.stringify(c.args),
            },
          })),
        },
        finish_reason: opts.toolCalls ? 'tool_calls' : 'stop',
        logprobs: null,
      },
    ],
  }) as OpenAI.ChatCompletion

/**
 * Drive the loop, persist each event through the orchestrator, then run
 * the terminal transition. Returns the collected events for downstream
 * assertions.
 */
const driveAndPersist = (
  sessionId: string,
  groqLayer: ReturnType<typeof GroqStub.layer>,
) =>
  Effect.gen(function* () {
    const repo = yield* ResearchRepository
    const stateRef = yield* Ref.make<SessionState>('RUNNING')
    const lastEventRef = yield* Ref.make<AgentEvent | undefined>(undefined)

    // Seed an active session row so the FAILED transition has something to
    // update.
    const millis0 = yield* Clock.currentTimeMillis
    yield* repo.createSession({
      id: sessionId,
      initialPrompt: 'go',
      status: ResearchSessionStatus.active,
      ownerId: 'owner_test',
      createdAt: new Date(millis0),
      updatedAt: new Date(millis0),
    })

    const events = yield* Stream.runCollect(
      runLoop({ prompt: 'go', groqRetryBaseDelayMs: 1 }, catalog).pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            yield* persistStepForEvent(sessionId, event)
            yield* Ref.set(lastEventRef, event)
          }),
        ),
      ),
    ).pipe(Effect.provide(groqLayer))

    const last = yield* Ref.get(lastEventRef)
    const transitionEvent: SessionEvent | undefined =
      last !== undefined ? transitionEventForLastEvent(last) : undefined
    if (transitionEvent !== undefined) {
      const current = yield* Ref.get(stateRef)
      const next = yield* transition(current, transitionEvent).pipe(
        Effect.orElseSucceed(() => current),
      )
      if (next !== current) {
        const millis1 = yield* Clock.currentTimeMillis
        yield* repo.setSessionStatus(
          sessionId,
          STATE_TO_DB[next],
          new Date(millis1),
        )
        yield* Ref.set(stateRef, next)
      }
    }

    return {
      events: Chunk.toReadonlyArray(events) as ReadonlyArray<AgentEvent>,
      finalState: yield* Ref.get(stateRef),
    }
  })

describe('research orchestrator (slice 12)', () => {
  it.live(
    'persists a failure step + transitions to FAILED on terminal error/failed',
    () =>
      Effect.gen(function* () {
        // 4 rate-limit responses → loop emits 3 retry events + 1 failed event,
        // then halts.
        const turns: ReadonlyArray<GroqStubTurn> = [
          { _err: new GroqRateLimitError({}) },
          { _err: new GroqRateLimitError({}) },
          { _err: new GroqRateLimitError({}) },
          { _err: new GroqRateLimitError({}) },
        ]

        const { events, finalState } = yield* driveAndPersist(
          'rs_fail',
          GroqStub.layer(turns),
        )

        // Sanity: loop produced an error/failed event last.
        const last = events[events.length - 1]!
        if (last.type !== 'error') throw new Error('expected error tail')
        expect(last.kind).toBe('failed')

        // FSM moved to FAILED.
        expect(finalState).toBe('FAILED')

        // Repo: session row reflects the FAILED state.
        const repo = yield* ResearchRepository
        const row = yield* repo.getSessionById('rs_fail')
        expect(row.status).toBe(ResearchSessionStatus.failed)

        // Repo: at least one step row written with status=failure and a
        // non-null error message.
        const steps = yield* repo.listStepsBySession('rs_fail')
        const failure = steps.find(
          (s) => s.status === ResearchStepStatus.failure,
        )
        expect(failure).toBeDefined()
        expect(failure?.errorMessage).toMatch(/rate.?limit|429|retries exhausted/i)

        // Each retry event also persisted (with status=success, since the
        // loop is mid-recovery), and carries the reason.
        const retries = steps.filter(
          (s) =>
            s.status === ResearchStepStatus.success &&
            s.errorMessage !== null &&
            /rate.?limit|429/i.test(s.errorMessage ?? ''),
        )
        expect(retries.length).toBe(3)
      }).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    'transitions to COMPLETED on terminal done event (happy path)',
    () =>
      Effect.gen(function* () {
        const turns: ReadonlyArray<GroqStubTurn> = [
          completion('c1', {
            toolCalls: [
              { id: 'tc1', name: 'finalize', args: { summary: 'shipped' } },
            ],
          }),
        ]

        const { finalState } = yield* driveAndPersist(
          'rs_ok',
          GroqStub.layer(turns),
        )
        expect(finalState).toBe('COMPLETED')

        const repo = yield* ResearchRepository
        const row = yield* repo.getSessionById('rs_ok')
        expect(row.status).toBe(ResearchSessionStatus.completed)
      }).pipe(Effect.provide(TestEnv)),
  )

  it.effect(
    'transitions to WAITING_FOR_USER on terminal question_asked event',
    () =>
      Effect.gen(function* () {
        const turns: ReadonlyArray<GroqStubTurn> = [
          completion('c1', {
            toolCalls: [
              {
                id: 'tc1',
                name: 'askQuestion',
                args: {
                  question: 'TTL?',
                  recommendation: '5min',
                  rationale: 'hot reads',
                },
              },
            ],
          }),
        ]

        const { finalState } = yield* driveAndPersist(
          'rs_pause',
          GroqStub.layer(turns),
        )
        expect(finalState).toBe('WAITING_FOR_USER')

        const repo = yield* ResearchRepository
        const row = yield* repo.getSessionById('rs_pause')
        expect(row.status).toBe(ResearchSessionStatus.waitingForUser)
      }).pipe(Effect.provide(TestEnv)),
  )
})
