// DO NOT DELETE THIS FILE!!!
// Worker entry. Routes /session POSTs + the SSE stream and falls back to
// TanStack Start for everything else.
import handler from '@tanstack/react-start/server-entry'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { researchSessions } from '~/shared/infra/drizzle/schema'
import { createSession } from '~/shared/research/session'

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
        buildEventStreamUrl: (id) => `/session/${id}/stream`,
      },
    )
    return Response.json(result)
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 })
  }
}

const handleStream = async (
  sessionId: string,
  env: Env,
): Promise<Response> => {
  const db = drizzle(env.D1, { casing: 'snake_case' })
  const [row] = await db
    .select()
    .from(researchSessions)
    .where(eq(researchSessions.id, sessionId))
    .limit(1)

  if (!row) return new Response('session not found', { status: 404 })

  const namespace = env.RESEARCH_DO as unknown as {
    idFromName: (n: string) => unknown
    get: (id: unknown) => { fetch: typeof fetch }
  }
  const stub = namespace.get(namespace.idFromName(sessionId))
  return stub.fetch('https://do/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: row.initialPrompt }),
  })
}

const STREAM_PATH = /^\/session\/([^/]+)\/stream$/
const ANSWER_PATH = /^\/session\/([^/]+)\/answer\/([^/]+)$/
const PRD_PATH = /^\/session\/([^/]+)\/prd$/

const handlePrd = async (sessionId: string, env: Env): Promise<Response> => {
  const namespace = env.RESEARCH_DO as unknown as {
    idFromName: (n: string) => unknown
    get: (id: unknown) => { fetch: typeof fetch }
  }
  const stub = namespace.get(namespace.idFromName(sessionId))
  return stub.fetch('https://do/prd', { method: 'GET' })
}

const handleAnswer = async (
  sessionId: string,
  questionId: string,
  request: Request,
  env: Env,
): Promise<Response> => {
  const namespace = env.RESEARCH_DO as unknown as {
    idFromName: (n: string) => unknown
    get: (id: unknown) => { fetch: typeof fetch }
  }
  const stub = namespace.get(namespace.idFromName(sessionId))
  const body = await request.text()
  return stub.fetch('https://do/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...JSON.parse(body || '{}'), questionId }),
  })
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/session') {
      return handleCreateSession(request, env)
    }

    const m = url.pathname.match(STREAM_PATH)
    if (m && request.method === 'GET') {
      return handleStream(m[1]!, env)
    }

    const a = url.pathname.match(ANSWER_PATH)
    if (a && request.method === 'POST') {
      return handleAnswer(a[1]!, a[2]!, request, env)
    }

    const p = url.pathname.match(PRD_PATH)
    if (p && request.method === 'GET') {
      return handlePrd(p[1]!, env)
    }

    return handler.fetch(request, {
      context: {
        // @ts-expect-error tanstack context shape
        fromFetch: true,
      },
    })
  },
}
