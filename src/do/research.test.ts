/**
 * Direct DO tests for the alarm + hibernation seam.
 *
 * `cloudflare:workers` is unavailable in `environment: 'node'`; we
 * mock the `DurableObject` base class so we can construct the DO
 * with a hand-rolled `ctx`. The DO exposes a `protected layer()`
 * hook so the test subclass can swap in `RepositoryInMemoryLive`
 * for the `ResearchRepository` slot.
 *
 * Behaviours under test:
 *   - `alarm()` transitions the in-memory state to ABANDONED, writes
 *     a failure step row, sets the session row to `abandoned`, and
 *     pushes a `done` SSE frame to any active writer.
 *   - `transitionTo('askQuestion')` schedules `state.storage.setAlarm`
 *     24h out.
 *   - `transitionTo('answer')` clears the alarm via
 *     `state.storage.deleteAlarm`.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('cloudflare:workers', () => ({
  // The mock only needs to capture (ctx, env) on construction; everything
  // else the production base class does (sql storage, RPC machinery, etc.)
  // is irrelevant to these tests.
  DurableObject: class {
    declare ctx: unknown
    declare env: unknown
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

import { Effect, Layer, ManagedRuntime } from 'effect'
import {
  RepositoryInMemoryLive,
  ResearchRepository,
} from '~/shared/infra/drizzle/repository'
import {
  ResearchSessionStatus,
  ResearchStepStatus,
} from '~/shared/infra/drizzle/schema'
import { ResearchDO } from './research'
import { SessionContext } from '~/shared/agent/tools/catalog'
import { IdsTest } from '~/shared/domain/ids'
import { GroqStub } from '~/shared/infra/groq/client'
import type { SessionState } from '~/shared/session/state-machine'
import { ABANDON_REASON } from '~/shared/research/abandon'
import { decode, type AgentEvent } from '~/shared/sse/events'

/* ------------------------------------------------------------------ *
 * Test harness — constructs a DO with a fake ctx/env and an
 * in-memory repository layer.
 * ------------------------------------------------------------------ */

interface FakeStorage {
  setAlarm: ReturnType<typeof vi.fn>
  deleteAlarm: ReturnType<typeof vi.fn>
}

interface FakeCtx {
  id: { toString: () => string }
  storage: FakeStorage
}

const makeFakeCtx = (sessionId: string): FakeCtx => ({
  id: { toString: () => sessionId },
  storage: {
    setAlarm: vi.fn().mockResolvedValue(undefined),
    deleteAlarm: vi.fn().mockResolvedValue(undefined),
  },
})

/**
 * Per-test runtime: in-memory repository + deterministic ids + an empty
 * GroqStub (the alarm path doesn't talk to Groq) + per-instance
 * SessionContext. We use `ManagedRuntime` so `RepositoryInMemoryLive`'s
 * scoped store is materialised exactly once and reused across every
 * Effect run — both inside the DO methods and in the test's
 * observation queries.
 */
const buildTestLayer = (sessionId: string) =>
  Layer.mergeAll(
    RepositoryInMemoryLive,
    IdsTest,
    GroqStub.layer([]),
    Layer.succeed(SessionContext, { sessionId }),
  )

type TestRuntime = ManagedRuntime.ManagedRuntime<
  Layer.Layer.Success<ReturnType<typeof buildTestLayer>>,
  never
>

class TestableResearchDO extends ResearchDO {
  public testRuntime: TestRuntime | null = null

  protected override buildLayer() {
    // Unused at runtime — we override the runners below to dispatch
    // through `testRuntime` instead. Returning a layer here keeps the
    // base-class type happy.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return null as any
  }

