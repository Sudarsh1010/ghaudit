import { Context, Layer, Effect } from 'effect'
import OpenAI from 'openai'
import { AIError } from './error'

export interface AIService {
  readonly createChatCompletion: (
    params: CreateChatCompletionParams,
  ) => Effect.Effect<OpenAI.ChatCompletion, AIError>
}

export const AIService = Context.GenericTag<AIService>('AIService')

export interface CreateChatCompletionParams {
  model: string
  messages: OpenAI.ChatCompletionMessageParam[]
  tools?: OpenAI.ChatCompletionTool[]
  toolChoice?:
    | 'auto'
    | 'required'
    | { type: 'function'; function: { name: string } }
  maxTokens?: number
  temperature?: number
}

export const ZaiAIServiceLive = Layer.sync(
  AIService,
  () =>
    ({
      createChatCompletion: (params) =>
        Effect.tryPromise({
          try: async () => {
            const client = new OpenAI({
              apiKey: process.env.ZAI_API_KEY!,
              baseURL: 'https://api.z.ai/api/coding/paas/v4/',
            })

            // Enforce JSON mode for structured output if tools are used
            const useJsonMode = params.tools && params.tools.length > 0

            return await client.chat.completions.create({
              model: params.model ?? 'glm-4.7',
              messages: params.messages,
              tools: params.tools,
              tool_choice:
                params.toolChoice ?? (useJsonMode ? 'auto' : undefined),
              max_tokens: params.maxTokens ?? 300,
              temperature: params.temperature ?? 0.7,
              // Z.AI supports response_format for JSON mode
              ...(useJsonMode
                ? { response_format: { type: 'json_object' } }
                : {}),
            })
          },
          catch: (cause) => new AIError('Failed to call Z.AI', cause),
        }),
    }) satisfies AIService,
)
