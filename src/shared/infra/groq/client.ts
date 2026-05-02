import OpenAI from 'openai'

export interface GroqChatCompletionParams {
  model: string
  messages: OpenAI.ChatCompletionMessageParam[]
  tools?: Array<OpenAI.ChatCompletionTool>
  toolChoice?: OpenAI.ChatCompletionToolChoiceOption
  temperature?: number
  maxTokens?: number
  stream?: boolean
}

export interface GroqClient {
  chatCompletion: (
    params: GroqChatCompletionParams,
  ) => Promise<OpenAI.ChatCompletion>
}

export interface CreateGroqClientOptions {
  apiKey?: string
  baseURL?: string
  fetch?: typeof fetch
}

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'

/**
 * Deep module: wraps the OpenAI SDK pointed at the Groq endpoint and exposes
 * a narrow `chatCompletion` interface. Reads `GROQ_API_KEY` from the env when
 * an explicit key isn't passed.
 */
export const createGroqClient = (
  options: CreateGroqClientOptions = {},
): GroqClient => {
  const apiKey =
    options.apiKey ??
    (typeof process !== 'undefined' ? process.env.GROQ_API_KEY : undefined)

  if (!apiKey) {
    throw new Error('GROQ_API_KEY is required to create a Groq client')
  }

  const openai = new OpenAI({
    apiKey,
    baseURL: options.baseURL ?? GROQ_BASE_URL,
    fetch: options.fetch as unknown as OpenAI['fetch'],
  })

  return {
    async chatCompletion(params) {
      const result = await openai.chat.completions.create({
        model: params.model,
        messages: params.messages,
        tools: params.tools,
        tool_choice: params.toolChoice,
        temperature: params.temperature,
        max_tokens: params.maxTokens,
        stream: false,
      })
      return result as OpenAI.ChatCompletion
    },
  }
}
