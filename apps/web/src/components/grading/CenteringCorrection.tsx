'use client'

/**
 * CenteringCorrection — let a user FIX both boundary boxes when the grader got them wrong:
 *   · GREEN  = the card's outer edge (die-cut)  — draggable per side
 *   · ORANGE = the inner print border            — draggable per side
 * (colors match the "Centering — what we measured" popup legend.)
 *
 * Two outcomes:
 *   · Save — posts the corrected pair to /api/grade/corrections (training label).
 *   · Re-grade with these borders — maps the corrected OUTER corners back into the ORIGINAL photo
 *     (through the warp's quad homography) and re-runs the FULL pipeline via the manual-contour path:
 *     SAM3 is skipped, the warp is rebuilt from the user's boundary, and registration + retrieval get
 *     a clean crop. This is the human bootstrap for cards the auto pipeline can't anchor (hazy sleeves).
 */
import { useRef, useState } from 'react'
import type { CenteringResult } from '@/lib/grading/types'

const OUTER = '#22c55e' // green-500 — card edge (matches popup)
const INNER = '#f59e0b' // amber-500 — inner print border (matches popup)
type Side = 'top' | 'bottom' | 'left' | 'right'
type Which = 'inner' | 'outer'
type Box = { x1: number; y1: number; x2: number; y2: number }

function ratios(cr: Box, cb: Box) {
  const lw = cr.x1 - cb.x1, rw = cb.x2 - cr.x2
  const tw = cr.y1 - cb.y1, bw = cb.y2 - cr.y2
  const lr = lw + rw > 1e-6 ? Math.round((lw / (lw + rw)) * 100) : 50
  const tb = tw + bw > 1e-6 ? Math.round((tw / (tw + bw)) * 100) : 50
  return { lr, tb }
}

/** Homography from 4 point correspondences (src → dst), via an 8×8 DLT solve. */
function homography(src: number[][], dst: number[][]): number[] | null {
  // rows: for each pair, two equations in h = [h11..h32] (h33 = 1)
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]
    const [u, v] = dst[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u)
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v)
  }
  // Gaussian elimination with partial pivoting
  const n = 8
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    if (Math.abs(M[piv][col]) < 1e-12) return null
    ;[M[col], M[piv]] = [M[piv], M[col]]
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r][col] / M[col][col]
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]
    }
  }
  return M.map((row, i) => row[n] / M[i][i])
}

function applyH(h: number[], x: number, y: number): [number, number] {
  const w = h[6] * x + h[7] * y + 1
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]
}

