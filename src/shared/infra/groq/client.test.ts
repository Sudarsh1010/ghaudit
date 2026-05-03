/**
 * Tests for the `Groq` Effect service.
 *
 *   - `GroqLive(opts)` is the live layer; we drive it with a `fetch` stub
 *     so the OpenAI SDK never opens a real socket.
 *   - Auth misconfiguration is observable as a layer-build failure
 *     (`GroqAuthError`).
 *   - `GroqStub.layer([…])` is the canned-response layer the rest of the
 *     suite uses; we cover its happy path here so no other test has to
 *     reason about its semantics.
 */
import { describe, it, expect } from '@effect/vitest'
import { Cause, Effect, Exit, Layer } from 'effect'
import type OpenAI from 'openai'
import { GROQ_BASE_URL, Groq, GroqLive, GroqStub } from './client'

interface CapturedRequest {
  readonly url: string
  readonly init: RequestInit
}

const fetchStub = (
  response: object,
  captured: { current: CapturedRequest | null },
): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.current = {
      url: typeof input === 'string' ? input : input.toString(),
      init: init ?? {},
    }
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

const sampleCompletion: OpenAI.ChatCompletion = {
  id: 'cmpl_1',
  object: 'chat.completion',
  created: 0,
  model: 'llama-3.1-8b-instant',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'hello', refusal: null },
      finish_reason: 'stop',
      logprobs: null,
    },
  ],
} as OpenAI.ChatCompletion

describe('GroqLive', () => {
  it.effect('posts chat.completions to the Groq base URL with the API key', () =>
    Effect.gen(function* () {
      const captured: { current: CapturedRequest | null } = { current: null }
      const layer = GroqLive({
        apiKey: 'test-key',
        fetch: fetchStub(sampleCompletion, captured),
      })

      const program = Effect.gen(function* () {
        const groq = yield* Groq
        return yield* groq.chatCompletion({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: 'hi' }],
        })
      })

      const res = yield* program.pipe(Effect.provide(layer))

      expect(res.choices[0]?.message.content).toBe('hello')
      expect(captured.current).not.toBeNull()
      const { url, init } = captured.current!
      expect(url).toContain(GROQ_BASE_URL)
      expect(url).toContain('/chat/completions')
      const headers = new Headers(init.headers)
      expect(headers.get('authorization')).toBe('Bearer test-key')
      const body = JSON.parse(init.body as string) as {
        model: string
        messages: ReadonlyArray<unknown>
      }
      expect(body.model).toBe('llama-3.1-8b-instant')
      expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    }),
  )

  it.effect('forwards tool definitions in the request body', () =>
    Effect.gen(function* () {
      const captured: { current: CapturedRequest | null } = { current: null }
      const layer = GroqLive({
        apiKey: 'k',
        fetch: fetchStub(sampleCompletion, captured),
      })

      const program = Effect.gen(function* () {
        const groq = yield* Groq
        yield* groq.chatCompletion({
          model: 'm',
          messages: [{ role: 'user', content: 'go' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'echo',
                description: 'echo back',
                parameters: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text'],
                },
              },
            },
          ],
        })
      })

      yield* program.pipe(Effect.provide(layer))

      const init = captured.current!.init
      const body = JSON.parse(init.body as string) as {
        tools: ReadonlyArray<{ function: { name: string } }>
      }
      expect(body.tools).toHaveLength(1)
      expect(body.tools[0]?.function.name).toBe('echo')
    }),
  )

  it.effect('fails the layer build with GroqAuthError when key is missing', () =>
    Effect.gen(function* () {
      const layer = GroqLive({ apiKey: undefined })
      const program = Effect.gen(function* () {
        const groq = yield* Groq
        return yield* groq.chatCompletion({
          model: 'm',
          messages: [{ role: 'user', content: 'x' }],
        })
      })

      const exit = yield* Effect.exit(program.pipe(Effect.provide(layer)))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(failure._tag).toBe('Some')
        if (failure._tag === 'Some') {
          expect(failure.value._tag).toBe('GroqAuthError')
        }
      }
    }),
  )
})

describe('GroqStub.layer', () => {
  it.effect('serves canned ChatCompletions in order', () =>
    Effect.gen(function* () {
      const turn1: OpenAI.ChatCompletion = {
        ...sampleCompletion,
        id: 'cmpl_a',
      }
      const turn2: OpenAI.ChatCompletion = {
        ...sampleCompletion,
        id: 'cmpl_b',
      }

      const program = Effect.gen(function* () {
        const groq = yield* Groq
        const a = yield* groq.chatCompletion({
          model: 'm',
          messages: [{ role: 'user', content: 'one' }],
        })
        const b = yield* groq.chatCompletion({
          model: 'm',
          messages: [{ role: 'user', content: 'two' }],
        })
        return [a.id, b.id] as const
      })

      const ids = yield* program.pipe(
        Effect.provide(GroqStub.layer([turn1, turn2])),
      )
      expect(ids).toEqual(['cmpl_a', 'cmpl_b'])
    }),
  )

  it.effect('fails with GroqApiError when canned list is exhausted', () =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const groq = yield* Groq
        return yield* groq.chatCompletion({
          model: 'm',
          messages: [{ role: 'user', content: 'x' }],
        })
      })

      const exit = yield* Effect.exit(
        program.pipe(Effect.provide(GroqStub.layer([]))),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(failure._tag).toBe('Some')
        if (failure._tag === 'Some') {
          expect(failure.value._tag).toBe('GroqApiError')
        }
      }
    }).pipe(Effect.provide(Layer.empty)),
  )
})
