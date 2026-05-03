# researcher

A Human-in-the-Loop PRD-writing interview agent. The user describes a feature
they want to build; the agent grills them branch-by-branch with recommended
answers and external research, and emits a structured PRD when the
conversation resolves.

See [`CONTEXT.md`](./CONTEXT.md) for the domain language.

## Stack

- TanStack Start (React + Vite + Cloudflare Workers)
- Cloudflare Durable Objects (one per Research Session)
- Cloudflare D1 + Drizzle ORM (5 normalised tables)
- Groq (via the OpenAI SDK pointed at `https://api.groq.com/openai/v1`)
- Alchemy for infra-as-code
- Vitest for tests

## Required secrets

| Name                    | Purpose                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `GROQ_API_KEY`          | API key for Groq Cloud. Used by `src/shared/infra/groq/client.ts`.                                 |
| `SESSION_COOKIE_SECRET` | HMAC key for signing the `session_owner` cookie (Slice 6). Rotating it invalidates every cookie.  |

For local dev, put them in `.env` at the project root. For deploys, configure
them through Alchemy / Cloudflare secrets.

## Common scripts

```sh
pnpm dev                                    # alchemy dev (local Workers)
pnpm test                                   # vitest run
pnpm drizzle-kit generate --name=<change>   # produce a new migration
wrangler d1 migrations apply DATABASE --local
```
