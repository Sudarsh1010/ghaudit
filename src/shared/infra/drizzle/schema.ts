import { sqliteTable } from 'drizzle-orm/sqlite-core'

export enum AuditStatus {
  pending = 'pending',
  running = 'running',
  completed = 'completed',
  failed = 'failed',
}

export enum AuditStepStatus {
  failure = 'failure',
  success = 'success',
}

/**
 * Main audit session record.
 */
export const audits = sqliteTable('audits', (schema) => ({
  id: schema.text({ length: 34 }).primaryKey(), // e.g., audit_xxxxxx
  repoUrl: schema.text().notNull(),
  status: schema
    .text({
      mode: 'text',
      length: 9,
      enum: Object.values(AuditStatus) as [AuditStatus, ...AuditStatus[]],
    })
    .notNull(),
  createdAt: schema.integer({ mode: 'timestamp' }).notNull(),
  updatedAt: schema.integer({ mode: 'timestamp' }).notNull(),
}))

/**
 * Immutable log of every step in the agent loop.
 * Enables full traceability & replay.
 */
export const auditSteps = sqliteTable('audit_steps', (schema) => ({
  id: schema.integer().primaryKey({ autoIncrement: true }),
  auditId: schema
    .text({ length: 34 })
    .notNull()
    .references(() => audits.id, { onDelete: 'cascade' }),

  stepNumber: schema.integer().notNull(), // 1 to 10
  toolName: schema.text(), // e.g., "fetchRepoMetadata"
  llmPrompt: schema.text(),
  llmResponse: schema.text(), // raw JSON from Llama
  toolRequest: schema.text(), // e.g., "{ owner: '...', repo: '...' }"
  toolResponse: schema.text(), // raw GitHub API response
  errorMessage: schema.text(), // if step failed
  status: schema
    .text({
      length: 7,
      mode: 'text',
      enum: Object.values(AuditStepStatus) as [
        AuditStepStatus,
        ...AuditStepStatus[],
      ],
    })
    .notNull(),
  timestamp: schema.integer({ mode: 'timestamp' }).notNull(),
}))

/**
 * Final human-readable report (Markdown/JSON).
 */
export const auditReports = sqliteTable('audit_reports', (schema) => ({
  auditId: schema
    .text({ length: 34 })
    .primaryKey()
    .references(() => audits.id, { onDelete: 'cascade' }),
  content: schema.text().notNull(), // final report
  createdAt: schema.integer({ mode: 'timestamp' }).notNull(),
}))
