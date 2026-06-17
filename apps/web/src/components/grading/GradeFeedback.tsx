'use client'

/**
 * GradeFeedback — thumbs up/down on a grade read, with an optional follow-up note.
 *
 * The thumb POSTs immediately (so the binary signal is never lost if the user bails),
 * snapshotting the full grade context + the warped image; an optional note is PATCHed
 * onto the same row afterwards. Reusable per aspect — placed under the centering panel
 * today, droppable on the overall grade later by changing `aspect`/`question`.
 */
import { useState } from 'react'
import { ThumbsUp, ThumbsDown, Check, Loader2 } from 'lucide-react'
import type { CenteringResult } from '@/lib/grading/types'

type Verdict = 'up' | 'down'

export interface GradeFeedbackContext {
  overall_score?: number
  psa_equivalent?: string
  centering?: Pick<CenteringResult, 'score' | 'left_right' | 'top_bottom' | 'reliable'> & {
    content_region?: CenteringResult['content_region']
  }
  content_region?: CenteringResult['content_region']
  card_boundary?: number[]
  border_type?: string
  grader_backend?: string
}

export function GradeFeedback({
  aspect = 'centering',
  question = 'Does this read look right?',
  context,
  warpedJpegB64,
}: {
  aspect?: 'centering' | 'overall'
  question?: string
  context: GradeFeedbackContext
  warpedJpegB64?: string
}) {
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [voting, setVoting] = useState(false)
  const [feedbackId, setFeedbackId] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [commentState, setCommentState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function vote(v: Verdict) {
    if (voting || verdict) return
    setVoting(true)
    setError(null)
    setVerdict(v) // optimistic
    try {
      const res = await fetch('/api/grade/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict: v, aspect, context, warpedJpegB64 }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Could not save feedback.')
      setFeedbackId(data.feedbackId ?? null)
    } catch (err) {
      setVerdict(null) // let them retry
      setError(err instanceof Error ? err.message : 'Could not save feedback.')
    } finally {
      setVoting(false)
    }
  }

  async function sendComment() {
    if (!feedbackId || !comment.trim() || commentState === 'sending') return
    setCommentState('sending')
    setError(null)
    try {
      const res = await fetch('/api/grade/feedback', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedbackId, comment: comment.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Could not send note.')
      setCommentState('sent')
    } catch (err) {
      setCommentState('idle')
      setError(err instanceof Error ? err.message : 'Could not send note.')
    }
  }

  const btnBase =
    'inline-flex size-8 items-center justify-center rounded-md border transition-colors disabled:opacity-50'

  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {verdict ? 'Thanks for the feedback.' : question}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Looks right"
            disabled={voting || !!verdict}
            onClick={() => vote('up')}
            className={`${btnBase} ${verdict === 'up' ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-600' : 'hover:bg-muted'}`}
          >
            {voting && verdict === 'up' ? <Loader2 className="size-4 animate-spin" /> : <ThumbsUp className="size-4" />}
          </button>
          <button
            type="button"
            aria-label="Looks wrong"
            disabled={voting || !!verdict}
            onClick={() => vote('down')}
            className={`${btnBase} ${verdict === 'down' ? 'border-red-500/50 bg-red-500/15 text-red-600' : 'hover:bg-muted'}`}
          >
            {voting && verdict === 'down' ? <Loader2 className="size-4 animate-spin" /> : <ThumbsDown className="size-4" />}
          </button>
        </div>
      </div>

      {verdict && commentState !== 'sent' && (
        <div className="mt-3 space-y-2">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={2000}
            rows={2}
            placeholder={
              verdict === 'down'
                ? 'What looks off? (e.g. the green box is inside the art, top margin is wrong…)'
                : 'Anything to add? (optional)'
            }
            className="w-full resize-none rounded-md border bg-transparent p-2 text-sm outline-none focus:border-foreground/30"
          />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={sendComment}
              disabled={!comment.trim() || commentState === 'sending'}
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
            >
              {commentState === 'sending' ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Send note
            </button>
          </div>
        </div>
      )}

      {commentState === 'sent' && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald-600">
          <Check className="size-3.5" /> Got it — thanks for the detail.
        </p>
      )}

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  )
}
