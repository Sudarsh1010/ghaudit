/**
 * HITL ask → answer → resume cycle, expressed as Effects.
 *
 * The pre-Effect file ran a `runStreamingTick` against a state machine
 * stub. The new shape:
 *
 *   - `runLoop` (a `Stream<AgentEvent>`) is the unit of work the agent
 *     performs each tick.
 *   - `transition` is the pure FSM; we drive it directly between ticks.
 *   - persistence is observed through the `ResearchRepository` —
 *     `recordQuestion` runs inside the askQuestion tool, then
 *     `recordAnswer` runs after the user replies.
 *
 * One in-memory repo is shared across the whole cycle so the question
 * really is "in the database" when we go to record the answer against
 * it.
 */
import { describe, it, expect } from '@effect/vitest'
import { Chunk, Clock, Effect, Layer, Stream } from 'effect'
import type OpenAI from 'openai'
import { IdsTest } from '~/shared/domain/ids'
import { GroqStub } from '~/shared/infra/groq/client'
import {
  RepositoryInMemoryLive,
  ResearchRepository,
} from '~/shared/infra/drizzle/repository'
import { runLoop } from '~/shared/agent/loop'
import { makeCatalog, SessionContext } from '~/shared/agent/tools/catalog'
import { builtinTools } from '~/shared/agent/tools/builtin'
import { Answer } from '~/shared/infra/drizzle/schemas'
import { transition } from '~/shared/session/state-machine'
import type { AgentEvent } from '~/shared/sse/events'

const SessionFixed = Layer.succeed(SessionContext, { sessionId: 's1' })

const askQuestionCompletion = (
  cmplId: string,
  toolCallId: string,
  q: { question: string; recommendation: string; rationale: string },
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
          content: '',
          refusal: null,
          tool_calls: [
            {
              id: toolCallId,
              type: 'function',
              function: {
                name: 'askQuestion',
                arguments: JSON.stringify(q),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
        logprobs: null,
      },
    ],
  }) as OpenAI.ChatCompletion

const finalCompletion = (cmplId: string, text: string): OpenAI.ChatCompletion =>
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
          content: text,
          refusal: null,
        },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
  }) as OpenAI.ChatCompletion

const catalog = makeCatalog(builtinTools)

describe('HITL ask → answer → resume', () => {
  it.effect('runs the full cycle and persists the question + answer', () =>
    Effect.gen(function* () {
      const repo = yield* ResearchRepository

      // Tick 1: agent asks a question (loop pauses).
      const events1 = yield* Stream.runCollect(
        runLoop({ prompt: 'design a cache' }, catalog),
      ).pipe(
        Effect.provide(
          GroqStub.layer([
            askQuestionCompletion('cmpl1', 'tc1', {
              question: 'TTL?',
              recommendation: '5 minutes',
              rationale: 'Hot reads dominate.',
            }),
          ]),
        ),
      )

      const arr1 = Chunk.toReadonlyArray(events1) as ReadonlyArray<AgentEvent>
      expect(arr1.map((e) => e.type)).toEqual([
        'agent_thinking',
        'tool_invoked',
        'question_asked',
      ])
      const last1 = arr1[arr1.length - 1]!
      if (last1.type !== 'question_asked') throw new Error('expected pause')
      expect(last1.questionId).toBe('q_0001')

      // FSM transitions: RUNNING → WAITING_FOR_USER.
      const afterAsk = yield* transition('RUNNING', 'askQuestion')
      expect(afterAsk).toBe('WAITING_FOR_USER')

      // The question is recorded and still open.
      const open = yield* repo.findOpenQuestion('s1', 'q_0001')
      expect(open.question).toBe('TTL?')
      expect(open.userReply).toBeNull()

      // User answers.
      const millis = yield* Clock.currentTimeMillis
      yield* repo.recordAnswer(
        'q_0001',
        Answer.make({ kind: 'accept' }),
        new Date(millis),
      )
      const afterAnswer = yield* transition(afterAsk, 'answer')
      expect(afterAnswer).toBe('RUNNING')

      // Tick 2: agent finalises with plain text (no tool calls).
      const events2 = yield* Stream.runCollect(
        runLoop(
          {
            prompt: 'continue, TTL=5min',
            startStepNumber: arr1.length + 1,
          },
          catalog,
        ),
      ).pipe(
        Effect.provide(GroqStub.layer([finalCompletion('cmpl2', 'all set')])),
      )

      const arr2 = Chunk.toReadonlyArray(events2) as ReadonlyArray<AgentEvent>
      expect(arr2.map((e) => e.type)).toEqual(['agent_thinking', 'done'])
      // Step numbers continue past tick 1.
      expect(arr2.map((e) => e.id)).toEqual([
        arr1.length + 1,
        arr1.length + 2,
      ])
      const last2 = arr2[arr2.length - 1]!
      if (last2.type !== 'done') throw new Error('expected done')
      expect(last2.finalText).toBe('all set')
    }).pipe(
      Effect.provide(
        Layer.mergeAll(RepositoryInMemoryLive, IdsTest, SessionFixed),
      ),
    ),
  )
})
