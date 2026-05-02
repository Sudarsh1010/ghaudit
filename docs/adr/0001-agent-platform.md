# Agent execution platform

The interview agent runs as a hand-rolled tool-call loop inside a per-session **Durable Object**, persists each turn to **D1**, and streams events to the browser via **Server-Sent Events** keyed by `Last-Event-ID` for replay. Inference happens at **Groq** (`llama-3.3-70b-versatile`) over a thin OpenAI-SDK client; the agent loop, tool dispatch, and HITL pause/resume are written by hand. No agent framework (no `ai-sdk`, no Mastra). No auth — sessions are anonymous, cookie-keyed.

## Considered Options

- **Inference at Cloudflare Workers AI** (binding-native, $0, same isolate). Rejected: tool-call reliability on the hosted Llama is materially worse than Groq's, and inference speed is ~10× slower — both directly hurt a structured-grilling demo where the user watches the agent think. Tradeoff: we lose the "model runs in the same isolate" line, accept a `GROQ_API_KEY` env var, and inherit a 1k req/day free-tier cap.
- **Anthropic / OpenAI frontier models.** Rejected: violates the $0 budget constraint.
- **Agent loop in a server route, not a DO.** Rejected: the agent has to *pause for the user* on every HITL question. A request-scoped handler can't sleep for hours waiting for an answer; a DO can hibernate and wake on the inbound POST. The DO is also what makes session resume after a refresh trivial.
- **WebSocket between browser and DO.** Rejected: the data flow is one-way (server → client emits events; user actions are discrete `POST`s). SSE gives free reconnection via `Last-Event-ID`, plays well with `EventSource`, demoable with `curl`.
- **OpenAI SDK with auto-loop tool helpers, or Mastra `Agent` runtime.** Rejected: the agent loop *is* the showcase. SDK is fine as HTTP transport (`chat.completions.create`, streaming SSE parser, typed responses); the while-loop, tool dispatch, and HITL state transitions are owned by us.
- **Better Auth + GitHub OAuth.** Rejected for v1: researcher has no per-user data that requires accounts. Anonymous cookie-keyed sessions ship faster and remove an entire complexity bill (KV binding, OAuth app, callback routing, schema CLI). Additive in v2 if "save my PRDs across devices" becomes a goal.

## Consequences

- `alchemy.run.ts` no longer needs the `Ai()` binding; secrets gain `GROQ_API_KEY`.
- `src/shared/infra/ai/zai/` is deleted; replaced by `src/shared/infra/ai/groq/` (thin client) and `src/shared/agent/loop.ts` (hand-rolled loop).
- The DO transitions through an explicit state machine (`RUNNING` ↔ `WAITING_FOR_USER` → `COMPLETED` / `FAILED`). Hibernation is only safe in `WAITING_FOR_USER`.
- Each session is bounded by Groq free-tier quota (~70-100 sessions/day at observed turn counts). Production traffic would require either paid Groq or a fallback provider — out of scope for the showcase.
- The agent's tool surface is intentionally small (7 tools, with similar shapes merged into discriminated unions) so an open-weights 70B model can select reliably.
