import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/')({ component: App })

interface CreateSessionResponse {
  sessionId: string
  response: string
}

function App() {
  const [prompt, setPrompt] = useState('')
  const [response, setResponse] = useState<CreateSessionResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setResponse(null)
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
      setResponse((await res.json()) as CreateSessionResponse)
    } catch (err) {
      setError((err as Error).message)
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
          {submitting ? 'Thinking…' : 'Start Research Session'}
        </button>
      </form>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {response && (
        <section className="rounded border border-gray-200 p-3 text-sm">
          <div className="mb-2 text-xs text-gray-500">
            session: <code>{response.sessionId}</code>
          </div>
          <div className="whitespace-pre-wrap">{response.response}</div>
        </section>
      )}
    </main>
  )
}