export function CenteringCorrection({
  centering,
  warpedJpegB64,
  cardBoundary,
  borderType,
  graderBackend,
  quadPadded,
  onRegrade,
}: {
  centering: CenteringResult
  warpedJpegB64?: string
  cardBoundary?: number[]
  borderType?: string
  graderBackend?: string
  /** result._quad_padded — the source-photo quad the warp was built from (enables re-grade). */
  quadPadded?: number[][]
  /** re-run the grade with user-corrected outer corners (source px), via the manual-contour path. */
  onRegrade?: (corners: number[][]) => void
}) {
  const cb0 = cardBoundary && cardBoundary.length === 4 ? cardBoundary : null
  const cr0 = centering.content_region
  const [editing, setEditing] = useState(false)
  const [inner, setInner] = useState<Box | null>(cr0 ? { ...cr0 } : null)
  const [outer, setOuter] = useState<Box | null>(
    cb0 ? { x1: cb0[0], y1: cb0[1], x2: cb0[2], y2: cb0[3] } : null
  )
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const dragging = useRef<{ which: Which; side: Side } | null>(null)

  if (!warpedJpegB64 || !cb0 || !cr0) return null

  function normFromEvent(e: PointerEvent) {
    const r = wrap.current!.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }
  function onMove(e: PointerEvent) {
    const d = dragging.current
    if (!d) return
    const { x, y } = normFromEvent(e)
    const set = d.which === 'inner' ? setInner : setOuter
    set((b) => {
      if (!b) return b
      const n = { ...b }
      if (d.side === 'top') n.y1 = Math.min(y, b.y2 - 0.02)
      else if (d.side === 'bottom') n.y2 = Math.max(y, b.y1 + 0.02)
      else if (d.side === 'left') n.x1 = Math.min(x, b.x2 - 0.02)
      else if (d.side === 'right') n.x2 = Math.max(x, b.x1 + 0.02)
      return n
    })
  }
  function onUp() {
    dragging.current = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  function startDrag(which: Which, side: Side, e: React.PointerEvent) {
    e.preventDefault()
    dragging.current = { which, side }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  async function save() {
    if (!inner || !outer) return
    setSaving(true); setErr(null)
    try {
      const r = ratios(inner, outer)
      const res = await fetch('/api/grade/corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originalContentRegion: cr0,
          correctedContentRegion: inner,
          // the label pair is the CORRECTED geometry (outer edits included); provenance keeps originals
          cardBoundary: outer,
          originalLeftRight: centering.left_right,
          originalTopBottom: centering.top_bottom,
          leftRight: `${r.lr}/${100 - r.lr}`,
          topBottom: `${r.tb}/${100 - r.tb}`,
          borderType,
          graderBackend,
          warpedJpegB64,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Could not save correction.')
      setSaved(true); setEditing(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save correction.')
    } finally {
      setSaving(false)
    }
  }

  function regrade() {
    if (!outer || !quadPadded || quadPadded.length !== 4 || !onRegrade) return
    const el = img.current
    const W = el?.naturalWidth ?? 0
    const H = el?.naturalHeight ?? 0
    if (!W || !H) { setErr('Image not ready — try again.'); return }
    // The warp was built as quadPadded (source px) → the full warp rect. A homography from the warp
    // rect's corners to quadPadded maps ANY warp point back into the original photo — including the
    // user's corrected outer corners, which become the manual contour for the re-grade.
    const h = homography(
      [[0, 0], [W, 0], [W, H], [0, H]],
      quadPadded
    )
    if (!h) { setErr('Could not map the boundary back to the photo.'); return }
    const corners = [
      applyH(h, outer.x1 * W, outer.y1 * H),
      applyH(h, outer.x2 * W, outer.y1 * H),
      applyH(h, outer.x2 * W, outer.y2 * H),
      applyH(h, outer.x1 * W, outer.y2 * H),
    ].map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10])
    onRegrade(corners)
  }

  if (saved) {
    return (
      <p className="text-xs text-emerald-600">
        ✓ Thanks — your corrected borders were saved and will help train the grader.
      </p>
    )
  }

  if (!editing) {
    return (
      <button
        onClick={() => {
          setInner({ ...cr0 })
          setOuter({ x1: cb0[0], y1: cb0[1], x2: cb0[2], y2: cb0[3] })
          setEditing(true)
        }}
        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Borders look off? ✏️ Adjust them
      </button>
    )
  }

  const bi = inner!
  const bo = outer!
  const r = ratios(bi, bo)
  const mk = (b: Box, which: Which): { which: Which; side: Side; x: number; y: number; cur: string }[] => {
    const midX = ((b.x1 + b.x2) / 2) * 100
    const midY = ((b.y1 + b.y2) / 2) * 100
    return [
      { which, side: 'top', x: midX, y: b.y1 * 100, cur: 'cursor-ns-resize' },
      { which, side: 'bottom', x: midX, y: b.y2 * 100, cur: 'cursor-ns-resize' },
      { which, side: 'left', x: b.x1 * 100, y: midY, cur: 'cursor-ew-resize' },
      { which, side: 'right', x: b.x2 * 100, y: midY, cur: 'cursor-ew-resize' },
    ]
  }
  const handles = [...mk(bo, 'outer'), ...mk(bi, 'inner')]

  return (
    <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
      <div className="mb-2 text-xs font-medium">
        Drag the handles: <span style={{ color: OUTER }}>green</span> = card edge ·{' '}
        <span style={{ color: INNER }}>orange</span> = inner print border.
      </div>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,280px)_1fr]">
        <div ref={wrap} className="relative touch-none select-none overflow-hidden rounded-md border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={img}
            src={`data:image/jpeg;base64,${warpedJpegB64}`}
            alt="adjust centering borders"
            className="block w-full"
            draggable={false}
          />
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
            <rect x={bo.x1 * 100} y={bo.y1 * 100} width={(bo.x2 - bo.x1) * 100} height={(bo.y2 - bo.y1) * 100}
                  fill="none" stroke={OUTER} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            <rect x={bi.x1 * 100} y={bi.y1 * 100} width={(bi.x2 - bi.x1) * 100} height={(bi.y2 - bi.y1) * 100}
                  fill="none" stroke={INNER} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </svg>
          {handles.map((h) => (
            <span
              key={`${h.which}-${h.side}`}
              onPointerDown={(e) => startDrag(h.which, h.side, e)}
              className={`absolute size-4 -translate-x-1/2 -translate-y-1/2 touch-none border-2 border-white shadow ${h.cur} ${h.which === 'outer' ? 'rounded-sm' : 'rounded-full'}`}
              style={{ left: `${h.x}%`, top: `${h.y}%`, background: h.which === 'outer' ? OUTER : INNER }}
            />
          ))}
        </div>

        <div className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Left / Right</span>
            <span className="font-medium tabular-nums">{r.lr} / {100 - r.lr}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Top / Bottom</span>
            <span className="font-medium tabular-nums">{r.tb} / {100 - r.tb}</span>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            {onRegrade && quadPadded && (
              <button
                onClick={regrade}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white"
                title="Re-run the full grade using your corrected card edge as the boundary"
              >
                Re-grade with these borders
              </button>
            )}
            <button
              onClick={save}
              disabled={saving}
              className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save correction'}
            </button>
            <button onClick={() => setEditing(false)} className="rounded-md border px-3 py-1.5 text-xs">
              Cancel
            </button>
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Re-grade rebuilds the measurement from your green card edge — use it when the auto boundary
            grabbed a sleeve or case. Save just records the correction to improve the grader.
          </p>
          {err && <p className="text-xs text-red-600">{err}</p>}
        </div>
      </div>
    </div>
  )
}
