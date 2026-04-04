import { DollarSign, Award, Clock, AlertCircle } from 'lucide-react'
import type { RecommendationType } from '@/types/analysis'

const CONFIG: Record<
  RecommendationType,
  {
    label:      string
    sublabel:   string
    Icon:       typeof DollarSign
    bg:         string
    border:     string
    iconBg:     string
    iconColor:  string
    textColor:  string
    dot:        string
  }
> = {
  SELL_RAW: {
    label:     'Sell It',
    sublabel:  'Best move right now',
    Icon:      DollarSign,
    bg:        'rgba(16,185,129,0.08)',
    border:    'rgba(16,185,129,0.25)',
    iconBg:    'rgba(16,185,129,0.18)',
    iconColor: '#34d399',
    textColor: '#d1fae5',
    dot:       '#10b981',
  },
  GRADE: {
    label:     'Send for Grading',
    sublabel:  'Grading adds meaningful value',
    Icon:      Award,
    bg:        'rgba(99,102,241,0.08)',
    border:    'rgba(99,102,241,0.25)',
    iconBg:    'rgba(99,102,241,0.18)',
    iconColor: '#818cf8',
    textColor: '#e0e7ff',
    dot:       '#6366f1',
  },
  HOLD: {
    label:     'Hold It',
    sublabel:  'Not the right time to sell',
    Icon:      Clock,
    bg:        'rgba(245,158,11,0.08)',
    border:    'rgba(245,158,11,0.25)',
    iconBg:    'rgba(245,158,11,0.18)',
    iconColor: '#fbbf24',
    textColor: '#fef3c7',
    dot:       '#f59e0b',
  },
  INSUFFICIENT_CONFIDENCE: {
    label:     'Not Enough Data',
    sublabel:  'Hard to make a call right now',
    Icon:      AlertCircle,
    bg:        'rgba(113,113,122,0.08)',
    border:    'rgba(113,113,122,0.20)',
    iconBg:    'rgba(113,113,122,0.15)',
    iconColor: '#a1a1aa',
    textColor: '#d4d4d8',
    dot:       '#71717a',
  },
}

interface Props {
  type:      RecommendationType
  rationale: string
}

export function RecommendationBanner({ type, rationale }: Props) {
  const c = CONFIG[type]

  return (
    <div
      data-testid="recommendation-banner"
      className="rounded-2xl border p-5 space-y-3"
      style={{ background: c.bg, borderColor: c.border }}
    >
      {/* Top row: icon + label */}
      <div className="flex items-center gap-3">
        <div
          className="flex items-center justify-center w-10 h-10 rounded-xl shrink-0"
          style={{ background: c.iconBg }}
        >
          <c.Icon className="h-5 w-5" style={{ color: c.iconColor }} />
        </div>
        <div>
          <div className="flex items-center gap-2">
            {/* Status dot */}
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: c.dot }} />
            <span
              data-testid="recommendation-type"
              className="font-bold text-base"
              style={{ color: c.textColor }}
            >
              {c.label}
            </span>
          </div>
          <p className="text-xs mt-0.5" style={{ color: `${c.iconColor}99` }}>
            {c.sublabel}
          </p>
        </div>
      </div>

      {/* Rationale */}
      <p
        data-testid="recommendation-rationale"
        className="text-sm leading-relaxed"
        style={{ color: `${c.textColor}cc` }}
      >
        {rationale}
      </p>
    </div>
  )
}
