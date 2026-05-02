import type { worker } from '../../alchemy.run'
import { DurableObject } from 'cloudflare:workers'
import { createGroqClient } from '~/shared/infra/groq/client'
import { tick, type AgentTickOutput } from '~/shared/research/agent'

interface TickRequestBody {
  prompt: string
}

/**
 * One Research Session lives in one ResearchDO instance, keyed by session id.
 *
 * Slice 1 scope: a single `tick()` round-trip with the `echo` tool wired.
 * Later slices add streaming, HITL hibernation, and the 5-state machine.
 */
export class ResearchDO extends DurableObject {
  declare env: typeof worker.Env

  /** The session id this DO is bound to. */
  get sessionId(): string {
    return this.ctx.id.toString()
  }

  /**
   * One iteration of the Agent Loop. Called by the worker via `fetch`.
   */
  async tick(prompt: string): Promise<AgentTickOutput> {
    const apiKey = (this.env as unknown as { GROQ_API_KEY?: string })
      .GROQ_API_KEY
    const groq = createGroqClient({ apiKey })
    return tick({ sessionId: this.sessionId, prompt, groq })
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/tick') {
      const body = (await request.json()) as TickRequestBody
      const result = await this.tick(body.prompt)
      return Response.json(result)
    }
    return new Response('Not found', { status: 404 })
  }
}
