/**
 * Slice 4 happy path: 3-question session → PRD.
 *
 * The new loop is a `Stream<AgentEvent>` that pauses on `askQuestion`
 * and resumes on the next call. Tests stitch four runs together by
 * threading `startStepNumber` (the same way the DO does in production)
 * and a single in-memory repository across all four.
 *
 * Persistence is observable: the in-memory `ResearchRepository` keeps
 * `recordQuestion` and `upsertPrdSection` writes, and we re-read them
 * via `findOpenQuestion` / `listPrdSections` to verify the agent's
 * side-effects.
 */
import { describe, it, expect } from '@effect/vitest'
import { Chunk, Effect, Layer, Stream } from 'effect'
import type OpenAI from 'openai'
import { IdsTest } from '~/shared/domain/ids'
import { GroqStub } from '~/shared/infra/groq/client'
import {
  RepositoryInMemoryLive,
  ResearchRepository,
} from '~/shared/infra/drizzle/repository'
import { runLoop } from './loop'
import { makeCatalog, SessionContext } from './tools/catalog'
import { builtinTools } from './tools/builtin'
import type { AgentEvent } from '~/shared/sse/events'

const SessionFixed = Layer.succeed(SessionContext, { sessionId: 's' })

const askCall = (
  id: string,
  q: { question: string; recommendation: string; rationale: string },
) => ({
  id,
  type: 'function' as const,
  function: { name: 'askQuestion', arguments: JSON.stringify(q) },
})

const writeOutputCall = (id: string, section: string, content: string) => ({
  id,
  type: 'function' as const,
  function: {
    name: 'writeOutput',
    arguments: JSON.stringify({ kind: 'prd_section', section, content }),
  },
})

const finalizeCall = (id: string, summary: string) => ({
  id,
  type: 'function' as const,
  function: { name: 'finalize', arguments: JSON.stringify({ summary }) },
})

const completion = (
  cmplId: string,
  toolCalls: ReadonlyArray<OpenAI.ChatCompletionMessageToolCall>,
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
          tool_calls: toolCalls,
        },
        finish_reason: 'tool_calls',
        logprobs: null,
      },
    ],
  }) as OpenAI.ChatCompletion

const catalog = makeCatalog(builtinTools)

describe('Slice 4 happy path: 3-question session → PRD', () => {
  it.effect('runs 3 ticks with HITL pauses and ends with a finalized PRD', () =>
    // Single program: stable env (Repo, Ids, SessionContext) shared across
    // all four runs; each run swaps in its own GroqStub turn list.
    Effect.gen(function* () {
      const repo = yield* ResearchRepository

      const collect = (
        prompt: string,
        startStepNumber: number,
        turns: ReadonlyArray<OpenAI.ChatCompletion>,
      ) =>
        Stream.runCollect(
          runLoop({ prompt, startStepNumber }, catalog),
        ).pipe(Effect.provide(GroqStub.layer(turns)))

      // Tick 1.
      const t1 = yield* collect('Build me a CLI dark mode toggler', 1, [
        completion('c1', [
          askCall('tc1', {
            question: 'Who are the users?',
            recommendation: 'Power users on Linux',
            rationale: 'They tolerate complexity.',
          }),
        ]),
      ])
      const arr1 = Chunk.toReadonlyArray(t1) as ReadonlyArray<AgentEvent>
      const last1 = arr1[arr1.length - 1]!
      if (last1.type !== 'question_asked') throw new Error('expected pause 1')
      expect(last1.questionId).toBe('q_0001')

      // Tick 2.
      const nextStart2 = (arr1[arr1.length - 1]?.id ?? 0) + 1
      const t2 = yield* collect('Power users on Linux is fine', nextStart2, [
        completion('c2', [
          askCall('tc2', {
            question: 'Should we ship as a library or a binary?',
            recommendation: 'Both',
            rationale: 'Library for embedders, binary for end users.',
          }),
        ]),
      ])
      const arr2 = Chunk.toReadonlyArray(t2) as ReadonlyArray<AgentEvent>
      const last2 = arr2[arr2.length - 1]!
      if (last2.type !== 'question_asked') throw new Error('expected pause 2')
      expect(last2.questionId).toBe('q_0002')

      // Tick 3.
      const nextStart3 = (arr2[arr2.length - 1]?.id ?? 0) + 1
      const t3 = yield* collect('Both is good', nextStart3, [
        completion('c3', [
          askCall('tc3', {
            question: 'Are there non-goals?',
            recommendation: 'Windows support is out of scope',
            rationale: 'Limits surface area.',
          }),
        ]),
      ])
      const arr3 = Chunk.toReadonlyArray(t3) as ReadonlyArray<AgentEvent>
      const last3 = arr3[arr3.length - 1]!
      if (last3.type !== 'question_asked') throw new Error('expected pause 3')
      expect(last3.questionId).toBe('q_0003')

      // Final tick: write 3 sections + finalize.
      const nextStart4 = (arr3[arr3.length - 1]?.id ?? 0) + 1
      const t4 = yield* collect(
        'No, those three were the only questions',
        nextStart4,
        [
          completion('c4', [
            writeOutputCall('w1', 'goal', 'Toggle dark mode from a CLI.'),
            writeOutputCall('w2', 'users', 'Power users on Linux.'),
            writeOutputCall('w3', 'non_goals', 'Windows support.'),
          ]),
          completion('c5', [finalizeCall('f1', 'PRD ready to ship.')]),
        ],
      )
      const arr4 = Chunk.toReadonlyArray(t4) as ReadonlyArray<AgentEvent>
      const last4 = arr4[arr4.length - 1]!
      if (last4.type !== 'done') throw new Error('expected finalize')
      expect(last4.finalText).toBe('PRD ready to ship.')

      // 3 prd_section_written events on the final tick.
      expect(
        arr4.filter((e) => e.type === 'prd_section_written'),
      ).toHaveLength(3)

      // Persistence: all 3 questions were recorded (we observe this by
      // looking them up — `findOpenQuestion` requires sessionId match).
      const q1 = yield* repo.findOpenQuestion('s', 'q_0001')
      const q2 = yield* repo.findOpenQuestion('s', 'q_0002')
      const q3 = yield* repo.findOpenQuestion('s', 'q_0003')
      expect(q1.question).toBe('Who are the users?')
      expect(q2.question).toBe('Should we ship as a library or a binary?')
      expect(q3.question).toBe('Are there non-goals?')

      const sections = yield* repo.listPrdSections('s')
      expect(sections.map((s) => s.section)).toEqual([
        'goal',
        'users',
        'non_goals',
      ])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(RepositoryInMemoryLive, IdsTest, SessionFixed),
      ),
    ),
  )
})