  protected override runWithLayer(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    program: Effect.Effect<Response, any, any>,
  ): Promise<Response> {
    if (!this.testRuntime) throw new Error('testRuntime not set')
    return this.testRuntime.runPromise(
      program.pipe(
        Effect.catchAll(() =>
          Effect.succeed(new Response('error', { status: 500 })),
        ),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as Effect.Effect<Response, never, any>,
    )
  }

  protected override runWithLayerVoid(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    program: Effect.Effect<void, any, any>,
  ): Promise<void> {
    if (!this.testRuntime) throw new Error('testRuntime not set')
    return this.testRuntime.runPromise(
      program.pipe(
        Effect.catchAllCause(() => Effect.void),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as Effect.Effect<void, never, any>,
    )
  }
}

const makeDO = (sessionId: string) => {
  const ctx = makeFakeCtx(sessionId)
  const env = {} as unknown
  const instance = new TestableResearchDO(ctx as never, env as never)
  instance.testRuntime = ManagedRuntime.make(buildTestLayer(sessionId))
  return { instance, ctx }
}

/**
 * Test reach-arounds — the DO's `state` and `nextStepNumber` are
 * `private` in production. Test code reaches them via the protected
 * accessors below (added solely to keep production fields readable
 * from a subclass without widening the public surface).
 */
const setState = (do_: TestableResearchDO, state: SessionState): void => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(do_ as any).state = state
}
const getState = (do_: TestableResearchDO): SessionState =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (do_ as any).state
const setNextStepNumber = (do_: TestableResearchDO, n: number): void => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(do_ as any).nextStepNumber = n
}

/* ------------------------------------------------------------------ *
 * Reading the in-memory repo back through the same layer the DO uses
 * ------------------------------------------------------------------ */

const observe = <A>(
  do_: TestableResearchDO,
  program: Effect.Effect<A, unknown, ResearchRepository>,
): Promise<A> => {
  if (!do_.testRuntime) throw new Error('testRuntime not set')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return do_.testRuntime.runPromise(program as any) as Promise<A>
}

