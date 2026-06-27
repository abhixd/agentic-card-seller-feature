'use client'

/**
 * PillarVisualDialog — click-to-inspect popup for a grading pillar. Shows the overlay image the
 * grader returns in `pillar_visuals[pillar]` (contract v1.1.0) so the user can visually check WHY a
 * pillar scored the way it did: centering frame, edge-defect strips, surface scratches, or corner crops.
 * Self-contained (no UI-lib dependency) — a fixed overlay + panel, closes on backdrop click or Escape.
 */
import { useEffect } from 'react'
import type { PillarVisuals } from '@/lib/grading/types'

const TITLE: Record<string, string> = { centering: 'Centering', corners: 'Corners', edges: 'Edges', surface: 'Surface' }
const HINT: Record<string, string> = {
  centering: 'green = card edge · orange = inner print border',
  corners: 'the four corner crops',
  edges: 'per-side strips · 🟦 whitening  🟥 nick  🟧 chip  🟨 fraying',
  surface: 'detected scratch segments',
}

export function PillarVisualDialog({
  pillar,
  visuals,
  onClose,
}: {
  pillar: string | null
  visuals?: PillarVisuals | null
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
      </div>
    </div>
  )
}
