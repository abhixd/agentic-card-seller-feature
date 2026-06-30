'use client'

/**
 * DefectsPanel — unified defect view. Draws ALL rf-detr detections over the warped card
 * (edge = cyan, corner = orange, surface = red) and lists every defect in one table. Hover or click
 * a row to highlight its box on the card (the others dim) and reveal its confidence. Replaces the
 * separate SurfaceScratchPanel + EdgeCornerDefectPanel.
 */
import { useState } from 'react'
import type { DefectBoxes, SurfaceDefect } from '@/lib/grading/types'
import { inflateBox } from '@/lib/grading/defects'

const PILLAR = {
  edge: { color: '#06b6d4', label: 'Edge' },
  corner: { color: '#f97316', label: 'Corner' },
  surface: { color: '#ef4444', label: 'Surface' },
} as const
type Pillar = keyof typeof PILLAR

export function DefectsPanel({
  warpedJpegB64,
  defects,
}: {
  warpedJpegB64?: string
  defects?: DefectBoxes | null
}) {
  const [pinned, setPinned] = useState<number | null>(null)
  const [hovered, setHovered] = useState<number | null>(null)
  const active = hovered ?? pinned

  const valid = (d: SurfaceDefect) => Array.isArray(d.box) && d.box!.length === 4
  const items: { d: SurfaceDefect; pillar: Pillar }[] = [
    ...(defects?.edges ?? []).filter(valid).map((d) => ({ d, pillar: 'edge' as Pillar })),
    ...(defects?.corners ?? []).filter(valid).map((d) => ({ d, pillar: 'corner' as Pillar })),
    ...(defects?.surface ?? []).filter(valid).map((d) => ({ d, pillar: 'surface' as Pillar })),
  ].sort((a, b) => (b.d.conf ?? 0) - (a.d.conf ?? 0))
  const showCard = !!warpedJpegB64

  const activeItem = active !== null ? items[active] : undefined
  const activeBox = activeItem ? inflateBox(activeItem.d.box as number[]) : null

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm font-medium">Defects</span>
        <span className="rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground">
          {items.length} detected
        </span>
      </div>

      <div className={showCard ? 'grid gap-5 sm:grid-cols-[minmax(0,236px)_1fr]' : ''}>
        {showCard && (
          <div>
            <div className="relative overflow-hidden rounded-md border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:image/jpeg;base64,${warpedJpegB64}`}
                alt="graded card with defect overlay"
                className="block w-full"
              />
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="pointer-events-none absolute inset-0 h-full w-full"
              >
                {items.map((it, i) => {
                  const [x, y, w, h] = inflateBox(it.d.box as number[])
                  const on = active === i
                  const dim = active !== null && !on
                  const color = PILLAR[it.pillar].color
                  return (
                    <rect
                      key={i}
                      x={x * 100}
                      y={y * 100}
                      width={w * 100}
                      height={h * 100}
                      fill={on ? `${color}22` : 'none'}
                      stroke={color}
                      strokeWidth={on ? 1 : 0.4}
                      strokeOpacity={dim ? 0.25 : 1}
                      vectorEffect="non-scaling-stroke"
                    />
                  )
                })}
              </svg>
              {activeBox && activeItem && (
                <span
                  className="pointer-events-none absolute rounded bg-background/85 px-1 text-[10px] font-medium tabular-nums"
                  style={{
                    left: `${activeBox[0] * 100}%`,
                    top: `${activeBox[1] * 100}%`,
                    transform: 'translateY(-110%)',
                    color: PILLAR[activeItem.pillar].color,
                  }}
                >
                  {activeItem.d.conf != null ? activeItem.d.conf.toFixed(2) : ''}
                </span>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap justify-center gap-3 text-[11px] text-muted-foreground">
              {(['edge', 'corner', 'surface'] as Pillar[]).map((p) => (
                <span key={p} className="flex items-center gap-1">
                  <span className="size-2.5 rounded-[2px]" style={{ background: PILLAR[p].color }} />
                  {PILLAR[p].label.toLowerCase()}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="min-w-0 text-sm">
          {items.length === 0 ? (
            <p className="text-muted-foreground">No defects detected.</p>
          ) : (
            <>
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
                    <th className="pb-1 text-left font-medium">Defect</th>
                    <th className="pb-1 text-left font-medium">Type</th>
                    <th className="pb-1 text-right font-medium">Conf</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, i) => (
                    <tr
                      key={i}
                      onClick={() => setPinned((p) => (p === i ? null : i))}
                      onMouseEnter={() => setHovered(i)}
                      onMouseLeave={() => setHovered(null)}
                      className={`cursor-pointer border-b last:border-0 ${active === i ? 'bg-muted/60' : 'hover:bg-muted/30'}`}
                    >
                      <td className="py-1.5">
                        <span className="flex items-center gap-1.5">
                          <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: PILLAR[it.pillar].color }} />
                          {PILLAR[it.pillar].label}
                        </span>
                      </td>
                      <td className="py-1.5 text-muted-foreground">{it.d.type ?? '—'}</td>
                      <td className="py-1.5 text-right font-medium tabular-nums">
                        {it.d.conf != null ? `${(it.d.conf * 100).toFixed(0)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-muted-foreground/70">tap a row to highlight it on the card</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
