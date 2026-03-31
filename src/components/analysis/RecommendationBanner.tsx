import { DollarSign, Award, Clock, AlertCircle } from 'lucide-react'
import type { RecommendationType } from '@/types/analysis'

const CONFIG: Record<
  RecommendationType,
  { label: string; Icon: typeof DollarSign; classes: string; iconClass: string }
> = {
  SELL_RAW: {
    label: 'Sell Raw',
    Icon: DollarSign,
    classes: 'bg-green-50 border-green-200 text-green-900',
    iconClass: 'text-green-600',
  },
  GRADE: {
    label: 'Submit for Grading',
    Icon: Award,
    classes: 'bg-blue-50 border-blue-200 text-blue-900',
    iconClass: 'text-blue-600',
  },
  HOLD: {
    label: 'Hold',
    Icon: Clock,
    classes: 'bg-amber-50 border-amber-200 text-amber-900',
    iconClass: 'text-amber-600',
  },
  INSUFFICIENT_CONFIDENCE: {
    label: 'Insufficient Data',
    Icon: AlertCircle,
    classes: 'bg-gray-50 border-gray-200 text-gray-800',
    iconClass: 'text-gray-500',
  },
}

interface Props {
  type: RecommendationType
  rationale: string
}

export function RecommendationBanner({ type, rationale }: Props) {
  const { label, Icon, classes, iconClass } = CONFIG[type]

  return (
    <div
      data-testid="recommendation-banner"
      className={`rounded-xl border p-4 space-y-2 ${classes}`}
    >
      <div className="flex items-center gap-2">
        <Icon className={`h-5 w-5 shrink-0 ${iconClass}`} />
        <span className="font-semibold text-base" data-testid="recommendation-type">
          {label}
        </span>
      </div>
      <p className="text-sm leading-relaxed" data-testid="recommendation-rationale">
        {rationale}
      </p>
    </div>
  )
}
