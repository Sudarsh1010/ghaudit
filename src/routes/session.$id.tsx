/**
 * `/session/$id` — durable URL for resuming a Research Session.
 *
 * The cookie set by `POST /session` is `Path=/session/<id>`, so visiting
 * this URL on the originating browser ships the cookie with the SSE
 * connection and the session resumes. Visiting it from any other
 * context (different browser, incognito, cleared cookies) results in a
 * 403 from `GET /session/:id/stream`, which `SessionView` catches and
 * renders as the "not accessible" state.
 *
 * Replay of missed events on reconnect is gated on Slice 5
 * (`Last-Event-ID` plumbing). Until then, reopening the URL after a
 * disconnect attaches to the live tail.
 */
import { createFileRoute } from '@tanstack/react-router'
import { SessionView } from '~/components/session-view'

export const Route = createFileRoute('/session/$id')({ component: Page })

function Page() {
  const { id } = Route.useParams()
  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Researcher</h1>
      <SessionView sessionId={id} />
    </main>
  )
}
