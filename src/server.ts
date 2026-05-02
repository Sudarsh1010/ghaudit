// DO NOT DELETE THIS FILE!!!
// Worker entry. Routes /session POSTs to the session orchestrator and falls
// back to TanStack Start for everything else.
import handler from '@tanstack/react-start/server-entry'
import { drizzle } from 'drizzle-orm/d1'
import { researchSessions } from '~/shared/infra/drizzle/schema'
import { createSession } from '~/shared/research/session'
import type { AgentTickOutput } from '~/shared/research/agent'

console.log("[server-entry]: using custom server entry in 'src/server.ts'")

export { ResearchDO } from '~/do/research'

interface SessionRequestBody {
  initialPrompt: string
}

const handleCreateSession = async (
  request: Request,
  env: Env,
): Promise<Response> => {
  let body: SessionRequestBody
  try {
    body = (await request.json()) as SessionRequestBody
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const db = drizzle(env.D1, { casing: 'snake_case' })

  try {
    const result = await createSession(
      { initialPrompt: body.initialPrompt ?? '' },
      {
        insertSession: async (row) => {
          await db.insert(researchSessions).values(row)
        },
        spawnAgentTick: async (sessionId, prompt) => {
          const namespace = env.RESEARCH_DO as unknown as {
            idFromName: (n: string) => unknown
            get: (id: unknown) => { fetch: typeof fetch }
          }
          const id = namespace.idFromName(sessionId)
          const stub = namespace.get(id)
          const res = await stub.fetch('https://do/tick', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt }),
          })
          return (await res.json()) as AgentTickOutput
        },
      },
    )
    return Response.json(result)
  } catch (err) {
    return Response.json(
      { error: (err as Error).message },
      { status: 400 },
    )
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/session') {
      return handleCreateSession(request, env)
    }
    return handler.fetch(request, {
      context: {
        // @ts-expect-error tanstack context shape
        fromFetch: true,
      },
    })
  },
}
