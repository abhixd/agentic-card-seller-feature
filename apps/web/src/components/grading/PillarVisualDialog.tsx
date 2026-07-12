'use client'

/**
 * PillarVisualDialog — click-to-inspect popup for a grading pillar. Shows the overlay image the
 * grader returns in `pillar_visuals[pillar]` (contract v1.1.0) so the user can visually check WHY a
 * pillar scored the way it did: centering frame, edge-defect strips, surface scratches, or corner crops.
 * Self-contained (no UI-lib dependency) — a fixed overlay + panel, closes on backdrop click or Escape.
 */
import { useEffect } from 'react'
import type { CenteringResult, PillarVisuals } from '@/lib/grading/types'

const TITLE: Record<string, string> = { centering: 'Centering', corners: 'Corners', edges: 'Edges', surface: 'Surface' }
const HINT: Record<string, string> = {
  centering: 'green = card edge · orange = inner print border',
  corners: 'the four corner crops',
  edges: 'per-side strips · 🟦 whitening  🟥 nick  🟧 chip  🟨 fraying',
  surface: 'detected scratch segments',
}

function DetailRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-3">
      <span className="w-28 shrink-0 text-muted-foreground">{k}</span>
      <span className="min-w-0">{v}</span>
    </div>
  )
}

/** Structurally tolerant view of the centering result — accepts both the grade page's CenteringResult and
 *  the scout page's local Pillar shape (whose numeric fields allow null). */
type CenteringDetails = {
  left_right?: string | null
  top_bottom?: string | null
  confidence?: number | null
  _source?: string | null
  stability?: CenteringResult['stability']
  registration?: CenteringResult['registration']
}

/** Collapsible deep-dive: how the centering read was made (method, anchor quality, stability probe).
 *  Collapsed by default so the main flow (the overlay image) stays uncluttered. */
function ScanDetails({ cen }: { cen: CenteringDetails }) {
  const reg = cen.registration
  const st = cen.stability
  const anchored = cen._source === 'print_reg' && reg?.accepted
  const method = anchored
    ? `⚓ Print-anchored — registered against the official card render${reg?.ref_id ? ` (${reg.ref_id})` : ''}`
    : `Edge detection (per-side detector)${reg && !reg.accepted && reg.reason ? ` — print-anchor unavailable: ${reg.reason}` : ''}`
  return (
    <details className="mt-3 rounded-md border">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/50">
        Scan details
      </summary>
      <div className="space-y-1.5 border-t px-3 py-2.5 text-xs">
        <DetailRow k="Read method" v={method} />
        {anchored && (
          <DetailRow k="Anchor quality"
            v={`${reg?.inliers ?? '—'} anchor points · ${reg?.resid_px ?? '—'}px residual · scale ${reg?.scale ?? '—'}`} />
        )}
        {anchored && reg?.outer_corrected && (
          <DetailRow k="Cut edge visibility"
            v={reg?.cut_edge_support
              ? `${Object.entries(reg.cut_edge_support).map(([s, v]) => `${s} ${Math.round((v as number) * 100)}%`).join(' · ')} — the die-cut was located from the print anchors; low sides are not visible against the case/sleeve`
              : 'boundary extrapolated from print anchors (cased/sleeved card)'} />
        )}
        {st && (st.delta_pts != null ? (
          <DetailRow k="Stability probe"
            v={`Δ ${st.delta_pts} pts — a re-encoded copy read ${st.probe_left_right ?? '—'} · ${st.probe_top_bottom ?? '—'}${st.note ? ` (${st.note})` : ''}`} />
        ) : (
          <DetailRow k="Stability probe" v={st.error ?? st.note ?? 'not available'} />
        ))}
        {cen.confidence != null && (
          <DetailRow k="Confidence" v={`${Math.round(cen.confidence * 100)}% — the weakest of the signals above gates the badge`} />
        )}
        {(cen.left_right || cen.top_bottom) && (
          <DetailRow k="Read" v={`${cen.left_right ?? '—'} L/R · ${cen.top_bottom ?? '—'} T/B`} />
        )}
      </div>
    </details>
  )
}

export function PillarVisualDialog({
  pillar,
  visuals,
  centering,
  onClose,
}: {
  pillar: string | null
  visuals?: PillarVisuals | null
  /** optional: the centering result — when given, the centering popup gains a "Scan details" section */
  centering?: CenteringDetails | null
  onClose: () => void
}) {
  useEffect(() => {
    if (!pillar) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pillar, onClose])

  if (!pillar) return null
  const v = visuals?.[pillar as keyof PillarVisuals] ?? null
  const corners = pillar === 'corners' && v && typeof v === 'object' ? (v as Partial<Record<'TL' | 'TR' | 'BR' | 'BL', string>>) : null
  const img = typeof v === 'string' ? v : null

  return (
    <div onClick={(e) => { e.stopPropagation(); onClose() }} className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true"
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-lg border bg-background p-4 shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">{TITLE[pillar] ?? pillar} — what we measured</h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{HINT[pillar] ?? ''}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-md border px-2 py-1 text-xs hover:bg-muted">Close</button>
        </div>
        {corners ? (
          <div className="grid grid-cols-2 gap-2">
            {(['TL', 'TR', 'BR', 'BL'] as const).map((k) =>
              corners[k] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={k} src={`data:image/jpeg;base64,${corners[k]}`} alt={`corner ${k}`} className="w-full rounded border" />
              ) : null,
            )}
          </div>
        ) : img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`data:image/jpeg;base64,${img}`} alt={`${pillar} overlay`} className="w-full rounded border" />
        ) : (
          <p className="py-8 text-center text-xs text-muted-foreground">No visual available for this read.</p>
        )}
        {pillar === 'centering' && centering && <ScanDetails cen={centering} />}
      </div>
    </div>
  )
}
