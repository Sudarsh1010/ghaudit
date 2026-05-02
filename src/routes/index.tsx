import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { AgentEvent, QuestionAskedEvent } from '~/shared/sse/events'
import { QuestionCard } from '~/components/question-card'

export const Route = createFileRoute('/')({ component: App })

interface CreateSessionResponse {
  sessionId: string
  eventStreamUrl: string
}

function App() {
  const [prompt, setPrompt] = useState('')
  const [session, setSession] = useState<CreateSessionResponse | null>(null)
  const [events, setEvents] = useState<Array<AgentEvent>>([])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const sourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    return () => sourceRef.current?.close()
  }, [])

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setEvents([])
    setSession(null)
    setSubmitting(true)
    try {
      const res = await fetch('/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ initialPrompt: prompt }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `request failed: ${res.status}`)
      }
      const created = (await res.json()) as CreateSessionResponse
      setSession(created)

      const source = new EventSource(created.eventStreamUrl)
      sourceRef.current = source

      const handle = (type: AgentEvent['type']) => (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data) as Record<string, unknown>
          const evt = {
            id: Number(e.lastEventId),
            type,
            ...payload,
          } as AgentEvent
          setEvents((prev) => [...prev, evt])
          if (type === 'done') source.close()
        } catch {
          /* ignore malformed frame */
        }
      }
      source.addEventListener('agent_thinking', handle('agent_thinking'))
      source.addEventListener('tool_invoked', handle('tool_invoked'))
      source.addEventListener('tool_result', handle('tool_result'))
      source.addEventListener('question_asked', handle('question_asked'))
      source.addEventListener('done', handle('done'))
      source.onerror = () => source.close()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Researcher</h1>
      {!session && (
        <>
          <p className="text-sm text-gray-600">
            Describe the feature you want a PRD for. The agent will respond.
          </p>
          <form onSubmit={onSubmit} className="space-y-3">
            <textarea
              aria-label="initial prompt"
              className="min-h-32 w-full rounded border border-gray-300 p-2 font-mono text-sm"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="I want to add a dark-mode toggle…"
            />
            <button
              type="submit"
              disabled={submitting || prompt.trim().length === 0}
              className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
            >
              {submitting ? 'Starting…' : 'Start Research Session'}
            </button>
          </form>
        </>
      )}

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {session && (
        <section className="space-y-2">
          <div className="text-xs text-gray-500">
            session: <code>{session.sessionId}</code>
          </div>
          <ol className="space-y-2">
            {events.map((evt) =>
              evt.type === 'question_asked' ? (
                <li key={evt.id}>
                  <QuestionCard
                    sessionId={session.sessionId}
                    question={evt as QuestionAskedEvent}
                  />
                </li>
              ) : (
                <li
                  key={evt.id}
                  className="rounded border border-gray-200 p-2 text-sm"
                >
                  <div className="text-xs uppercase tracking-wide text-gray-500">
                    {evt.type}
                  </div>
                  <pre className="whitespace-pre-wrap text-sm">
                    {renderEvent(evt)}
                  </pre>
                </li>
              ),
            )}
          </ol>
        </section>
      )}
    </main>
  )
}

function renderEvent(evt: AgentEvent): string {
  switch (evt.type) {
    case 'agent_thinking':
      return evt.text
    case 'tool_invoked':
      return `${evt.toolName}(${JSON.stringify(evt.args)})`
    case 'tool_result':
      return `→ ${JSON.stringify(evt.result)}`
    case 'done':
      return evt.finalText
    case 'question_asked':
      return `${evt.question}\n\n→ recommendation: ${evt.recommendation}\n→ rationale: ${evt.rationale}`
  }
}
