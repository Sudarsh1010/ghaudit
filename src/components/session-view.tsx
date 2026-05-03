/**
 * `SessionView` — the live agent panel + PRD pane for one Research
 * Session. Mounted by both `/` (after the user submits the initial
 * prompt) and `/session/$id` (when the user reopens the URL with the
 * cookie still set).
 *
 * The component subscribes to `/session/<id>/stream` and routes typed
 * `AgentEvent`s through the same Effect Schema decoder the original
 * `/` route used. If `EventSource.onerror` fires before any event has
 * arrived we assume the session is gated (most likely a 403 from the
 * cookie check) and render the "not accessible" state. After the
 * first event arrives we treat further `onerror`s as transient drops.
 *
 * Slice 6 ships URL-keyed access; Slice 5 will add Last-Event-ID
 * replay so reopening the URL after a disconnect catches up the
 * missed events. Today reopening yields a fresh EventSource against
 * the live tail.
 */
import { useEffect, useRef, useState } from 'react'
import { Effect } from 'effect'
import {
  decodeMessageEvent,
  type AgentEvent,
  type ErrorEvent,
  type QuestionAskedEvent,
} from '~/shared/sse/events'
import { QuestionCard } from '~/components/question-card'

export interface SessionViewProps {
  readonly sessionId: string
}

export function SessionView({ sessionId }: SessionViewProps) {
  const [events, setEvents] = useState<Array<AgentEvent>>([])
  const [accessDenied, setAccessDenied] = useState(false)
  const sourceRef = useRef<EventSource | null>(null)
  const receivedAnyRef = useRef(false)

  useEffect(() => {
    receivedAnyRef.current = false
    setAccessDenied(false)
    setEvents([])

    const source = new EventSource(`/session/${sessionId}/stream`)
    sourceRef.current = source

    const handle = (type: AgentEvent['type']) => (e: MessageEvent) => {
      Effect.runPromise(
        decodeMessageEvent(type, {
          lastEventId: e.lastEventId,
          data: e.data,
        }),
      )
        .then((evt) => {
          receivedAnyRef.current = true
          setEvents((prev) => [...prev, evt])
          if (type === 'done') source.close()
        })
        .catch(() => {
          /* ignore malformed frame */
        })
    }
    source.addEventListener('agent_thinking', handle('agent_thinking'))
    source.addEventListener('tool_invoked', handle('tool_invoked'))
    source.addEventListener('tool_result', handle('tool_result'))
    source.addEventListener('question_asked', handle('question_asked'))
    source.addEventListener(
      'prd_section_written',
      handle('prd_section_written'),
    )
    source.addEventListener('done', handle('done'))
    source.addEventListener('error', handle('error'))
    source.onerror = () => {
      // EventSource doesn't expose the HTTP status. A failure before any
      // event arrived is almost always the 403 from the cookie check
      // (the only other possibility is a network blip pre-connect).
      if (!receivedAnyRef.current) {
        setAccessDenied(true)
      }
      source.close()
    }

    return () => source.close()
  }, [sessionId])

  if (accessDenied) {
    return <SessionNotAccessible sessionId={sessionId} />
  }

  return (
    <div className="space-y-4">
      <ErrorBanners events={events} />
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <div className="text-xs text-gray-500">
            session: <code>{sessionId}</code>
          </div>
          <ol className="space-y-2">
            {events.map((evt) =>
              evt.type === 'question_asked' ? (
                <li key={evt.id}>
                  <QuestionCard
                    sessionId={sessionId}
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
        </div>
        <PrdPane sessionId={sessionId} events={events} />
      </section>
    </div>
  )
}

/**
 * Renders the retry / failed status above the event timeline.
 *
 *   - `error/failed` is **persistent**: once it appears, the session is
 *     dead — the loop won't recover, and the user needs to know it
 *     reached a terminal state.
 *   - `error/retry` is **transient**: the loop is still trying. We only
 *     show the retry banner when the *most recent* event is a retry; as
 *     soon as a successful turn (`agent_thinking`, `tool_invoked`, …)
 *     comes through, the banner clears.
 *
 * `failed` takes precedence over `retry` — once a session has failed,
 * even past retry events shouldn't shadow that.
 */
function ErrorBanners({ events }: { events: ReadonlyArray<AgentEvent> }) {
  const failed = events.find(
    (e): e is ErrorEvent => e.type === 'error' && e.kind === 'failed',
  )
  const last = events[events.length - 1]
  const retry: ErrorEvent | undefined =
    !failed && last?.type === 'error' && last.kind === 'retry'
      ? last
      : undefined

  if (!failed && !retry) return null

  return (
    <div className="space-y-2" role="status" aria-live="polite">
      {failed && (
        <div
          role="alert"
          className="rounded border border-red-400 bg-red-50 p-3 text-sm text-red-800"
        >
          <div className="font-semibold">Session failed</div>
          <div className="mt-1 whitespace-pre-wrap">{failed.reason}</div>
        </div>
      )}
      {retry && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <div className="font-semibold">
            Retrying… (attempt {retry.attempt ?? '?'} of 3)
          </div>
          <div className="mt-1 whitespace-pre-wrap">{retry.reason}</div>
        </div>
      )}
    </div>
  )
}

function PrdPane({
  sessionId,
  events,
}: {
  sessionId: string
  events: Array<AgentEvent>
}) {
  const sections = new Map<string, string>()
  for (const evt of events) {
    if (evt.type === 'prd_section_written') {
      sections.set(evt.section, evt.content)
    }
  }
  const isDone = events.some((e) => e.type === 'done')

  return (
    <aside className="space-y-2 rounded border border-gray-200 bg-gray-50 p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">
          PRD
        </h2>
        {isDone && (
          <a
            href={`/session/${sessionId}/prd`}
            className="text-xs text-blue-700 underline"
          >
            Download .md
          </a>
        )}
      </div>
      {sections.size === 0 && (
        <div className="text-xs text-gray-500">
          PRD sections will appear here as the agent writes them.
        </div>
      )}
      {[...sections.entries()].map(([section, content]) => (
        <div key={section}>
          <div className="text-xs font-semibold uppercase text-gray-500">
            {section}
          </div>
          <div className="whitespace-pre-wrap text-sm">{content}</div>
        </div>
      ))}
    </aside>
  )
}

function SessionNotAccessible({ sessionId }: { sessionId: string }) {
  return (
    <section className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
      <h2 className="mb-2 text-base font-semibold">Session not accessible</h2>
      <p>
        This session belongs to a different browser. Sessions are bound to the
        cookie of the device that created them, so reopening the URL on another
        browser, in incognito, or after clearing cookies will not work.
      </p>
      <p className="mt-2 text-xs text-amber-700">
        Session id: <code>{sessionId}</code>
      </p>
      <a
        href="/"
        className="mt-3 inline-block rounded bg-amber-600 px-3 py-1 text-xs font-medium text-white"
      >
        Start a new session
      </a>
    </section>
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
    case 'prd_section_written':
      return `[${evt.section}] ${evt.content.slice(0, 80)}…`
    case 'error':
      return evt.kind === 'retry'
        ? `retrying (attempt ${evt.attempt ?? '?'}): ${evt.reason}`
        : `failed: ${evt.reason}`
  }
}
