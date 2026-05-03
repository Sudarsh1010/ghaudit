/**
 * Use case: start a new Research Session.
 *
 * Mints an id, persists the row through `ResearchRepository`, and returns
 * the SSE URL the client should subscribe to. The Agent Loop is kicked
 * off when the client connects to that URL — not here.
 *
 * Wiring lives in `R`:
 *
 *   - `Ids`                    — id minting (live = web crypto, test = sequence)
 *   - `ResearchRepository`     — persistence seam
 *   - `EventStreamUrlBuilder`  — how to render the SSE URL (worker vs. DO
 *                                differ on absolute vs. relative)
 *   - `Effect`'s built-in `Clock` — `now()` so tests can advance time.
 */
import { Clock, Context, Effect } from 'effect'
import type { RepositoryError } from '~/shared/domain/errors'
import { Ids } from '~/shared/domain/ids'
import { ResearchRepository } from '~/shared/infra/drizzle/repository'
import { ResearchSessionStatus } from '~/shared/infra/drizzle/schema'

export interface CreateSessionInput {
  readonly initialPrompt: string
}

export interface CreateSessionOutput {
  readonly sessionId: string
  readonly eventStreamUrl: string
}

/**
 * Builds the URL the client subscribes to for live agent events.
 * Injected so the worker can pick absolute / relative shapes and tests
 * can assert on a stable value.
 */
export class EventStreamUrlBuilder extends Context.Tag('EventStreamUrlBuilder')<
  EventStreamUrlBuilder,
  {
    readonly build: (sessionId: string) => string
  }
>() {}

export const createSession = (
  input: CreateSessionInput,
): Effect.Effect<
  CreateSessionOutput,
  RepositoryError,
  ResearchRepository | Ids | EventStreamUrlBuilder
> =>
  Effect.gen(function* () {
    const ids = yield* Ids
    const repo = yield* ResearchRepository
    const urlBuilder = yield* EventStreamUrlBuilder

    const id = yield* ids.mint('rs_')
    const millis = yield* Clock.currentTimeMillis
    const now = new Date(millis)

    yield* repo.createSession({
      id,
      initialPrompt: input.initialPrompt,
      status: ResearchSessionStatus.active,
      createdAt: now,
      updatedAt: now,
    })

    return {
      sessionId: id,
      eventStreamUrl: urlBuilder.build(id),
    }
  })
