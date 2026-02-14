import { Schema } from '@effect/schema'
import * as JSONSchema from '@effect/schema/JSONSchema'
import type { OpenAI } from 'openai'
import { FunctionParameters } from 'openai/resources/shared.mjs'

/**
 * A domain-level AI Tool definition.
 *
 * - `name`: unique identifier (must match function name)
 * - `description`: what the tool does
 * - `inputSchema`: Effect Schema for validating LLM-provided arguments
 * - `execute`: business logic (runs after validation)
 */
export interface AITool<Input extends Schema.Schema.Any, Output> {
  readonly name: string
  readonly description: string
  readonly inputSchema: Input
  readonly execute: (input: Schema.Schema.Type<Input>) => Promise<Output>
}

/**
 * Converts an AITool into an OpenAI-compatible tool definition
 * (for passing to `chat.completions.create`)
 */
export const toOpenAITool = <Input extends Schema.Schema.Any, Output>(
  tool: AITool<Input, Output>,
): OpenAI.ChatCompletionTool => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: JSONSchema.make(
      tool.inputSchema,
    ) as unknown as FunctionParameters,
  },
})

/**
 * Helper to create a new tool with minimal boilerplate.
 */
export const createTool = <
  const Name extends string,
  Input extends Schema.Schema.Any,
  Output,
>({
  name,
  description,
  inputSchema,
  execute,
}: {
  name: Name
  description: string
  inputSchema: Input
  execute: (input: Schema.Schema.Type<Input>) => Promise<Output>
}): AITool<Input, Output> & { readonly _name: Name } => ({
  name,
  description,
  inputSchema,
  execute,
  _name: name, // enables nominal typing by name if needed
})
