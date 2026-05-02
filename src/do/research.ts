import type { worker } from '../../alchemy.run'
import { DurableObject } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/d1'
import { createGroqClient } from '~/shared/infra/groq/client'
import { runStreamingTick } from '~/shared/research/streaming-agent'
import { encode, type AgentEvent } from '~/shared/sse/events'
import {
  researchSteps,
  ResearchStepStatus,
} from '~/shared/infra/drizzle/schema'

interface StreamRequestBody {
  prompt: string
}

/**
 * One Research Session lives in one ResearchDO instance, keyed by session id.
 *
 * Slice 2 scope: a single `runStreamingTick()` round-trip. Each event is
 * persisted to `research_steps` *before* being written to the SSE stream so
 * that replay (Slice 5) is a query, not a re-execution.
 */
export class ResearchDO extends DurableObject {
  declare env: typeof worker.Env

  get sessionId(): string {
    return this.ctx.id.toString()
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/stream') {
      const body = (await request.json()) as StreamRequestBody
      return this.openStream(body.prompt)
    }
    return new Response('Not found', { status: 404 })
  }

  private openStream(prompt: string): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()
    const sessionId = this.sessionId

    const env = this.env as unknown as {
      D1: D1Database
      GROQ_API_KEY?: string
    }
    const db = drizzle(env.D1, { casing: 'snake_case' })
    const groq = createGroqClient({ apiKey: env.GROQ_API_KEY })

    const persistAndEmit = async (event: AgentEvent): Promise<void> => {
      // Persist before emitting so the SSE stream can be reconstructed from D1.
      await db.insert(researchSteps).values({
        sessionId,
        stepNumber: event.id,
        toolName: 'toolName' in event ? event.toolName : null,
        toolRequest:
          event.type === 'tool_invoked' ? JSON.stringify(event.args) : null,
        toolResponse:
          event.type === 'tool_result' ? JSON.stringify(event.result) : null,
        llmResponse:
          event.type === 'agent_thinking' || event.type === 'done'
            ? (event as { text?: string; finalText?: string }).text ??
              (event as { finalText?: string }).finalText ??
              null
            : null,
        status: ResearchStepStatus.success,
      })
      await writer.write(encoder.encode(encode(event)))
    }

    void (async () => {
      try {
        await runStreamingTick({
          sessionId,
          prompt,
          groq,
          emit: persistAndEmit,
        })
      } catch (err) {
        const errorEvent = encode({
          id: 0,
          type: 'done',
          finalText: `error: ${(err as Error).message}`,
        })
        await writer.write(encoder.encode(errorEvent))
      } finally {
        await writer.close().catch(() => {})
      }
    })()

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    })
  }
}
