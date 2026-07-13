'use client'

/**
 * GradeResultCompact — the "reveal" screen of the B2C grade flow.
 *
 * Hierarchy (in order of what a collector asks): ① the grade — one big badge; ② what it's worth —
 * graded vs raw value from the profile comps; ③ should I grade it — the verdict banner; ④ why —
 * plain-language pillar rows (exact numbers live in tooltips). Power tools stay but stay quiet:
 * "Centering off? Adjust borders" under the card opens the drag-handle editor, which recomputes
 * centering + overall + PSA + verdict LIVE (lib/grading/score.ts mirrors the server) and reveals
 * Save (→ /api/grade/corrections).
 */
import { useRef, useState } from 'react'
import type { GradeResult, CardIdentity, CardProfile } from '@/lib/grading/types'
import { type Box, ratiosFromBox, centeringScore, overallScore, psaLabel } from '@/lib/grading/score'
import { warpBoxToSourceCorners } from '@/lib/grading/homography'
import { centeringPhrase, confidencePhrase, pillarNote, verdict, badgeWord } from '@/lib/grading/plain'
import { PillarVisualDialog } from './PillarVisualDialog'
import { CardProfileModal } from './CardProfileModal'
import { DefectZoomGallery } from './DefectZoomGallery'

const EDGE = '#3b82f6'   // card edge (outer)
const BORDER = '#10b981' // print border (inner)
type Side = 'top' | 'bottom' | 'left' | 'right'

export type { CardIdentity }

function parseRatio(s?: string): [number, number] {
  const p = (s ?? '').split('/').map((n) => parseInt(n, 10))
  return p.length === 2 && !p.some(Number.isNaN) ? [p[0], p[1]] : [50, 50]
}
const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

const BADGE_TONE = (g: number) =>
  g >= 9 ? { bg: 'bg-emerald-500/15', fg: 'text-emerald-600 dark:text-emerald-400', bar: 'bg-emerald-500' }
  : g >= 7 ? { bg: 'bg-amber-500/15', fg: 'text-amber-600 dark:text-amber-400', bar: 'bg-amber-500' }
  : { bg: 'bg-rose-500/15', fg: 'text-rose-600 dark:text-rose-400', bar: 'bg-rose-500' }

const VERDICT_TONE = {
  success: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  danger: 'bg-rose-500/10 text-rose-700 dark:text-rose-400',
} as const

function PillarRow({ label, score, note, weak, onClick, tooltip }: {
  label: string; score: number; note: string; weak?: boolean; onClick?: () => void; tooltip?: string
}) {
  const cls = `flex w-full items-center gap-2.5 rounded-md px-2 py-1 text-left ${onClick ? 'cursor-pointer hover:bg-muted/60' : ''}`
  const body = (
    <>
      <span className="w-[70px] shrink-0 text-[13px] text-muted-foreground">{label}</span>
      <div className="h-[5px] min-w-14 flex-1 rounded-full bg-muted">
        <div className={`h-[5px] rounded-full ${weak ? 'bg-amber-500' : 'bg-emerald-500/80'}`} style={{ width: `${Math.max(0, Math.min(100, score * 10))}%` }} />
      </div>
      <span className={`w-[118px] shrink-0 truncate text-right text-[12px] ${weak ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`} title={tooltip}>{note}</span>
      {onClick && <span className="text-[11px] text-muted-foreground/50" aria-hidden>⤢</span>}
    </>
  )
  return onClick
    ? <button type="button" onClick={onClick} title={tooltip ?? 'See what we measured'} className={cls}>{body}</button>
    : <div className={cls} title={tooltip}>{body}</div>
}

