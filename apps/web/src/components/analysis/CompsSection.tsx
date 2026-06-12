import type { CompsSnapshot } from '@/types/analysis'

function confidenceLabel(score: number): string {
  if (score >= 0.7) return 'High confidence'
  if (score >= 0.5) return 'Medium confidence'
  if (score >= 0.3) return 'Low confidence'
  return 'Very low confidence'
}

function confidenceColor(score: number): string {
  if (score >= 0.7) return '#34d399'  // green
  if (score >= 0.5) return '#60a5fa'  // blue
  if (score >= 0.3) return '#fbbf24'  // amber
  return '#f87171'                     // red
}

interface Props {
  comps: CompsSnapshot
}

export function CompsSection({ comps }: Props) {
  const { rawEstimate, compRangeLow, compRangeHigh, confidenceScore, compCount, daysOfData } = comps
  const confColor = confidenceColor(confidenceScore)
  const confLabel = confidenceLabel(confidenceScore)

  return (
    <div data-testid="comps-section" className="space-y-4">
      {/* Hero price */}
      <div>
        <p className="text-[10px] uppercase tracking-widest text-zinc-500 font-medium mb-1">
          Market estimate
        </p>
        <p
          data-testid="comps-estimate"
          className="text-4xl font-bold tabular-nums text-white"
        >
          ${rawEstimate.toFixed(2)}
        </p>
        <p className="text-xs text-zinc-500 mt-1" data-testid="comps-range">
          Typically sells for ${compRangeLow.toFixed(2)} – ${compRangeHigh.toFixed(2)}
        </p>
      </div>

      {/* Confidence + data quality */}
      <div className="flex items-center gap-3">
        {/* Confidence bar */}
        <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{
              width:      `${Math.round(confidenceScore * 100)}%`,
              background: confColor,
            }}
          />
        </div>
        <span
          data-testid="comps-confidence"
          className="text-xs font-medium shrink-0 tabular-nums"
          style={{ color: confColor }}
        >
          {confLabel}
        </span>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-2">
        <StatChip label="Recent sales" value={`${compCount} sold`} testId="comps-count" />
        <StatChip label="Data window"  value={`${daysOfData} days`} testId="comps-days"  />
      </div>
    </div>
  )
}

function StatChip({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="rounded-lg bg-zinc-900/60 border border-zinc-800/60 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-widest text-zinc-600 font-medium">{label}</p>
      <p data-testid={testId} className="text-sm font-semibold text-zinc-200 mt-0.5 tabular-nums">
        {value}
      </p>
    </div>
  )
}
