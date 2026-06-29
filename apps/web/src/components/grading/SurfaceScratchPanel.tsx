'use client'

/**
 * SurfaceScratchPanel — draws the RF-DETR surface-scratch detections (defect_boxes.surface) over the
 * warped card, mirroring CenteringPanel's <img> + <svg viewBox="0 0 100 100"> overlay. Boxes are [x,y,w,h]
 * fractions of the warped card; each is labeled with its detector confidence. Only detections the grader
 * returned (>= the server SCRATCH_THRESHOLD, currently 0.6) are present — no client-side thresholding.
 */
import type { SurfaceDefect } from '@/lib/grading/types'

const SCRATCH_COLOR = '#ef4444' // red-500

export function SurfaceScratchPanel({
  warpedJpegB64,
  surface,
}: {
  warpedJpegB64?: string
  surface?: SurfaceDefect[] | null
}) {
  const boxes = (surface ?? []).filter((d) => Array.isArray(d.box) && d.box!.length === 4)
  const showCard = !!warpedJpegB64

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm font-medium">Surface — scratches</span>
        <span className="rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground">
          {boxes.length} detected
        </span>
      </div>

      <div className={showCard ? 'grid gap-5 sm:grid-cols-[minmax(0,236px)_1fr]' : ''}>
        {showCard && (
          <div>
            <div className="relative overflow-hidden rounded-md border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:image/jpeg;base64,${warpedJpegB64}`}
                alt="detected card with scratch overlay"
                className="block w-full"
              />
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="pointer-events-none absolute inset-0 h-full w-full"
              >
                {boxes.map((d, i) => {
                  const [x, y, w, h] = d.box as number[]
                  return (
                    <rect
                      key={i}
                      x={x * 100}
                      y={y * 100}
                      width={w * 100}
                      height={h * 100}
                      fill="none"
                      stroke={SCRATCH_COLOR}
                      strokeWidth={1.5}
                      vectorEffect="non-scaling-stroke"
                    />
                  )
                })}
              </svg>
              {boxes.map((d, i) => {
                const [x, y] = d.box as number[]
                return (
                  <span
                    key={i}
                    className="pointer-events-none absolute rounded bg-background/85 px-1 text-[10px] font-medium tabular-nums"
                    style={{ left: `${x * 100}%`, top: `${y * 100}%`, transform: 'translateY(-110%)', color: SCRATCH_COLOR }}
                  >
                    {d.conf != null ? d.conf.toFixed(2) : 'scratch'}
                  </span>
                )
              })}
            </div>
            <div className="mt-1.5 flex justify-center gap-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="size-2.5 rounded-[2px]" style={{ background: SCRATCH_COLOR }} />
                scratch (confidence shown)
              </span>
            </div>
          </div>
        )}

        <div className="space-y-2 text-sm">
          {boxes.length === 0 ? (
            <p className="text-muted-foreground">No surface scratches detected.</p>
          ) : (
            <ul className="space-y-1">
              {boxes
                .slice()
                .sort((a, b) => (b.conf ?? 0) - (a.conf ?? 0))
                .map((d, i) => (
                  <li key={i} className="flex items-center justify-between border-b py-1 last:border-0">
                    <span className="text-muted-foreground">Scratch {i + 1}</span>
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
