'use client'

/**
 * GradeResultCompact — the reorganized /grade result: one screen, card-with-inline-correction on
 * the left, all scores on the right, identity on top and a grade-based price next to the grade.
 * Dragging a centering handle recomputes centering + overall + PSA + suggested price LIVE
 * (lib/grading/score.ts mirrors the server), and reveals Save (→ /api/grade/corrections).
 *
 * identity / pricing are PLACEHOLDER props for now — wire vision-ID and a graded-price source
 * behind them later (pricing is keyed by PSA grade so it tracks a correction that changes the grade).
 */
import { useRef, useState } from 'react'
import type { GradeResult, CardIdentity, CardProfile } from '@/lib/grading/types'
import { type Box, ratiosFromBox, centeringScore, overallScore, psaLabel } from '@/lib/grading/score'
import { PillarVisualDialog } from './PillarVisualDialog'
import { CardProfileModal } from './CardProfileModal'
import { DefectZoomGallery } from './DefectZoomGallery'

const EDGE = '#3b82f6'   // card edge (outer)
const BORDER = '#10b981' // print border (inner)
type Side = 'top' | 'bottom' | 'left' | 'right'

export type { CardIdentity }
export type GradePricing = Record<number, { market: number; list: number }>  // by PSA grade

function parseRatio(s?: string): [number, number] {
  const p = (s ?? '').split('/').map((n) => parseInt(n, 10))
  return p.length === 2 && !p.some(Number.isNaN) ? [p[0], p[1]] : [50, 50]
}
const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

function PillarRow({ label, score, highlight, onClick }: { label: string; score: number; highlight?: boolean; onClick?: () => void }) {
  const cls = `flex w-full items-center gap-2.5 rounded-md px-2 py-1 text-left ${highlight ? 'bg-emerald-500/10' : ''} ${onClick ? 'cursor-pointer hover:bg-muted/60' : ''}`
  const body = (
    <>
      <span className={`w-16 text-[13px] ${highlight ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground'}`}>{label}</span>
      <div className="h-[5px] flex-1 rounded-full bg-muted">
        <div className={`h-[5px] rounded-full ${highlight ? 'bg-emerald-500' : 'bg-foreground/40'}`} style={{ width: `${Math.max(0, Math.min(100, score * 10))}%` }} />
      </div>
      <span className="w-6 text-right text-[13px] font-medium tabular-nums">{score.toFixed(1)}</span>
      {onClick && <span className="text-[11px] text-muted-foreground/50" aria-hidden>⤢</span>}
    </>
  )
  return onClick
    ? <button type="button" onClick={onClick} title="See what we measured" className={cls}>{body}</button>
    : <div className={cls}>{body}</div>
}