describe('ResearchDO.alarm()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('transitions WAITING_FOR_USER → ABANDONED, persists a failure step, marks the session abandoned, and writes a done frame to the active SSE writer', async () => {
    const { instance } = makeDO('rs_alarm_1')

    // Seed: a session row already exists (the DO's `transitionTo`
    // expects to UPDATE not INSERT).
    await observe(
      instance,
      Effect.gen(function* () {
        const repo = yield* ResearchRepository
        yield* repo.createSession({
          id: 'rs_alarm_1',
          initialPrompt: 'p',
          status: ResearchSessionStatus.waitingForUser,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        })
      }),
    )

    // Mid-run: the user is mid-stream when the alarm fires. Connect a
    // writer so we can observe what `alarm()` emits to the wire.
    const stream = new TransformStream<Uint8Array, Uint8Array>()
    const writer = stream.writable.getWriter()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(instance as any).activeWriter = writer

    // Pre-conditions matching a session that paused on askQuestion:
    setState(instance, 'WAITING_FOR_USER')
    setNextStepNumber(instance, 4)

    // Drain the readable side concurrently — TransformStream's writer
    // applies backpressure if nobody is pulling, which would deadlock
    // the alarm() write.
    const readerPromise = (async () => {
      const reader = stream.readable.getReader()
      const decoder = new TextDecoder()
      const chunks: Array<string> = []
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        chunks.push(decoder.decode(value))
      }
      return chunks.join('')
    })()

    await instance.alarm()

    // 1) In-memory state transitioned.
    expect(getState(instance)).toBe('ABANDONED')

    // 2) Session row flipped to abandoned.
    const session = await observe(
      instance,
      Effect.gen(function* () {
        const repo = yield* ResearchRepository
        return yield* repo.getSessionById('rs_alarm_1')
      }),
    )
    expect(session.status).toBe(ResearchSessionStatus.abandoned)

    // 3) A failure step row carries the reason.
    const steps = await observe(
      instance,
      Effect.gen(function* () {
        const repo = yield* ResearchRepository
        return yield* repo.listStepsBySession('rs_alarm_1')
      }),
    )
    expect(steps).toHaveLength(1)
    expect(steps[0]!.status).toBe(ResearchStepStatus.failure)
    expect(steps[0]!.errorMessage).toBe(ABANDON_REASON)
    expect(steps[0]!.stepNumber).toBe(4)

    // 4) The active SSE writer received a `done` frame with status
    //    'abandoned', and the writer was closed.
    const wire = await readerPromise
    const event = await Effect.runPromise(decode(wire))
    const done = event as AgentEvent
    if (done.type !== 'done') throw new Error('expected done event')
    expect(done.status).toBe('abandoned')
    expect(done.finalText).toBe(ABANDON_REASON)
    expect(done.id).toBe(4)
  })

  it('is a no-op for terminal states (alarm racing answer)', async () => {
    const { instance } = makeDO('rs_alarm_2')
    await observe(
      instance,
      Effect.gen(function* () {
        const repo = yield* ResearchRepository
        yield* repo.createSession({
          id: 'rs_alarm_2',
          initialPrompt: 'p',
          status: ResearchSessionStatus.completed,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        })
      }),
    )
    setState(instance, 'COMPLETED')

    await instance.alarm()

    expect(getState(instance)).toBe('COMPLETED')
    const session = await observe(
      instance,
      Effect.gen(function* () {
        const repo = yield* ResearchRepository
        return yield* repo.getSessionById('rs_alarm_2')
      }),
    )
    expect(session.status).toBe(ResearchSessionStatus.completed)
    const steps = await observe(
      instance,
      Effect.gen(function* () {
        const repo = yield* ResearchRepository
        return yield* repo.listStepsBySession('rs_alarm_2')
      }),
    )
    expect(steps).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ *
 * Alarm-scheduling on FSM transitions
 *
 * The DO calls `state.storage.setAlarm(now + 24h)` when the session
 * enters `WAITING_FOR_USER`, and `state.storage.deleteAlarm()` when it
 * leaves on `answer` (back to RUNNING). The alarm itself is what
 * drives the abandon path; `transition('abandon')` doesn't need to
 * cancel it because that only fires from the alarm handler.
 * ------------------------------------------------------------------ */

describe('ResearchDO alarm scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('schedules a 24h alarm on transition into WAITING_FOR_USER', async () => {
    const { instance, ctx } = makeDO('rs_sched_1')
    await observe(
      instance,
      Effect.gen(function* () {
        const repo = yield* ResearchRepository
        yield* repo.createSession({
          id: 'rs_sched_1',
          initialPrompt: 'p',
          status: ResearchSessionStatus.active,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        })
      }),
    )
    setState(instance, 'RUNNING')

    // Trigger the `askQuestion` transition (RUNNING → WAITING_FOR_USER).
    const before = Date.now()
    await observe(
      instance,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (instance as any).transitionTo('askQuestion'),
    )
    const after = Date.now()

    expect(getState(instance)).toBe('WAITING_FOR_USER')
    expect(ctx.storage.setAlarm).toHaveBeenCalledTimes(1)
    const alarmAt = ctx.storage.setAlarm.mock.calls[0]![0] as number
    const day = 24 * 60 * 60 * 1000
    expect(alarmAt).toBeGreaterThanOrEqual(before + day)
    expect(alarmAt).toBeLessThanOrEqual(after + day)
    expect(ctx.storage.deleteAlarm).not.toHaveBeenCalled()
  })

  it('clears the alarm on transition WAITING_FOR_USER → RUNNING (answer)', async () => {
    const { instance, ctx } = makeDO('rs_sched_2')
    await observe(
      instance,
      Effect.gen(function* () {
        const repo = yield* ResearchRepository
        yield* repo.createSession({
          id: 'rs_sched_2',
          initialPrompt: 'p',
          status: ResearchSessionStatus.waitingForUser,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        })
      }),
    )
    setState(instance, 'WAITING_FOR_USER')

    await observe(
      instance,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (instance as any).transitionTo('answer'),
    )

    expect(getState(instance)).toBe('RUNNING')
    expect(ctx.storage.deleteAlarm).toHaveBeenCalledTimes(1)
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled()
  })
})
