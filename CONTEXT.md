# researcher

A PRD-writing agent that interviews the user about a feature they want to build, grills them branch-by-branch with recommended answers, and uses external research tools to inform its questions. Produces a structured PRD when the conversation resolves.

## Language

**Research Session**:
A single end-to-end conversation in which the agent grills the user about one feature and produces one **PRD**. Has a status (`active` → `completed` / `abandoned`) and a sequence of **Research Steps**.
_Avoid_: Audit, run, chat, thread

**Agent Loop**:
The bounded iteration the LLM drives during a **Research Session**. At each turn the model reasons, optionally calls a **Tool** (research or HITL), observes the result, and decides whether to ask another question or finalise the **PRD**.
_Avoid_: Chain, pipeline, conversation

**Research Step**:
One iteration of the **Agent Loop**. Persists the LLM prompt/response, the **Tool** invoked, the tool input/output, and a status. Append-only.
_Avoid_: Turn, message

**Tool**:
A callable capability the **Agent Loop** can invoke. Two kinds: **Research Tools** (gather external context — library docs, web search) and **HITL Tools** (interact with the user — ask a question, propose a decision).
_Avoid_: Function, action

**HITL Tool**:
A **Tool** whose execution suspends the **Agent Loop** until the user replies. Calling one transitions the **Research Session** to `WAITING_FOR_USER`. The Durable Object hosting the loop may hibernate while waiting.
_Avoid_: Prompt, blocking call

**Recommended Answer**:
Every question the agent asks the user must be paired with the agent's own recommendation and the rationale. The user can accept, reject with reason, or pivot.
_Avoid_: Suggestion, default

**Finalisation**:
The transition that closes a **Research Session** by emitting the **PRD**. Triggered either by the user clicking "Finalise" in the UI, OR by the agent calling `summarizeProgress` with the recommendation "Finalise PRD" and the user accepting that card. The agent never finalises silently — every PRD ship is user-confirmed.
_Avoid_: Completion, finishing, closing

**PRD**:
The final structured output produced when the **Agent Loop** finalises. One per **Research Session**. Markdown, with named sections (Goal, Users, Scope, Non-goals, Open Questions, …).
_Avoid_: Document, spec, report

## Relationships

- A **Research Session** runs exactly one **Agent Loop** and produces zero or one **PRD** (zero if abandoned).
- An **Agent Loop** emits an ordered sequence of **Research Steps**.
- A **Research Step** invokes zero or one **Tool**.
- Each **Research Session** runs inside its own **Durable Object** instance, keyed by session id. The DO hibernates while the session is `WAITING_FOR_USER` and wakes on the user's reply.

## Example dialogue

> **Dev:** "When the agent calls a **HITL Tool**, what state does the **Research Session** transition to?"
> **Domain expert:** "`WAITING_FOR_USER`. The DO hibernates. Nothing happens until the user POSTs an answer to that question's id, which wakes the DO and resumes the **Agent Loop**."

> **Dev:** "Does the agent always pair a question with a **Recommended Answer**?"
> **Domain expert:** "Yes. A question without a recommendation is a research failure — the agent is supposed to do the thinking *and* check it with the user, not outsource the thinking back."