export function GradeResultCompact({
  result,
  profile,
  profileLoading,
  pricing,
}: {
  result: GradeResult
  profile?: CardProfile | null
  profileLoading?: boolean
  pricing?: GradePricing
}) {
  const cb = result._card_boundary && result._card_boundary.length === 4 ? result._card_boundary : null
  const cr0 = result.centering.content_region ?? null
  const warped = result._warped_jpeg_b64

  const [editing, setEditing] = useState(false)
  const [box, setBox] = useState<Box | null>(cr0 ? { ...cr0 } : null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [openPillar, setOpenPillar] = useState<string | null>(null)
  const [showProfile, setShowProfile] = useState(false)
  const [showZooms, setShowZooms] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const drag = useRef<Side | null>(null)
  const pv = result.pillar_visuals
  const hasVisual = (p: string) => !!pv && !!pv[p as keyof typeof pv]
  const identity = profile?.identity

  // Live scores: server values until the user edits, then recompute from the dragged box.
  const liveRatios = box && cb && dirty ? ratiosFromBox(box, cb) : null
  const [lr0, tb0] = [parseRatio(result.centering.left_right), parseRatio(result.centering.top_bottom)]
  const lr = liveRatios ? [liveRatios.lr, 100 - liveRatios.lr] : lr0
  const tb = liveRatios ? [liveRatios.tb, 100 - liveRatios.tb] : tb0
  const cenScore = liveRatios ? centeringScore(liveRatios.lr, liveRatios.tb) : result.centering.score
  const pillars = { centering: cenScore, corners: result.corners.score, edges: result.edges.score, surface: result.surface.score }
  const overall = dirty ? overallScore(pillars) : result.overall_score
  const psa = dirty ? psaLabel(overall) : result.psa_equivalent
  const grade = Math.max(1, Math.min(10, Math.round(overall)))
  const price = pricing?.[grade] ?? null

  // ── drag: pointer capture on the handle — the captured DOM node (keyed) survives the
  // re-renders the drag triggers, so moves keep flowing to the current-render handler ──
  function norm(e: React.PointerEvent) {
    const r = wrap.current!.getBoundingClientRect()
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }
  }
  function onHandleDown(side: Side, e: React.PointerEvent) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = side
  }
  function onHandleMove(side: Side, e: React.PointerEvent) {
    if (drag.current !== side) return
    const { x, y } = norm(e)
    setDirty(true)
    setBox((b) => {
      if (!b) return b
      const n = { ...b }
      if (side === 'top') n.y1 = Math.min(y, b.y2 - 0.02)
      else if (side === 'bottom') n.y2 = Math.max(y, b.y1 + 0.02)
      else if (side === 'left') n.x1 = Math.min(x, b.x2 - 0.02)
      else if (side === 'right') n.x2 = Math.max(x, b.x1 + 0.02)
      return n
    })
  }
  function onHandleUp(side: Side, e: React.PointerEvent) {
    if (drag.current === side) {
      e.currentTarget.releasePointerCapture(e.pointerId)
      drag.current = null
    }
  }

  async function save() {
    if (!box || !cb) return
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/grade/corrections', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originalContentRegion: cr0, correctedContentRegion: box, cardBoundary: cb,
          originalLeftRight: result.centering.left_right, originalTopBottom: result.centering.top_bottom,
          leftRight: `${lr[0]}/${lr[1]}`, topBottom: `${tb[0]}/${tb[1]}`,
          borderType: result._border_type, graderBackend: result._grader_backend, warpedJpegB64: warped,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Could not save correction.')
      setSaved(true); setEditing(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save correction.')
    } finally { setSaving(false) }
  }

  const showOverlay = !!(warped && cb && box)
  const handles: { side: Side; x: number; y: number; cur: string }[] = box
    ? [
        { side: 'top', x: ((box.x1 + box.x2) / 2) * 100, y: box.y1 * 100, cur: 'cursor-ns-resize' },
        { side: 'bottom', x: ((box.x1 + box.x2) / 2) * 100, y: box.y2 * 100, cur: 'cursor-ns-resize' },
        { side: 'left', x: box.x1 * 100, y: ((box.y1 + box.y2) / 2) * 100, cur: 'cursor-ew-resize' },
        { side: 'right', x: box.x2 * 100, y: ((box.y1 + box.y2) / 2) * 100, cur: 'cursor-ew-resize' },
      ]
    : []

  return (
    <div className="rounded-lg border p-4">
      {/* identity — vision-ID hydrated from /scout; click to open the card profile */}
      <div className="mb-3 border-b pb-3">
        {identity?.name ? (
          <button
            type="button"
            onClick={() => profile && setShowProfile(true)}
            className="flex w-full items-start justify-between gap-2 rounded-md px-1 py-0.5 text-left hover:bg-muted/60"
            title="View card profile"
          >
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-medium">{identity.name}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {[identity.set, identity.number && `#${identity.number}`, identity.rarity].filter(Boolean).join(' · ') || 'tap for details'}
                {identity.confidence != null && <span className="text-foreground/40"> · ID {Math.round(identity.confidence * 100)}%</span>}
              </span>
            </span>
            <span className="shrink-0 self-center text-[11px] text-blue-600 dark:text-blue-400">profile ↗</span>
          </button>
        ) : (
          <div className="px-1">
            <div className="text-[15px] font-medium">{profileLoading ? 'Identifying…' : <span className="text-muted-foreground">Card details</span>}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {profileLoading ? 'reading the card from your photo' : 'card not identified — try a clearer, straight-on photo'}
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-[240px_1fr]">
        {/* LEFT: card + inline correction */}
        <div>
          <div ref={wrap} className={`relative overflow-hidden rounded-md border ${editing ? 'touch-none select-none ring-2 ring-emerald-500/40' : ''}`}>
            {warped ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`data:image/jpeg;base64,${warped}`} alt="graded card" className="block w-full" draggable={false} />
            ) : (
              <div className="flex aspect-[5/7] w-full items-center justify-center text-xs text-muted-foreground">no preview</div>
            )}
            {showOverlay && (
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full">
                <rect x={cb![0] * 100} y={cb![1] * 100} width={(cb![2] - cb![0]) * 100} height={(cb![3] - cb![1]) * 100} fill="none" stroke={EDGE} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                <rect x={box!.x1 * 100} y={box!.y1 * 100} width={(box!.x2 - box!.x1) * 100} height={(box!.y2 - box!.y1) * 100} fill="none" stroke={BORDER} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              </svg>
            )}
            {editing && handles.map((h) => (
              <span key={h.side}
                onPointerDown={(e) => onHandleDown(h.side, e)}
                onPointerMove={(e) => onHandleMove(h.side, e)}
                onPointerUp={(e) => onHandleUp(h.side, e)}
                className={`absolute size-3 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border border-white bg-emerald-500 shadow ${h.cur}`}
                style={{ left: `${h.x}%`, top: `${h.y}%` }} />
            ))}
          </div>
          {saved ? (
            <p className="mt-2 text-[11px] text-emerald-600">✓ Saved — thanks, this trains the grader.</p>
          ) : editing ? (
            <div className="mt-2 flex gap-2">
              <button onClick={save} disabled={saving || !dirty} className="flex-1 rounded-md bg-foreground px-2 py-1.5 text-xs font-medium text-background disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
              <button onClick={() => { setEditing(false); setBox(cr0 ? { ...cr0 } : null); setDirty(false) }} className="rounded-md border px-2 py-1.5 text-xs">Cancel</button>
            </div>
          ) : (
            showOverlay && (
              <button onClick={() => setEditing(true)} className="mt-2 w-full text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                Centering off? ✏️ Adjust borders
              </button>
            )
          )}
          {err && <p className="mt-1 text-[11px] text-red-600">{err}</p>}
        </div>

        {/* RIGHT: grade + price + pillars + centering */}
        <div className="min-w-0 space-y-3">
          <div className="flex gap-2.5">
            <div className="flex-1 rounded-md border px-3 py-2">
              <div className="text-[11px] text-muted-foreground">Estimated grade</div>
              <div className="text-xl font-semibold tabular-nums text-emerald-600">{psa.split(' ').slice(0, 2).join(' ')}</div>
              <div className="text-[11px] text-muted-foreground tabular-nums">overall {overall.toFixed(1)} / 10</div>
            </div>
            <div className="flex-[1.3] rounded-md bg-emerald-500/10 px-3 py-2">
              <div className="text-[11px] text-emerald-700 dark:text-emerald-400">Suggested list{price ? '' : ' (soon)'}</div>
              <div className="text-xl font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">{price ? money(price.list) : '$—'}</div>
              <div className="text-[11px] text-emerald-700/80 dark:text-emerald-400/80 tabular-nums">{price ? `market ~${money(price.market)} · after fees` : `at ${psa.split(' ').slice(0, 2).join(' ')} · pricing coming soon`}</div>
            </div>
          </div>

          <div className="space-y-1">
            <PillarRow label="centering" score={pillars.centering} highlight onClick={hasVisual('centering') ? () => setOpenPillar('centering') : undefined} />
            {/* surface / edges / corners defects are shown by the rf-detr DefectsPanel selection below — the old
                per-pillar CV popup images were redundant, so these bars are non-interactive. */}
            <PillarRow label="corners" score={pillars.corners} />
            <PillarRow label="edges" score={pillars.edges} />
            <PillarRow label="surface" score={pillars.surface} />
          </div>

          <div className="flex items-center gap-4 border-t pt-2 text-[13px]">
            <span><span className="text-muted-foreground">L/R</span>&nbsp; <span className="tabular-nums">{lr[0]}/{lr[1]}</span></span>
            <span><span className="text-muted-foreground">T/B</span>&nbsp; <span className="tabular-nums">{tb[0]}/{tb[1]}</span></span>
            {dirty && <span className="ml-auto text-[11px] text-emerald-600">updated live</span>}
            {!dirty && result.centering.reliable === false && <span className="ml-auto text-[11px] text-amber-600">low-confidence read</span>}
          </div>
        </div>
      </div>
      {result.pillar_zooms && (
        <button
          type="button"
          onClick={() => setShowZooms(true)}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed py-2 text-[13px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          🔍 Inspect defect close-ups <span className="text-muted-foreground/60">— high-res edges, corners &amp; surface</span>
        </button>
      )}
      <PillarVisualDialog pillar={openPillar} visuals={result.pillar_visuals} onClose={() => setOpenPillar(null)} />
      <CardProfileModal profile={showProfile ? profile ?? null : null} onClose={() => setShowProfile(false)} />
      <DefectZoomGallery zooms={showZooms ? result.pillar_zooms ?? null : null} onClose={() => setShowZooms(false)} />
    </div>
  )
}
