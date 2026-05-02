import type { worker } from '../../alchemy.run'
import { DurableObject } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { createGroqClient } from '~/shared/infra/groq/client'
import { runStreamingTick } from '~/shared/research/streaming-agent'
import { encode, type AgentEvent } from '~/shared/sse/events'
import { transition, type SessionState } from '~/shared/session/state-machine'
import {
  researchSessions,
  researchSteps,
  researchQuestions,
  ResearchSessionStatus,
  ResearchStepStatus,
} from '~/shared/infra/drizzle/schema'

interface StreamRequestBody {
  prompt: string
}

interface AnswerRequestBody {
  questionId: string
  kind: 'accept' | 'reject' | 'custom'
  value?: string
}

const STATE_TO_DB: Record<SessionState, ResearchSessionStatus> = {
  RUNNING: ResearchSessionStatus.active,
  WAITING_FOR_USER: ResearchSessionStatus.waitingForUser,
  COMPLETED: ResearchSessionStatus.completed,
  FAILED: ResearchSessionStatus.failed,
  ABANDONED: ResearchSessionStatus.abandoned,
}

/**
 * One Research Session lives in one ResearchDO instance, keyed by session id.
 *
 * Slice 3 scope: a single tick may now PAUSE on askQuestion, transitioning
 * the session to WAITING_FOR_USER until the worker delivers an answer.
 */
export class ResearchDO extends DurableObject {
  declare env: typeof worker.Env

  private state: SessionState = 'RUNNING'
  private nextStepNumber = 1

  get sessionId(): string {
    return this.ctx.id.toString()
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/stream') {
      const body = (await request.json()) as StreamRequestBody
      return this.openStream(body.prompt)
    }
    if (request.method === 'POST' && url.pathname === '/answer') {
      const body = (await request.json()) as AnswerRequestBody
      return this.handleAnswer(body)
    }
    return new Response('Not found', { status: 404 })
  }

  private get db() {
    const env = this.env as unknown as { D1: D1Database }
    return drizzle(env.D1, { casing: 'snake_case' })
  }

  private async setState(next: SessionState): Promise<void> {
    this.state = next
    await this.db
      .update(researchSessions)
      .set({ status: STATE_TO_DB[next], updatedAt: new Date() })
      .where(eq(researchSessions.id, this.sessionId))
  }

  private openStream(prompt: string): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()
    const sessionId = this.sessionId

    const env = this.env as unknown as { GROQ_API_KEY?: string }
    const groq = createGroqClient({ apiKey: env.GROQ_API_KEY })

    const persistAndEmit = async (event: AgentEvent): Promise<void> => {
      await this.persistStep(event)
      this.nextStepNumber = Math.max(this.nextStepNumber, event.id + 1)
      await writer.write(encoder.encode(encode(event)))
    }

    void (async () => {
      try {
        const result = await runStreamingTick({
          sessionId,
          prompt,
          groq,
          emit: persistAndEmit,
          startStepNumber: this.nextStepNumber,
          persistQuestion: async (q) => {
            await this.db.insert(researchQuestions).values({
              id: q.id,
              sessionId,
              question: q.question,
              recommendedAnswer: q.recommendation,
              rationale: q.rationale,
            })
          },
        })

        if (result.kind === 'paused') {
          const t = transition(this.state, 'askQuestion')
          if (t.ok) await this.setState(t.state)
        } else {
          const t = transition(this.state, 'finalize')
          if (t.ok) await this.setState(t.state)
        }
      } catch (err) {
        const errorEvent = encode({
          id: this.nextStepNumber++,
          type: 'done',
          finalText: `error: ${(err as Error).message}`,
        })
        await writer.write(encoder.encode(errorEvent))
        const t = transition(this.state, 'fail')
        if (t.ok) await this.setState(t.state)
      } finally {
        await writer.close().catch(() => {})
      }
    })()

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    })
  }

  private async handleAnswer(body: AnswerRequestBody): Promise<Response> {
    if (this.state !== 'WAITING_FOR_USER') {
      return Response.json(
        { error: `cannot answer in state ${this.state}` },
        { status: 409 },
      )
    }
    if (!['accept', 'reject', 'custom'].includes(body.kind)) {
      return Response.json({ error: 'invalid_kind' }, { status: 400 })
    }

    const [question] = await this.db
      .select()
      .from(researchQuestions)
      .where(eq(researchQuestions.id, body.questionId))
      .limit(1)

    if (!question || question.userReply !== null) {
      return Response.json({ error: 'no_open_question' }, { status: 404 })
    }

    await this.db
      .update(researchQuestions)
      .set({
        userReply: JSON.stringify({ kind: body.kind, value: body.value }),
        answeredAt: new Date(),
      })
      .where(eq(researchQuestions.id, body.questionId))

    const t = transition(this.state, 'answer')
    if (!t.ok) {
      return Response.json({ error: t.error.message }, { status: 409 })
    }
    await this.setState(t.state)

    return Response.json({ ok: true, state: this.state })
  }

  private async persistStep(event: AgentEvent): Promise<void> {
    await this.db.insert(researchSteps).values({
      sessionId: this.sessionId,
      stepNumber: event.id,
      toolName: 'toolName' in event ? event.toolName : null,
      toolRequest:
        event.type === 'tool_invoked' ? JSON.stringify(event.args) : null,
      toolResponse:
        event.type === 'tool_result' ? JSON.stringify(event.result) : null,
      llmResponse:
        event.type === 'agent_thinking'
          ? event.text
          : event.type === 'done'
            ? event.finalText
            : null,
      status: ResearchStepStatus.success,
    })
  }
}
