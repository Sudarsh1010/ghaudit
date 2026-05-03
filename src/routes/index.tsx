/**
 * `/` — landing page. Just the prompt form. After a successful
 * `createSessionFn` call the browser navigates to `/session/$id` (the
 * durable URL set up by Slice 6); the `Set-Cookie` from that response
 * is in place by the time the new route mounts and opens its
 * `EventSource`.
 *
 * This route used to host the live event panel inline, which couples
 * the URL to UI lifecycle (a refresh would lose the session). Slice 6
 * splits the two: this route only mints, the session URL hosts the
 * stream.
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { createSessionFn } from '~/server-fns/session'

export const Route = createFileRoute('/')({ component: App })

function App() {
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const created = await createSessionFn({
        data: { initialPrompt: prompt },
      })
      // The `Set-Cookie` header from the create response is now in the
      // browser; navigating to /session/$id loads `SessionView`, which
      // opens the SSE connection — the request will carry the cookie.
      await navigate({
        to: '/session/$id',
        params: { id: created.sessionId },
      })
    } catch (err) {
      setError(formatError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Researcher</h1>
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

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </main>
  )
}

/**
 * Per-route formatter for thrown server-fn errors. We only special-case
 * `RequestRateLimited` here so the user sees a "try again in N seconds"
 * message instead of the raw tagged-error string. Everything else falls
 * back to `err.message`, which already carries `<tag>: <detail>`.
 *
 * The shape `{ tag, retryAfterSeconds }` is stamped on by `renderError`
 * (see `~/shared/domain/http-errors.ts`).
 */
function formatError(err: unknown): string {
  const tagged = err as {
    readonly tag?: string
    readonly retryAfterSeconds?: number
  }
  if (tagged.tag === 'RequestRateLimited' && tagged.retryAfterSeconds) {
    return `Rate limited — try again in ${tagged.retryAfterSeconds} seconds.`
  }
  return (err as Error).message
}
