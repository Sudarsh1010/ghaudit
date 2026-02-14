import type { worker } from '../../alchemy.run'
import { DurableObject } from 'cloudflare:workers'

export class AuditDO extends DurableObject {
  declare env: typeof worker.Env
  private count: number

  constructor(ctx: DurableObjectState, env: typeof worker.Env) {
    super(ctx, env)
    // Initialize count from storage or 0
    this.count = Number(this.ctx.storage.get('count') || 0)
  }

  async fetch(request: Request) {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/increment') {
      this.count++
    } else if (path === '/decrement') {
      this.count--
    }

    // Update count in storage
    this.ctx.storage.put('count', this.count.toString())
    return Response.json({ count: this.count })
  }
}
