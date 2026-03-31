import { Badge } from '@/components/ui/badge'
import type { CompsSnapshot } from '@/types/analysis'

function confidenceLabel(score: number): string {
  if (score >= 0.7) return 'High'
  if (score >= 0.5) return 'Medium'
  if (score >= 0.3) return 'Low'
  return 'Very Low'
}

function confidenceVariant(score: number): 'default' | 'secondary' | 'outline' {
  if (score >= 0.7) return 'default'
  if (score >= 0.5) return 'secondary'
  return 'outline'
}

interface Props {
  comps: CompsSnapshot
}

export function CompsSection({ comps }: Props) {
  const { rawEstimate, compRangeLow, compRangeHigh, confidenceScore, compCount, daysOfData } = comps

  return (
    <div data-testid="comps-section" className="space-y-3">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Market Estimate</p>
          <p className="text-3xl font-bold tabular-nums" data-testid="comps-estimate">
            ${rawEstimate.toFixed(2)}
          </p>
        </div>
        <Badge
          variant={confidenceVariant(confidenceScore)}
          data-testid="comps-confidence"
        >
          {confidenceLabel(confidenceScore)} confidence
        </Badge>
      </div>

      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <span data-testid="comps-range">
          Range: ${compRangeLow.toFixed(2)} – ${compRangeHigh.toFixed(2)}
        </span>
        <span className="text-border">·</span>
        <span data-testid="comps-count">{compCount} comp{compCount !== 1 ? 's' : ''}</span>
        <span className="text-border">·</span>
        <span data-testid="comps-days">{daysOfData}d of data</span>
      </div>
    </div>
  )
}
