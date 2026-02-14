import alchemy from 'alchemy'
import { CloudflareStateStore } from 'alchemy/state'
import {
  TanStackStart,
  D1Database,
  DurableObjectNamespace,
  Ai,
} from 'alchemy/cloudflare'

const app = await alchemy('ghaudit', {
  stateStore:
    process.env.NODE_ENV === 'production'
      ? (scope) => new CloudflareStateStore(scope)
      : undefined,
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
    AUDIT_DO: DurableObjectNamespace('AUDIT_DO', {
      className: 'AuditDO',
      sqlite: true,
    }),
  },
})

console.log({ url: worker.url })

await app.finalize()
