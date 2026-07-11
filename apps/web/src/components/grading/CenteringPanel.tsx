'use client'

/**
 * CenteringPanel — the "show your work" centering display for the grade page.
 *
 * Trust comes from letting the user verify the number, not just read it: we draw the
 * two boundaries the grader actually detected (card edge + printed border) on the
 * warped card the user uploaded, then translate the same measurement into PSA's
 * published centering tolerances. Every number on screen derives from one source
 * (centering.left_right / top_bottom + content_region + _card_boundary), so the
 * score, the ratio, the bars, and the picture can never disagree.
 */
import type { CenteringResult } from '@/lib/grading/types'

const EDGE_COLOR = '#3b82f6'   // blue-500  — detected card edge (outer)
const BORDER_COLOR = '#10b981' // emerald-500 — detected print border (inner)

// Tailwind classes must be literal for the JIT — keep a static lookup per tone.
const TONE = {
  emerald: { text: 'text-emerald-600', fill: 'bg-emerald-500', soft: 'bg-emerald-500/15', ring: 'border-emerald-500/40' },
  lime: { text: 'text-lime-600', fill: 'bg-lime-500', soft: 'bg-lime-500/15', ring: 'border-lime-500/40' },
  amber: { text: 'text-amber-600', fill: 'bg-amber-500', soft: 'bg-amber-500/15', ring: 'border-amber-500/40' },
  orange: { text: 'text-orange-600', fill: 'bg-orange-500', soft: 'bg-orange-500/15', ring: 'border-orange-500/40' },
  red: { text: 'text-red-600', fill: 'bg-red-500', soft: 'bg-red-500/15', ring: 'border-red-500/40' },
} as const
type ToneKey = keyof typeof TONE

function parseRatio(s?: string): [number, number] | null {
  if (!s) return null
  const p = s.split('/').map((n) => parseInt(n, 10))
  return p.length === 2 && !p.some(Number.isNaN) ? [p[0], p[1]] : null
}

// PSA front-centering tolerance from worst-axis deviation off a perfect 50.
// 55/45 → PSA 10, 60/40 → PSA 9, 65/35 → PSA 8, 70/30 → PSA 7.
function psaBand(dev: number): { label: string; tone: ToneKey } {
  if (dev <= 5) return { label: 'PSA 10', tone: 'emerald' }
  if (dev <= 10) return { label: 'PSA 9', tone: 'lime' }
  if (dev <= 15) return { label: 'PSA 8', tone: 'amber' }
  if (dev <= 20) return { label: 'PSA 7', tone: 'orange' }
  return { label: 'PSA 6 or below', tone: 'red' }
}

function BalanceBar({ label, a, b }: { label: string; a: number; b: number }) {
  const dev = Math.abs(a - 50)
  const tone = TONE[psaBand(dev).tone]
  const segLeft = Math.min(a, 50)
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="font-medium tabular-nums text-foreground">{a} / {b}</span>
      </div>
      <div className="relative h-2 rounded-full bg-muted">
        <div className="absolute -bottom-1 -top-1 left-1/2 w-px bg-foreground/30" />
        <div className={`absolute inset-y-0 rounded-full ${tone.fill}`} style={{ left: `${segLeft}%`, width: `${dev}%` }} />
        <div className={`absolute -top-1 h-4 w-0.5 ${tone.fill}`} style={{ left: `${a}%`, transform: 'translateX(-50%)' }} />
      </div>
    </div>
  )
}

