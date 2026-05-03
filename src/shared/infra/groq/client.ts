/**
 * `Groq` — Effect service for the LLM seam. The Live layer pins:
 *   - 30s per-call timeout (`GroqNetworkError` on timeout)
 *   - up to 2 retries on transient failures (network / rate-limit), with
 *     exponential backoff (500ms × 2^n)
 *   - no SDK-level retries (we own retry policy)
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
import { Context, Effect, Layer, Ref, Schedule } from 'effect'
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

const isRetryable = (e: GroqError): boolean =>
  e._tag === 'GroqNetworkError' || e._tag === 'GroqRateLimitError'

export interface GroqLiveOptions {
  readonly apiKey: string | undefined
  readonly baseURL?: string
  readonly fetch?: typeof fetch
  readonly timeoutMillis?: number
  readonly maxRetries?: number
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
      const retries = options.maxRetries ?? 2

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
            Effect.retry({
              schedule: Schedule.exponential('500 millis', 2.0),
              times: retries,
              while: isRetryable,
            }),
          ),
      })
    }),
  )

/**
 * Test adapter: returns canned `ChatCompletion`s in order. After the list
 * is exhausted, further calls fail with `GroqApiError`. Provide via
 * `Layer.provide(GroqStub.layer([...]))` in `it.effect`.
 */
export const GroqStub = {
  layer: (
    turns: ReadonlyArray<OpenAI.ChatCompletion>,
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
              return turn
            }),
        })
      }),
    ),
}
