import alchemy from 'alchemy'
import { CloudflareStateStore } from 'alchemy/state'
import {
  TanStackStart,
  D1Database,
  DurableObjectNamespace,
  Ai,
} from 'alchemy/cloudflare'

const app = await alchemy('ghaudit', {
  stateStore: (scope) => new CloudflareStateStore(scope),
})

const ai = Ai()

const d1 = await D1Database('ghaudit_d1', {
  dev: { remote: false },
  migrationsDir: './drizzle/migrations',
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
    RESEARCH_DO: DurableObjectNamespace('RESEARCH_DO', {
      className: 'ResearchDO',
      sqlite: true,
    }),
  },
})

console.log({ url: worker.url })

await app.finalize()
