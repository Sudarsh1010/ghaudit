import { drizzle } from 'drizzle-orm/d1'
import { Context, Layer } from 'effect'

/**
 * Creates a Drizzle instance bound to the current D1 database.
 * Safe to call per-request in edge runtime.
 */
const createDrizzle = (db: D1Database) => {
  return drizzle(db, { casing: 'snake_case' })
}

export interface DrizzleService {
  db: ReturnType<typeof createDrizzle>
}

export const DrizzleService =
  Context.GenericTag<DrizzleService>('DrizzleService')

export const DrizzleLayer = (env: Env) =>
  Layer.succeed(
    DrizzleService,
    DrizzleService.of({ db: createDrizzle(env.D1) }),
  )
