/**
 * `Groq` — Effect service for the LLM seam. The Live layer pins:
 *   - 30s per-call timeout (`GroqNetworkError` on timeout)
 *   - **no client-level retries** — the agent loop owns retry policy
 *     (1s, 2s, 4s with `error/retry` SSE events between attempts) so
 *     retrying down here would silently double the work and starve the
 *     SSE stream of progress signals.
 *
 * Error classification inspects `OpenAI.APIError` (the SDK's exception
 * type) and routes to a tagged variant. Anything else becomes
 * `GroqNetworkError`.
 *
 * The test layer (`GroqStub.layer`) consumes a list of canned
 * `ChatCompletion`s in order — replaces the per-test `cannedGroq` factory
 * the old codebase used.
 */
import OpenAI from 'openai'
import { Context, Effect, Layer, Ref } from 'effect'
import {
  type GroqError,
  GroqApiError,
  GroqAuthError,
  GroqNetworkError,
  GroqRateLimitError,
} from '~/shared/domain/errors'

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'

export interface GroqChatCompletionParams {
  readonly model: string
  readonly messages: ReadonlyArray<OpenAI.ChatCompletionMessageParam>
  readonly tools?: ReadonlyArray<OpenAI.ChatCompletionTool>
  readonly toolChoice?: OpenAI.ChatCompletionToolChoiceOption
  readonly temperature?: number
  readonly maxTokens?: number
}

export class Groq extends Context.Tag('Groq')<
  Groq,
  {
    readonly chatCompletion: (
      params: GroqChatCompletionParams,
    ) => Effect.Effect<OpenAI.ChatCompletion, GroqError>
  }
>() {}

const classifyError = (cause: unknown): GroqError => {
  if (cause instanceof OpenAI.APIError) {
    if (cause.status === 401 || cause.status === 403) {
      return new GroqAuthError({ reason: cause.message })
    }
    if (cause.status === 429) {
      const ra = cause.headers?.['retry-after']
      const seconds =
        typeof ra === 'string' && ra.length > 0 ? Number(ra) : undefined
      return new GroqRateLimitError({
        retryAfterSeconds: Number.isFinite(seconds) ? seconds : undefined,
      })
    }
    return new GroqApiError({
      status: cause.status ?? 0,
      body: cause.message,
    })
  }
  return new GroqNetworkError({ cause })
}

export interface GroqLiveOptions {
  readonly apiKey: string | undefined
  readonly baseURL?: string
  readonly fetch?: typeof fetch
  readonly timeoutMillis?: number
}

/**
 * Live Groq layer. Fails the layer build (and thus the request) with
 * `GroqAuthError` if the API key is missing — we'd rather surface the
 * misconfiguration at the boundary than pretend.
 */
export const GroqLive = (
  options: GroqLiveOptions,
): Layer.Layer<Groq, GroqAuthError> =>
  Layer.effect(
    Groq,
    Effect.gen(function* () {
      if (!options.apiKey) {
        return yield* new GroqAuthError({
          reason: 'GROQ_API_KEY is required to create a Groq client',
        })
      }
      const client = new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseURL ?? GROQ_BASE_URL,
        fetch: options.fetch as unknown as OpenAI['fetch'],
        maxRetries: 0,
      })
      const timeoutMs = options.timeoutMillis ?? 30_000

      return Groq.of({
        chatCompletion: (params) =>
          Effect.tryPromise({
            try: () =>
              client.chat.completions.create({
                model: params.model,
                messages: params.messages as Array<OpenAI.ChatCompletionMessageParam>,
                tools: params.tools as Array<OpenAI.ChatCompletionTool> | undefined,
                tool_choice: params.toolChoice,
                temperature: params.temperature,
                max_tokens: params.maxTokens,
                stream: false,
              }) as Promise<OpenAI.ChatCompletion>,
            catch: classifyError,
          }).pipe(
            Effect.timeoutFail({
              duration: `${timeoutMs} millis`,
              onTimeout: (): GroqError =>
                new GroqNetworkError({ cause: 'timeout' }),
            }),
          ),
      })
    }),
  )

/**
 * Test adapter: returns canned `ChatCompletion`s in order. After the list
 * is exhausted, further calls fail with `GroqApiError`. Provide via
 * `Layer.provide(GroqStub.layer([...]))` in `it.effect`.
 *
 * Each turn is either a successful `ChatCompletion` or a canned failure
 * `{ _err }` that the stub raises — useful for driving the loop's retry
 * and repair paths without spinning up real network failure modes.
 */
export type GroqStubTurn =
  | OpenAI.ChatCompletion
  | { readonly _err: GroqError }

const isErrorTurn = (
  t: GroqStubTurn,
): t is { readonly _err: GroqError } =>
  typeof t === 'object' && t !== null && '_err' in t

export const GroqStub = {
  layer: (
    turns: ReadonlyArray<GroqStubTurn>,
  ): Layer.Layer<Groq> =>
    Layer.scoped(
      Groq,
      Effect.gen(function* () {
        const cursor = yield* Ref.make(0)
        return Groq.of({
          chatCompletion: () =>
            Effect.gen(function* () {
              const i = yield* Ref.modify(cursor, (n) => [n, n + 1])
              const turn = turns[i]
              if (!turn) {
                return yield* new GroqApiError({
                  status: 0,
                  body: `GroqStub: no canned response for turn ${i + 1}`,
                })
              }
              if (isErrorTurn(turn)) {
                return yield* Effect.fail(turn._err)
              }
              return turn
            }),
        })
      }),
    ),
}
