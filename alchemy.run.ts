import alchemy from 'alchemy'
import { CloudflareStateStore } from 'alchemy/state'
import {
  TanStackStart,
  D1Database,
  DurableObjectNamespace,
  Ai,
  RateLimit,
} from 'alchemy/cloudflare'

const app = await alchemy('ghaudit', {
  stateStore: (scope) => new CloudflareStateStore(scope),
})

const ai = Ai()

const d1 = await D1Database('ghaudit_d1', {
  dev: { remote: false },
  migrationsDir: './drizzle/migrations',
})

/*
 * Per-IP rate limits at the worker edge.
 *
 *   - Session creation is the expensive operation (mints a DO, kicks off
 *     a Groq-bounded loop). The Groq free tier is ~1000 requests/day,
 *     so 10 sessions/min/IP keeps ~6 simultaneous IPs comfortably within
 *     the daily budget.
 *
 *   - Answer submission is normal user activity inside an active session
 *     and isn't itself a Groq cost driver, so the limit is more permissive.
 *
 * `namespace_id` is the binding-local identifier that the runtime uses
 * to namespace the counters.
 */
const sessionRateLimit = RateLimit({
  namespace_id: 1001,
  simple: { limit: 10, period: 60 },
})

const answerRateLimit = RateLimit({
  namespace_id: 1002,
  simple: { limit: 60, period: 60 },
})

export const worker = await TanStackStart('worker', {
  compatibility: 'node',
  entrypoint: './dist/server/index.js',
  bindings: {
    AI: ai,
    D1: d1,
    // GROQ_API_KEY must be provided as a secret/env var. Required.
    GROQ_API_KEY: alchemy.secret(process.env.GROQ_API_KEY),
    /**
     * HMAC key used to sign the `session_owner` cookie (Slice 6).
     * Required: server.ts and the session server-fns refuse to serve
     * session-scoped routes without it. Rotating this secret invalidates
     * every outstanding cookie (orphans live sessions until users
     * reload), so treat as a long-lived production secret.
     */
    SESSION_COOKIE_SECRET: alchemy.secret(process.env.SESSION_COOKIE_SECRET),
    // BRAVE_API_KEY enables the `webSearch` research tool. Required for
    // the agent to ground its recommendations on web search results;
    // missing key causes `webSearch` calls to fail with `BraveAuthError`
    // (the loop continues — the model will fall back to other tools or
    // its own knowledge).
    BRAVE_API_KEY: alchemy.secret(process.env.BRAVE_API_KEY),
    RESEARCH_DO: DurableObjectNamespace('RESEARCH_DO', {
      className: 'ResearchDO',
      sqlite: true,
    }),
    SESSION_RATELIMIT: sessionRateLimit,
    ANSWER_RATELIMIT: answerRateLimit,
  },
})

console.log({ url: worker.url })

await app.finalize()
