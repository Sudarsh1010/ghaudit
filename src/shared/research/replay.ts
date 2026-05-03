/**
 * `sessionEventStream` — composes "replay then live" for the SSE
 * endpoint (Slice 5).
 *
 * On every `GET /session/:id/stream`, the server hands us:
 *   - the session's `prompt` (in case the live loop has to start),
 *   - the `Last-Event-ID` the browser sent (default 0 if absent),
 *   - the `catalog` of agent tools.
 *
 * The stream emits, in order:
 *
 *   1. Every persisted event with `stepNumber > lastEventId`, decoded
 *      back into the original `AgentEvent` (same id, same type, same
 *      payload). This is the replay.
 *   2. If — and only if — the session is still `active`, the live
 *      `runLoop` continues from the next step number.
 *
 * If the session is paused (`waiting_for_user`) or terminal
 * (`completed`, `failed`, `abandoned`), only the replay runs. We don't
 * fire a fresh LLM call against a session that's already done its turn.
 */
import { Effect, Stream } from 'effect'
import type { LoopError, RepositoryError } from '~/shared/domain/errors'
import { Groq } from '~/shared/infra/groq/client'
import { ResearchRepository } from '~/shared/infra/drizzle/repository'
import { ResearchSessionStatus } from '~/shared/infra/drizzle/schema'
import { runLoop } from '~/shared/agent/loop'
import type { ToolCatalog } from '~/shared/agent/tools/catalog'
import type { AgentEvent } from '~/shared/sse/events'

export interface SessionEventStreamInput<R, E, R2, E2> {
  readonly prompt: string
  readonly sessionId: string
  readonly lastEventId: number
  readonly catalog: ToolCatalog<R, E>
  readonly model?: string
  readonly softCap?: number
  readonly hardCap?: number
  /**
   * Side effect for each *live* event — typically `appendStep`. Replayed
   * events are not handed to this callback because they're already in
   * the persisted log.
   */
  readonly persistLive: (event: AgentEvent) => Effect.Effect<void, E2, R2>
}

export const sessionEventStream = <R, E, R2, E2>(
  input: SessionEventStreamInput<R, E, R2, E2>,
): Stream.Stream<
  AgentEvent,
  LoopError | E | E2 | RepositoryError,
  R | R2 | Groq | ResearchRepository
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const repo = yield* ResearchRepository
      const replayed = yield* repo.getStepsAfter(
        input.sessionId,
        input.lastEventId,
      )
      const session = yield* repo.getSessionById(input.sessionId)

      const replayStream = Stream.fromIterable(replayed)

      if (session.status !== ResearchSessionStatus.active) {
        return replayStream
      }

      const maxId = replayed.reduce(
        (m, e) => (e.id > m ? e.id : m),
        input.lastEventId,
      )
      const liveStream = runLoop(
        {
          prompt: input.prompt,
          model: input.model,
          softCap: input.softCap,
          hardCap: input.hardCap,
          startStepNumber: maxId + 1,
        },
        input.catalog,
      ).pipe(Stream.tap(input.persistLive))
      return Stream.concat(replayStream, liveStream)
    }),
  )
