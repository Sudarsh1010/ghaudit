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
  },
})

console.log({ url: worker.url })

await app.finalize()
