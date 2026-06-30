'use client'

/**
 * EdgeCornerDefectPanel — draws the RF-DETR edge (cyan) + corner (orange) detections
 * (defect_boxes.edges / .corners) over the warped card, mirroring SurfaceScratchPanel. Boxes are
 * [x,y,w,h] fractions of the warped card; each is labeled with its detector confidence. This is the
 * primary edge/corner defect view (the rf-detr-large detector), replacing the CV pillar_visuals popup.
 * Only detections the grader returned (>= the server EC_THRESHOLD, currently 0.6) are present.
 */
import type { SurfaceDefect } from '@/lib/grading/types'
import { inflateBox } from '@/lib/grading/defects'

const EDGE_COLOR = '#06b6d4'   // cyan-500
const CORNER_COLOR = '#f97316' // orange-500

export function EdgeCornerDefectPanel({
  warpedJpegB64,
  edges,
  corners,
}: {
  warpedJpegB64?: string
  edges?: SurfaceDefect[] | null
  corners?: SurfaceDefect[] | null
}) {
  const valid = (d: SurfaceDefect) => Array.isArray(d.box) && d.box!.length === 4
  const e = (edges ?? []).filter(valid)
  const c = (corners ?? []).filter(valid)
  const items: { d: SurfaceDefect; color: string; kind: 'edge' | 'corner' }[] = [
    ...e.map((d) => ({ d, color: EDGE_COLOR, kind: 'edge' as const })),
    ...c.map((d) => ({ d, color: CORNER_COLOR, kind: 'corner' as const })),
  ]
  const showCard = !!warpedJpegB64

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm font-medium">Edges &amp; Corners — defects</span>
        <span className="rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground">
          {e.length} edge · {c.length} corner
        </span>
      </div>

      <div className={showCard ? 'grid gap-5 sm:grid-cols-[minmax(0,236px)_1fr]' : ''}>
        {showCard && (
          <div>
            <div className="relative overflow-hidden rounded-md border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:image/jpeg;base64,${warpedJpegB64}`}
                alt="detected card with edge/corner overlay"
                className="block w-full"
              />
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="pointer-events-none absolute inset-0 h-full w-full"
              >
                {items.map(({ d, color }, i) => {
                  const [x, y, w, h] = inflateBox(d.box as number[])
                  return (
                    <rect
                      key={i}
                      x={x * 100}
                      y={y * 100}
                      width={w * 100}
                      height={h * 100}
                      fill="none"
                      stroke={color}
                      strokeWidth={0.4}
                      vectorEffect="non-scaling-stroke"
                    />
                  )
                })}
              </svg>
              {items.map(({ d, color }, i) => {
                const [x, y] = inflateBox(d.box as number[])
                return (
                  <span
                    key={i}
                    className="pointer-events-none absolute rounded bg-background/85 px-1 text-[10px] font-medium tabular-nums"
                    style={{ left: `${x * 100}%`, top: `${y * 100}%`, transform: 'translateY(-110%)', color }}
                  >
                    {d.conf != null ? d.conf.toFixed(2) : ''}
                  </span>
                )
              })}
            </div>
            <div className="mt-1.5 flex justify-center gap-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="size-2.5 rounded-[2px]" style={{ background: EDGE_COLOR }} />
                edge
              </span>
              <span className="flex items-center gap-1">
                <span className="size-2.5 rounded-[2px]" style={{ background: CORNER_COLOR }} />
                corner
              </span>
            </div>
          </div>
        )}

        <div className="space-y-2 text-sm">
          {items.length === 0 ? (
            <p className="text-muted-foreground">No edge or corner defects detected.</p>
          ) : (
            <ul className="space-y-1">
              {items
                .slice()
                .sort((a, b) => (b.d.conf ?? 0) - (a.d.conf ?? 0))
                .map(({ d, color, kind }, i) => (
                  <li key={i} className="flex items-center justify-between border-b py-1 last:border-0">
                    <span className="flex items-center gap-1.5 capitalize text-muted-foreground">
                      <span className="size-2 rounded-[2px]" style={{ background: color }} />
                      {kind}
                    </span>
                    <span className="font-medium tabular-nums">
                      {d.conf != null ? `${(d.conf * 100).toFixed(0)}%` : '—'}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
