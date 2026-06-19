'use client'

/**
 * CenteringCorrection — let a user FIX the inner print-border box when the grader got it
 * wrong, then capture it for retraining. Same warped image + overlay as CenteringPanel,
 * but the inner box gets four drag handles (one per side). Left/Right and Top/Bottom
 * update live as you drag; Save posts the corrected boundary to /api/grade/corrections,
 * which becomes a clean corner-GT label for the per-side centering selector.
 */
import { useRef, useState } from 'react'
import type { CenteringResult } from '@/lib/grading/types'

const BORDER = '#10b981' // emerald-500 — the print-border box being corrected
type Side = 'top' | 'bottom' | 'left' | 'right'
type Box = { x1: number; y1: number; x2: number; y2: number }

function ratios(cr: Box, cb: number[]) {
  const lw = cr.x1 - cb[0], rw = cb[2] - cr.x2
  const tw = cr.y1 - cb[1], bw = cb[3] - cr.y2
  const lr = lw + rw > 1e-6 ? Math.round((lw / (lw + rw)) * 100) : 50
  const tb = tw + bw > 1e-6 ? Math.round((tw / (tw + bw)) * 100) : 50
  return { lr, tb }
}

export function CenteringCorrection({
  centering,
  warpedJpegB64,
  cardBoundary,
  borderType,
  graderBackend,
}: {
  centering: CenteringResult
  warpedJpegB64?: string
  cardBoundary?: number[]
  borderType?: string
  graderBackend?: string
}) {
  const cb = cardBoundary && cardBoundary.length === 4 ? cardBoundary : null
  const cr0 = centering.content_region
  const [editing, setEditing] = useState(false)
  const [box, setBox] = useState<Box | null>(cr0 ? { ...cr0 } : null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const dragging = useRef<Side | null>(null)

  // Only offered when there is an overlay to correct (same condition CenteringPanel draws on).
  if (!warpedJpegB64 || !cb || !cr0) return null

  function normFromEvent(e: PointerEvent) {
    const r = wrap.current!.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }
  function onMove(e: PointerEvent) {
    if (!dragging.current) return
    const { x, y } = normFromEvent(e)
    setBox((b) => {
      if (!b) return b
      const n = { ...b }
      if (dragging.current === 'top') n.y1 = Math.min(y, b.y2 - 0.02)
      else if (dragging.current === 'bottom') n.y2 = Math.max(y, b.y1 + 0.02)
      else if (dragging.current === 'left') n.x1 = Math.min(x, b.x2 - 0.02)
      else if (dragging.current === 'right') n.x2 = Math.max(x, b.x1 + 0.02)
      return n
    })
  }
  function onUp() {
    dragging.current = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  function startDrag(side: Side, e: React.PointerEvent) {
    e.preventDefault()
    dragging.current = side
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  async function save() {
    if (!box || !cb) return
    setSaving(true); setErr(null)
    try {
      const r = ratios(box, cb)
      const res = await fetch('/api/grade/corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originalContentRegion: cr0,
          correctedContentRegion: box,
          cardBoundary: cb,
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
        onClick={() => { setBox({ ...cr0 }); setEditing(true) }}
        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Centering looks off? ✏️ Adjust the borders
      </button>
    )
  }

  const b = box!
  const r = ratios(b, cb)
  const midX = ((b.x1 + b.x2) / 2) * 100
  const midY = ((b.y1 + b.y2) / 2) * 100
  const handles: { side: Side; x: number; y: number; cur: string }[] = [
    { side: 'top', x: midX, y: b.y1 * 100, cur: 'cursor-ns-resize' },
    { side: 'bottom', x: midX, y: b.y2 * 100, cur: 'cursor-ns-resize' },
    { side: 'left', x: b.x1 * 100, y: midY, cur: 'cursor-ew-resize' },
    { side: 'right', x: b.x2 * 100, y: midY, cur: 'cursor-ew-resize' },
  ]

  return (
    <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
      <div className="mb-2 text-xs font-medium">Drag the green handles to the correct print-border edges.</div>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,236px)_1fr]">
        <div ref={wrap} className="relative touch-none select-none overflow-hidden rounded-md border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`data:image/jpeg;base64,${warpedJpegB64}`}
            alt="adjust centering borders"
            className="block w-full"
            draggable={false}
          />
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
            <rect
              x={b.x1 * 100}
              y={b.y1 * 100}
              width={(b.x2 - b.x1) * 100}
              height={(b.y2 - b.y1) * 100}
              fill="none"
              stroke={BORDER}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {handles.map((h) => (
            <span
              key={h.side}
              onPointerDown={(e) => startDrag(h.side, e)}
              className={`absolute size-4 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border-2 border-white bg-emerald-500 shadow ${h.cur}`}
              style={{ left: `${h.x}%`, top: `${h.y}%` }}
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
          <div className="flex gap-2 pt-1">
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
          {err && <p className="text-xs text-red-600">{err}</p>}
        </div>
      </div>
    </div>
  )
}
