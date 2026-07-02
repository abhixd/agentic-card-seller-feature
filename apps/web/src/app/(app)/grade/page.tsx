'use client'

import { useState } from 'react'
import type { GradeResult, CardProfile } from '@/lib/grading/types'
import { GradeResultCompact } from '@/components/grading/GradeResultCompact'
import { GradeFeedback } from '@/components/grading/GradeFeedback'
import { DefectsPanel } from '@/components/grading/DefectsPanel'

export default function GradePage() {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [result, setResult] = useState<GradeResult | null>(null)
  const [profile, setProfile] = useState<CardProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    setFile(f)
    setResult(null)
    setProfile(null)
    setError(null)
    setShowOriginal(false)
    setPreview(f ? URL.createObjectURL(f) : null)
  }

  async function grade() {
    if (!file) return
    setLoading(true)
    setError(null)
    setResult(null)
    setProfile(null)
    try {
      const fd = new FormData()
      fd.append('image', file)
      const res = await fetch('/api/grade?zoom=1', { method: 'POST', body: fd })   // include high-res defect close-ups
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Grading failed')
      setResult(data as GradeResult)
      void identifyCard(file)   // hydrate identity + profile from /scout (same photo); non-blocking
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Grading failed')
    } finally {
      setLoading(false)
    }
  }

  // /grade returns the grade fast (CV); identity needs a Claude vision read, so fetch it from /scout
  // separately and let the profile fill in once it resolves — the grade card paints immediately.
  async function identifyCard(f: File) {
    setProfileLoading(true)
    try {
      const fd = new FormData()
      fd.append('image', f)
      const res = await fetch('/api/scout', { method: 'POST', body: fd })
      const data = await res.json()
      if (res.ok && data?.identity) {
        setProfile({
          identity: { ...data.identity, rarity: data.comps_detail?.card?.rarity ?? null },
          comps: data.comps_detail ?? null,
          thumb_b64: data.thumb_b64 ?? null,
        })
      }
    } catch {
      /* identity is best-effort — a failed read just leaves "card not identified" */
    } finally {
      setProfileLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Grade a card</h1>
        <p className="text-sm text-muted-foreground">Upload a card front — the same CV grader the browser extension uses.</p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border p-3">
        <input type="file" accept="image/*" onChange={onPick} className="min-w-0 flex-1 text-sm" />
        <button
          onClick={grade}
          disabled={!file || loading}
          className="shrink-0 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {loading ? 'Grading…' : 'Grade'}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {result ? (
        // After grading: card + grade on the LEFT, all the details on the RIGHT — reviewable in one scan.
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {/* LEFT — the graded card + grade + centering (GradeResultCompact is itself image-left / scores-right) */}
          <div className="space-y-3">
            <GradeResultCompact result={result} profile={profile} profileLoading={profileLoading} />

            {/* the original upload is hidden after grading — let the user pull it back up to double-check */}
            {preview && (
              <div>
                <button
                  onClick={() => setShowOriginal((v) => !v)}
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  {showOriginal ? 'Hide original photo' : 'View original photo'}
                </button>
                {showOriginal && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview} alt="original upload" className="mt-2 w-full rounded-md border object-contain" />
                )}
              </div>
            )}
          </div>

          {/* RIGHT — defects, the centering feedback, notes, and the grading reference */}
          <div className="space-y-3">
            <DefectsPanel warpedJpegB64={result._warped_jpeg_b64} defects={result.defect_boxes} />

            <GradeFeedback
              aspect="centering"
              question="Does this read look right?"
              context={{
                overall_score: result.overall_score,
                psa_equivalent: result.psa_equivalent,
                centering: result.centering,
                content_region: result.centering.content_region,
                card_boundary: result._card_boundary,
                border_type: result._border_type,
                grader_backend: result._grader_backend,
              }}
              warpedJpegB64={result._warped_jpeg_b64}
            />

            {result.summary && <p className="text-sm text-muted-foreground">{result.summary}</p>}
            {result.issues && result.issues.length > 0 && (
              <ul className="list-inside list-disc text-sm text-muted-foreground">
                {result.issues.map((it, i) => (
                  <li key={i}>{it}</li>
                ))}
              </ul>
            )}

            <GradingReference />
          </div>
        </div>
      ) : (
        // Before grading: show the upload preview and the grading reference.
        <>
          {preview && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="card preview" className="mx-auto max-h-80 rounded-md border object-contain" />
          )}
          <GradingReference />
        </>
      )}
    </div>
  )
}

// ── Grading reference: when it's worth it + PSA fee tiers. Two tables side-by-side on wider viewports (compact). ──
function GradingReference() {
  return (
    <div className="grid gap-4 border-t border-border/30 pt-4 sm:grid-cols-2">
      <div className="space-y-2">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">When grading makes sense</p>
        <div className="rounded-xl overflow-hidden border border-border/30 divide-y divide-border/20">
          {[
            { label: 'Raw card value', threshold: '≥ $20', why: 'Fixed PSA fees eat into margins below this' },
            { label: 'Condition', threshold: 'NM or better', why: 'Anything below NM rarely grades PSA 9+' },
            { label: 'Demand', threshold: 'Active comps', why: 'Graded cards need buyers — niche cards may sit' },
            { label: 'Gem premium', threshold: '2× raw or more', why: 'PSA 10 should be worth ≥ 2× raw to justify the risk' },
          ].map((r) => (
            <div key={r.label} className="flex items-start justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium">{r.label}</p>
                <p className="text-[10px] text-muted-foreground leading-snug mt-0.5">{r.why}</p>
              </div>
              <span className="text-[11px] font-semibold text-indigo-400 shrink-0 tabular-nums mt-0.5">{r.threshold}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">PSA submission fees</p>
        <div className="rounded-xl overflow-hidden border border-border/30 divide-y divide-border/20">
          {[
            { name: 'Value', cost: 18, turnaround: '~100 days' },
            { name: 'Economy', cost: 25, turnaround: '~65 days' },
            { name: 'Regular', cost: 50, turnaround: '~20 days' },
            { name: 'Express', cost: 150, turnaround: '~10 days' },
          ].map((t) => (
            <div key={t.name} className="flex items-center justify-between px-3 py-2">
              <div>
                <p className="text-xs font-medium">{t.name}</p>
                <p className="text-[10px] text-muted-foreground">{t.turnaround}</p>
              </div>
              <span className="text-sm font-bold tabular-nums">${t.cost}</span>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground/60">Approximate PSA pricing — tiers and turnaround change periodically.</p>
      </div>
    </div>
  )
}
