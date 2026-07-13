'use client'

/**
 * /grade — the B2C "Drop → Reveal → Explore" flow.
 *
 * One click means zero clicks: dropping / pasting / picking a photo STARTS the grade — there is no
 * Grade button. While the grader runs, the photo shows a scanning animation with staged captions
 * (the pipeline as theater), then GradeResultCompact reveals the grade badge + value + verdict.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GradeResult, CardProfile } from '@/lib/grading/types'
import { GradeResultCompact } from '@/components/grading/GradeResultCompact'
import { GradeFeedback } from '@/components/grading/GradeFeedback'
import { DefectsPanel } from '@/components/grading/DefectsPanel'

const SCAN_STEPS = [
  'Finding your card…',
  'Straightening the photo…',
  'Measuring centering…',
  'Inspecting corners, edges and surface…',
  'Scoring…',
]

export default function GradePage() {
  const [preview, setPreview] = useState<string | null>(null)
  const [lastFile, setLastFile] = useState<File | null>(null)
  const [result, setResult] = useState<GradeResult | null>(null)
  const [profile, setProfile] = useState<CardProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [scanStep, setScanStep] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Dropping a photo IS the trigger — grade immediately, no second click.
  const gradeFile = useCallback(async (f: File) => {
    setLastFile(f)
    setResult(null)
    setProfile(null)
    setError(null)
    setShowOriginal(false)
    setPreview(URL.createObjectURL(f))
    setLoading(true)
    setScanStep(0)
    try {
      const fd = new FormData()
      fd.append('image', f)
      const res = await fetch('/api/grade?zoom=1', { method: 'POST', body: fd })   // include high-res defect close-ups
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Grading failed')
      setResult(data as GradeResult)
      void identifyCard(f)   // hydrate identity + comps from /scout (same photo); non-blocking
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Grading failed')
    } finally {
      setLoading(false)
    }
  }, [])

  // Re-run the grade with a user-corrected outer boundary (manual-contour path: SAM3 skipped, the
  // warp is rebuilt from the corrected corners, and registration/retrieval get a clean crop).
  const regradeWithContour = useCallback(async (corners: number[][]) => {
    if (!lastFile) return
    setError(null)
    setLoading(true)
    setScanStep(0)
    try {
      const fd = new FormData()
      fd.append('image', lastFile)
      fd.append('contour', JSON.stringify(corners))
      const res = await fetch('/api/grade?zoom=1', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Re-grade failed')
      setResult(data as GradeResult)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Re-grade failed')
    } finally {
      setLoading(false)
    }
  }, [lastFile])

  // /grade returns the grade fast (CV); identity needs a Claude vision read, so fetch it from /scout
  // separately and let the profile (and the verdict's dollar figures) fill in once it resolves.
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

  // Paste-to-grade: ⌘V a screenshot or copied image anywhere on the page.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
      const f = item?.getAsFile()
      if (f) void gradeFile(f)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [gradeFile])

  // Staged scanning captions while the grader runs.
  useEffect(() => {
    if (!loading) return
    const t = setInterval(() => setScanStep((s) => Math.min(s + 1, SCAN_STEPS.length - 1)), 1600)
    return () => clearInterval(t)
  }, [loading])

  function reset() {
    setPreview(null)
    setLastFile(null)
    setResult(null)
    setProfile(null)
    setError(null)
    setShowOriginal(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  const idle = !loading && !result

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Grade a card</h1>
        <p className="text-sm text-muted-foreground">Drop a photo — get an instant AI grade and what it&apos;s worth.</p>
      </div>

      {/* ── Drop zone (idle) — drop / paste / click / camera all auto-grade ── */}
      {idle && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            const f = e.dataTransfer.files?.[0]
            if (f && f.type.startsWith('image/')) void gradeFile(f)
          }}
          className={`w-full rounded-xl border-2 border-dashed px-4 py-12 text-center transition-colors ${
            dragOver ? 'border-emerald-500 bg-emerald-500/5' : 'border-border hover:border-foreground/30 hover:bg-muted/30'
          }`}
        >
          <div className="text-3xl" aria-hidden>🃏</div>
          <p className="mt-2 text-base font-medium">Drop your card here</p>
          <p className="mt-0.5 text-sm text-muted-foreground">or paste a photo, click to browse, or use your camera</p>
          <p className="mt-3 text-xs text-muted-foreground/70">⚡ instant AI grade · free</p>
        </button>
      )}
      <input ref={inputRef} type="file" accept="image/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void gradeFile(f) }} />

      {error && (
        <div className="flex items-center justify-between rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2.5">
          <p className="text-sm text-red-600">{error}</p>
          <button onClick={reset} className="shrink-0 rounded-md border px-3 py-1 text-xs hover:bg-muted">Try another photo</button>
        </div>
      )}

      {/* ── Scanning (grading in flight) — the pipeline as theater ── */}
      {loading && preview && (
        <div className="mx-auto max-w-xs">
          <div className="relative overflow-hidden rounded-xl border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt="your card" className="block w-full object-contain" />
            <div className="absolute inset-0 bg-black/10" />
            <div className="scan-sweep absolute inset-x-0 h-16" />
          </div>
          <p className="mt-3 text-center text-sm text-muted-foreground" aria-live="polite">{SCAN_STEPS[scanStep]}</p>
          <style jsx>{`
            .scan-sweep {
              background: linear-gradient(to bottom, transparent, rgba(16, 185, 129, 0.25), rgba(16, 185, 129, 0.5), rgba(16, 185, 129, 0.25), transparent);
              animation: sweep 1.5s ease-in-out infinite alternate;
            }
            @keyframes sweep {
              from { top: -12%; }
              to { top: 96%; }
            }
          `}</style>
        </div>
      )}

      {/* ── Reveal + explore ── */}
      {result && (
        <>
          <GradeResultCompact result={result} profile={profile} profileLoading={profileLoading} onGradeAnother={reset} onRegrade={regradeWithContour} />

          <DefectsPanel warpedJpegB64={result._warped_jpeg_b64} defects={result.defect_boxes} />

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
                <img src={preview} alt="original upload" className="mx-auto mt-2 max-h-96 rounded-md border object-contain" />
              )}
            </div>
          )}

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
        </>
      )}

      {/* Grading reference stays for the curious — collapsed out of the main flow. */}
      {idle && <GradingReference />}
      {lastFile && idle && null}
    </div>
  )
}

// ── Grading reference: when it's worth it + PSA fee tiers. ──
function GradingReference() {
  return (
    <div className="space-y-4 pt-4 border-t border-border/30">
      <div className="space-y-2">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">When grading makes sense</p>
        <div className="rounded-xl overflow-hidden border border-border/30 divide-y divide-border/20">
          {[
            { label: 'Raw card value', threshold: '≥ $20', why: 'Fixed PSA fees eat into margins below this' },
            { label: 'Condition', threshold: 'NM or better', why: 'Anything below NM rarely grades PSA 9+' },
            { label: 'Demand', threshold: 'Active comps', why: 'Graded cards need buyers — niche cards may sit' },
            { label: 'Gem premium', threshold: '2× raw or more', why: 'PSA 10 should be worth ≥ 2× raw to justify the risk' },
          ].map((r) => (
            <div key={r.label} className="flex items-start justify-between gap-3 px-3 py-2.5">
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
            <div key={t.name} className="flex items-center justify-between px-3 py-2.5">
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
