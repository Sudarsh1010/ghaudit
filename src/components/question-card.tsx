import { useState } from 'react'
import type { QuestionAskedEvent } from '~/shared/sse/events'

export type AnswerKind = 'accept' | 'reject' | 'custom'

interface QuestionCardProps {
  sessionId: string
  question: QuestionAskedEvent
  onAnswered?: () => void
}

/**
 * Renders one HITL question with the agent's recommendation + rationale and
 * three response shapes:
 *   - Accept     → uses the recommendation as-is
 *   - Reject     → opens a textarea for the rejection reason
 *   - Custom     → opens a textarea for a user-supplied answer
 */
export function QuestionCard({
  sessionId,
  question,
  onAnswered,
}: QuestionCardProps) {
  const [mode, setMode] = useState<AnswerKind | null>(null)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [answered, setAnswered] = useState(false)

  const submit = async (kind: AnswerKind) => {
    setSubmitting(true)
    setError(null)
    try {
      const body =
        kind === 'accept'
          ? { kind }
          : { kind, value: text }
      const res = await fetch(
        `/session/${sessionId}/answer/${question.questionId}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error ?? `request failed: ${res.status}`)
      }
      setAnswered(true)
      onAnswered?.()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  if (answered) {
    return (
      <div className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-800">
        Answer sent. Waiting for the agent to resume…
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded border border-amber-300 bg-amber-50 p-4">
      <div>
        <div className="text-xs uppercase tracking-wide text-amber-700">
          Question
        </div>
        <div className="font-medium">{question.question}</div>
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-amber-700">
          Recommendation
        </div>
        <div>{question.recommendation}</div>
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-amber-700">
          Rationale
        </div>
        <div className="text-sm text-gray-700">{question.rationale}</div>
      </div>

      {mode === null && (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={() => submit('accept')}
            className="rounded bg-green-700 px-3 py-1 text-sm text-white disabled:opacity-50"
          >
            Accept
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => setMode('reject')}
            className="rounded border border-red-700 px-3 py-1 text-sm text-red-700"
          >
            Reject…
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => setMode('custom')}
            className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-700"
          >
            Custom answer…
          </button>
        </div>
      )}

      {mode !== null && (
        <div className="space-y-2">
          <textarea
            aria-label={`${mode} answer`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              mode === 'reject'
                ? 'Why are you rejecting this recommendation?'
                : 'Your answer…'
            }
            className="min-h-20 w-full rounded border border-gray-300 p-2 text-sm"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={submitting || text.trim().length === 0}
              onClick={() => submit(mode)}
              className="rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              Send
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => setMode(null)}
              className="rounded border px-3 py-1 text-sm"
            >
              Back
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded border border-red-300 bg-red-100 p-2 text-sm text-red-800">
          {error}
        </div>
      )}
    </div>
  )
}