export function CenteringPanel({
  centering,
  warpedJpegB64,
  cardBoundary,
  borderType,
}: {
  centering: CenteringResult
  warpedJpegB64?: string
  cardBoundary?: number[]
  borderType?: string
}) {
  const lr = parseRatio(centering.left_right)
  const tb = parseRatio(centering.top_bottom)
  const lrDev = lr ? Math.abs(lr[0] - 50) : 0
  const tbDev = tb ? Math.abs(tb[0] - 50) : 0
  const worstDev = Math.max(lrDev, tbDev)
  const band = psaBand(worstDev)
  const bandTone = TONE[band.tone]

  const cb = cardBoundary && cardBoundary.length === 4 ? cardBoundary : null
  const cr = centering.content_region
  const hasOverlay = !!(cb && cr)
  const showCard = !!warpedJpegB64

  const scoreTone =
    centering.score >= 9 ? 'text-emerald-600'
    : centering.score >= 7.5 ? 'text-lime-600'
    : centering.score >= 6 ? 'text-amber-600'
    : 'text-red-600'

  const ladderPos = (Math.min(worstDev, 15) / 15) * 100

  // Side labels: the VALUE is the reported ratio share (so it matches the headline);
  // the POSITION is the geometric center of that margin band (so it points at the gap).
  const labels =
    hasOverlay && lr && tb
      ? [
          { key: 'left', v: lr[0], x: ((cb![0] + cr!.x1) / 2) * 100, y: 50 },
          { key: 'right', v: lr[1], x: ((cr!.x2 + cb![2]) / 2) * 100, y: 50 },
          { key: 'top', v: tb[0], x: 50, y: ((cb![1] + cr!.y1) / 2) * 100 },
          { key: 'bottom', v: tb[1], x: 50, y: ((cr!.y2 + cb![3]) / 2) * 100 },
        ]
      : null

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">Centering</span>
          <span className={`text-2xl font-semibold ${scoreTone}`}>{centering.score.toFixed(1)}</span>
          <span className="text-xs text-muted-foreground">/ 10</span>
        </div>
        <span className={`rounded-md border px-2.5 py-1 text-xs font-medium ${bandTone.soft} ${bandTone.ring} ${bandTone.text}`}>
          Supports {band.label}
        </span>
      </div>

      <div className={showCard ? 'grid gap-5 sm:grid-cols-[minmax(0,236px)_1fr]' : ''}>
        {showCard && (
          <div>
            <div className="relative overflow-hidden rounded-md border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:image/jpeg;base64,${warpedJpegB64}`}
                alt="detected card with centering overlay"
                className="block w-full"
              />
              {hasOverlay && (
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
                  <rect
                    x={cb![0] * 100}
                    y={cb![1] * 100}
                    width={(cb![2] - cb![0]) * 100}
                    height={(cb![3] - cb![1]) * 100}
                    fill="none"
                    stroke={EDGE_COLOR}
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                  <rect
                    x={cr!.x1 * 100}
                    y={cr!.y1 * 100}
                    width={(cr!.x2 - cr!.x1) * 100}
                    height={(cr!.y2 - cr!.y1) * 100}
                    fill="none"
                    stroke={BORDER_COLOR}
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              )}
              {labels?.map((p) => (
                <span
                  key={p.key}
                  className="pointer-events-none absolute rounded bg-background/80 px-1 text-[10px] font-medium tabular-nums text-foreground"
                  style={{ left: `${p.x}%`, top: `${p.y}%`, transform: 'translate(-50%,-50%)' }}
                >
                  {p.v}
                </span>
              ))}
            </div>
            <div className="mt-1.5 flex justify-center gap-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="size-2.5 rounded-[2px]" style={{ background: EDGE_COLOR }} />
                card edge
              </span>
              <span className="flex items-center gap-1">
                <span className="size-2.5 rounded-[2px]" style={{ background: BORDER_COLOR }} />
                print border
              </span>
            </div>
          </div>
        )}

        <div className="space-y-4">
          {lr && <BalanceBar label="Left–right" a={lr[0]} b={lr[1]} />}
          {tb && <BalanceBar label="Top–bottom" a={tb[0]} b={tb[1]} />}

          <div>
            <div className="mb-1 text-[11px] text-muted-foreground">Where it lands on the PSA centering scale</div>
            <div className="relative">
              <div className="flex h-2.5 overflow-hidden rounded-full">
                <div className="bg-emerald-500" style={{ width: '33.3%' }} />
                <div className="bg-amber-500" style={{ width: '33.4%' }} />
                <div className="bg-red-500" style={{ width: '33.3%' }} />
              </div>
              <div
                className="absolute -top-1.5 size-0 border-x-4 border-x-transparent border-t-[6px] border-t-foreground"
                style={{ left: `${ladderPos}%`, transform: 'translateX(-50%)' }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>perfect</span>
              <span>55/45 · P10</span>
              <span>60/40 · P9</span>
              <span>65/35 · P8</span>
            </div>
          </div>

          {(() => {
            // Numeric read confidence (0..1 from the grader; MIN-combined with the stability probe when
            // the grade ran with stability). Falls back to the legacy binary `reliable` flag when absent.
            const conf = centering.confidence
            const level =
              conf != null
                ? conf < 0.6 ? 'low' : conf < 0.85 ? 'mid' : 'high'
                : centering.reliable === false ? 'low' : 'high'
            const ui = {
              high: { cls: 'text-emerald-600', dot: 'bg-emerald-500', label: 'High-confidence read' },
              mid: { cls: 'text-amber-600', dot: 'bg-amber-500', label: 'Medium-confidence read — worth a glance' },
              low: { cls: 'text-red-600', dot: 'bg-red-500', label: 'Low-confidence read — verify the borders' },
            }[level]
            return (
              <div className={`flex items-center gap-1.5 text-xs ${ui.cls}`}>
                <span className={`size-1.5 rounded-full ${ui.dot}`} />
                {ui.label}
                {conf != null && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-foreground/80">
                    {Math.round(conf * 100)}%
                  </span>
                )}
              </div>
            )
          })()}
        </div>
      </div>

      <p className="mt-4 border-t pt-2.5 text-[11px] text-muted-foreground">
        Measured from the detected card edge to the printed border on all four sides.
        {borderType ? ` Border style: ${borderType}.` : ''} Same image always scores the same.
      </p>
    </div>
  )
}