export function GradeResultCompact({
  result,
  profile,
  profileLoading,
  onGradeAnother,
  onRegrade,
}: {
  result: GradeResult
  profile?: CardProfile | null
  profileLoading?: boolean
  onGradeAnother?: () => void
  /** re-run the grade with user-corrected OUTER corners (source px) via the manual-contour path */
  onRegrade?: (corners: number[][]) => void
}) {
  const cb = result._card_boundary && result._card_boundary.length === 4 ? result._card_boundary : null
  const cr0 = result.centering.content_region ?? null
  const warped = result._warped_jpeg_b64

  const [editing, setEditing] = useState(false)
  const [box, setBox] = useState<Box | null>(cr0 ? { ...cr0 } : null)
  const [outer, setOuter] = useState<Box | null>(cb ? { x1: cb[0], y1: cb[1], x2: cb[2], y2: cb[3] } : null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [openPillar, setOpenPillar] = useState<string | null>(null)
  const [showProfile, setShowProfile] = useState(false)
  const [showZooms, setShowZooms] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const drag = useRef<{ which: 'inner' | 'outer'; side: Side } | null>(null)
  const pv = result.pillar_visuals
  const hasVisual = (p: string) => !!pv && !!pv[p as keyof typeof pv]
  const identity = profile?.identity

  // Live scores: server values until the user edits, then recompute from the dragged boxes.
  const cbLive = outer ? [outer.x1, outer.y1, outer.x2, outer.y2] : cb
  const liveRatios = box && cbLive && dirty ? ratiosFromBox(box, cbLive) : null
  const [lr0, tb0] = [parseRatio(result.centering.left_right), parseRatio(result.centering.top_bottom)]
  const lr = liveRatios ? [liveRatios.lr, 100 - liveRatios.lr] : lr0
  const tb = liveRatios ? [liveRatios.tb, 100 - liveRatios.tb] : tb0
  const cenScore = liveRatios ? centeringScore(liveRatios.lr, liveRatios.tb) : result.centering.score
  const pillars = { centering: cenScore, corners: result.corners.score, edges: result.edges.score, surface: result.surface.score }
  const overall = dirty ? overallScore(pillars) : result.overall_score
  const psa = dirty ? psaLabel(overall) : result.psa_equivalent
  const grade = Math.max(1, Math.min(10, Math.round(overall)))
  const psaShort = psa.split(' ').slice(0, 2).join(' ')

  const conf = result.centering.confidence
  const confP = confidencePhrase(conf, result.centering.reliable)
  const v = verdict(grade, conf, profile?.comps)
  const tone = BADGE_TONE(grade)
  const cenPhrase = liveRatios ? centeringPhrase(`${lr[0]}/${lr[1]}`, `${tb[0]}/${tb[1]}`) : centeringPhrase(result.centering.left_right, result.centering.top_bottom)
  const weakest = (Object.entries(pillars) as [string, number][]).sort((a, b) => a[1] - b[1])[0][0]
  const isWeak = (p: string, s: number) => p === weakest && s < 9

  // ── drag: pointer capture on the handle — the captured DOM node (keyed) survives the
  // re-renders the drag triggers, so moves keep flowing to the current-render handler ──
  function norm(e: React.PointerEvent) {
    const r = wrap.current!.getBoundingClientRect()
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }
  }
  function onHandleDown(which: 'inner' | 'outer', side: Side, e: React.PointerEvent) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { which, side }
  }
  function onHandleMove(which: 'inner' | 'outer', side: Side, e: React.PointerEvent) {
    if (drag.current?.which !== which || drag.current?.side !== side) return
    const { x, y } = norm(e)
    setDirty(true)
    const set = which === 'inner' ? setBox : setOuter
    set((b) => {
      if (!b) return b
      const n = { ...b }
      if (side === 'top') n.y1 = Math.min(y, b.y2 - 0.02)
      else if (side === 'bottom') n.y2 = Math.max(y, b.y1 + 0.02)
      else if (side === 'left') n.x1 = Math.min(x, b.x2 - 0.02)
      else if (side === 'right') n.x2 = Math.max(x, b.x1 + 0.02)
      return n
    })
  }
  function onHandleUp(which: 'inner' | 'outer', side: Side, e: React.PointerEvent) {
    if (drag.current?.which === which && drag.current?.side === side) {
      e.currentTarget.releasePointerCapture(e.pointerId)
      drag.current = null
    }
  }

  function regrade() {
    const qp = result._quad_padded as number[][] | undefined
    if (!outer || !qp || !onRegrade) return
    const W = img.current?.naturalWidth ?? 0
    const H = img.current?.naturalHeight ?? 0
    const corners = W && H ? warpBoxToSourceCorners(qp, W, H, outer) : null
    if (!corners) { setErr('Could not map the boundary back to the photo.'); return }
    setEditing(false)
    onRegrade(corners)
  }

  async function save() {
    if (!box || !cb) return
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/grade/corrections', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originalContentRegion: cr0, correctedContentRegion: box, cardBoundary: outer ?? cb,
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
  const mkHandles = (b: Box, which: 'inner' | 'outer') => [
    { which, side: 'top' as Side, x: ((b.x1 + b.x2) / 2) * 100, y: b.y1 * 100, cur: 'cursor-ns-resize' },
    { which, side: 'bottom' as Side, x: ((b.x1 + b.x2) / 2) * 100, y: b.y2 * 100, cur: 'cursor-ns-resize' },
    { which, side: 'left' as Side, x: b.x1 * 100, y: ((b.y1 + b.y2) / 2) * 100, cur: 'cursor-ew-resize' },
    { which, side: 'right' as Side, x: b.x2 * 100, y: ((b.y1 + b.y2) / 2) * 100, cur: 'cursor-ew-resize' },
  ]
  const handles = [...(outer ? mkHandles(outer, 'outer') : []), ...(box ? mkHandles(box, 'inner') : [])]

  const defectCount = (result.defect_boxes?.surface?.length ?? 0) + (result.defect_boxes?.edges?.length ?? 0) + (result.defect_boxes?.corners?.length ?? 0)

  return (
    <div className="rounded-xl border p-4">
      {/* identity — vision-ID hydrated from /scout; click to open the card profile */}
      <div className="mb-3 flex items-start justify-between gap-2 border-b pb-3">
        {identity?.name ? (
          <button
            type="button"
            onClick={() => profile && setShowProfile(true)}
            className="flex min-w-0 flex-1 items-start justify-between gap-2 rounded-md px-1 py-0.5 text-left hover:bg-muted/60"
            title="View card profile"
          >
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-medium">{identity.name}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {[identity.set, identity.number && `#${identity.number}`, identity.rarity].filter(Boolean).join(' · ') || 'tap for details'}
              </span>
            </span>
            <span className="shrink-0 self-center text-[11px] text-blue-600 dark:text-blue-400">profile ↗</span>
          </button>
        ) : (
          <div className="min-w-0 flex-1 px-1">
            <div className="text-[15px] font-medium">{profileLoading ? 'Identifying…' : <span className="text-muted-foreground">Card details</span>}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {profileLoading ? 'reading the card from your photo' : 'card not identified'}
            </div>
          </div>
        )}
        {identity?.confidence != null && (
          <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">ID {Math.round(identity.confidence * 100)}%</span>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
        {/* LEFT: card + adjust-borders (the inline centering correction) */}
        <div>
          <div ref={wrap} className={`relative overflow-hidden rounded-lg border ${editing ? 'touch-none select-none ring-2 ring-emerald-500/40' : ''}`}>
            {warped ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img ref={img} src={`data:image/jpeg;base64,${warped}`} alt="graded card" className="block w-full" draggable={false} />
            ) : (
              <div className="flex aspect-[5/7] w-full items-center justify-center text-xs text-muted-foreground">no preview</div>
            )}
            {showOverlay && editing && (
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full">
                <rect x={outer!.x1 * 100} y={outer!.y1 * 100} width={(outer!.x2 - outer!.x1) * 100} height={(outer!.y2 - outer!.y1) * 100} fill="none" stroke={EDGE} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                <rect x={box!.x1 * 100} y={box!.y1 * 100} width={(box!.x2 - box!.x1) * 100} height={(box!.y2 - box!.y1) * 100} fill="none" stroke={BORDER} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              </svg>
            )}
            {editing && handles.map((h) => (
              <span key={`${h.which}-${h.side}`}
                onPointerDown={(e) => onHandleDown(h.which, h.side, e)}
                onPointerMove={(e) => onHandleMove(h.which, h.side, e)}
                onPointerUp={(e) => onHandleUp(h.which, h.side, e)}
                className={`absolute size-3 -translate-x-1/2 -translate-y-1/2 touch-none border border-white shadow ${h.cur} ${h.which === 'outer' ? 'rounded-sm' : 'rounded-full'}`}
                style={{ left: `${h.x}%`, top: `${h.y}%`, background: h.which === 'outer' ? EDGE : BORDER }} />
            ))}
          </div>
          <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
            auto-straightened{defectCount > 0 && <> · <span className="text-blue-600 dark:text-blue-400">{defectCount} mark{defectCount === 1 ? '' : 's'} found</span></>}
          </p>
          {saved ? (
            <p className="mt-1 text-center text-[11px] text-emerald-600">✓ Saved — thanks, this trains the grader.</p>
          ) : editing ? (
            <div className="mt-1 space-y-1.5">
              <p className="text-center text-[10px] leading-snug text-muted-foreground">
                <span style={{ color: EDGE }}>■ card edge</span> · <span style={{ color: BORDER }}>● print border</span>
              </p>
              <div className="flex gap-2">
                <button onClick={save} disabled={saving || !dirty} className="flex-1 rounded-md bg-foreground px-2 py-1.5 text-xs font-medium text-background disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
                <button onClick={() => { setEditing(false); setBox(cr0 ? { ...cr0 } : null); setOuter(cb ? { x1: cb[0], y1: cb[1], x2: cb[2], y2: cb[3] } : null); setDirty(false) }} className="rounded-md border px-2 py-1.5 text-xs">Cancel</button>
              </div>
              {onRegrade && !!result._quad_padded && (
                <button onClick={regrade} disabled={!dirty} title="Re-run the grade using your corrected card edge as the boundary — use when the auto boundary grabbed a sleeve or case"
                  className="w-full rounded-md bg-emerald-600 px-2 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                  Re-grade with these borders
                </button>
              )}
            </div>
          ) : (
            showOverlay && (
              <button onClick={() => setEditing(true)} className="mt-1 w-full text-center text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                Borders off? ✏️ Adjust card edge &amp; print border
              </button>
            )
          )}
          {err && <p className="mt-1 text-[11px] text-red-600">{err}</p>}
        </div>

        {/* RIGHT: the reveal — badge, value, verdict, pillars */}
        <div className="min-w-0 space-y-3">
          <div className="flex items-center gap-3.5">
            <div className={`flex size-[76px] shrink-0 flex-col items-center justify-center rounded-full ${tone.bg}`}>
              <span className={`text-[30px] font-semibold leading-none tabular-nums ${tone.fg}`}>{grade}</span>
              <span className={`mt-0.5 text-[9px] font-medium tracking-wide ${tone.fg}`}>{badgeWord(grade)}</span>
            </div>
            <div className="min-w-0">
              <div className="text-lg font-semibold">{psaShort} likely</div>
              <div className="text-[13px] text-muted-foreground">{confP.label}{dirty && <span className="text-emerald-600"> · updated live</span>}</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">
                {v.gradedValue != null ? money(v.gradedValue) : profileLoading ? <span className="text-muted-foreground">$…</span> : <span className="text-muted-foreground">$—</span>}
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  {v.gradedValue != null ? `value at ${psaShort}` : profileLoading ? 'looking up value…' : 'value unavailable'}
                  {v.rawValue != null && ` · raw ~${money(v.rawValue)}`}
                </span>
              </div>
            </div>
          </div>

          <div className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 ${VERDICT_TONE[v.tone]}`}>
            <span aria-hidden className="text-base leading-none">{v.tone === 'success' ? '✓' : v.tone === 'warning' ? '≈' : '✕'}</span>
            <p className="text-[13px]"><span className="font-semibold">{v.title}</span> {v.detail}</p>
          </div>

          <div className="space-y-0.5">
            <PillarRow label="Centering" score={pillars.centering} note={cenPhrase} weak={isWeak('centering', pillars.centering)}
              tooltip={`L/R ${lr[0]}/${lr[1]} · T/B ${tb[0]}/${tb[1]} · score ${pillars.centering.toFixed(1)}`}
              onClick={hasVisual('centering') ? () => setOpenPillar('centering') : undefined} />
            <PillarRow label="Corners" score={pillars.corners} note={pillarNote('corners', result)} weak={isWeak('corners', pillars.corners)} tooltip={`score ${pillars.corners.toFixed(1)}`} />
            <PillarRow label="Edges" score={pillars.edges} note={pillarNote('edges', result)} weak={isWeak('edges', pillars.edges)} tooltip={`score ${pillars.edges.toFixed(1)}`} />
            <PillarRow label="Surface" score={pillars.surface} note={pillarNote('surface', result)} weak={isWeak('surface', pillars.surface)} tooltip={`score ${pillars.surface.toFixed(1)}`} />
          </div>

          <div className="flex items-center gap-2 border-t pt-2.5">
            {onGradeAnother && (
              <button onClick={onGradeAnother} className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted">Grade another</button>
            )}
            {result.pillar_zooms && (
              <button type="button" onClick={() => setShowZooms(true)} className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted">
                🔍 Inspect close-ups
              </button>
            )}
            <span className="ml-auto text-[11px] text-muted-foreground tabular-nums" title="exact centering ratios">
              {lr[0]}/{lr[1]} · {tb[0]}/{tb[1]}
            </span>
          </div>
        </div>
      </div>

      <PillarVisualDialog pillar={openPillar} visuals={result.pillar_visuals} centering={result.centering} onClose={() => setOpenPillar(null)} />
      <CardProfileModal profile={showProfile ? profile ?? null : null} onClose={() => setShowProfile(false)} />
      <DefectZoomGallery zooms={showZooms ? result.pillar_zooms ?? null : null} onClose={() => setShowZooms(false)} />
    </div>
  )
}
