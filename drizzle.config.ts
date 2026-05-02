import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/shared/infra/drizzle/schema.ts',
  out: './drizzle/migrations',
  casing: 'snake_case',
})
