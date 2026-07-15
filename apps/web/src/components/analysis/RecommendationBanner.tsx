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
      className="relative overflow-hidden rounded-2xl border p-6"
      style={{ background: c.bg, borderColor: c.border }}
    >
      <style>{`
        @keyframes verdictRise { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
        @keyframes verdictGlow { 0%,100% { opacity: .22 } 50% { opacity: .42 } }
      `}</style>
      {/* Ambient verdict-colored glow */}
      <div aria-hidden className="pointer-events-none absolute -top-14 -right-10 h-44 w-44 rounded-full blur-3xl"
        style={{ background: `radial-gradient(circle, ${c.dot} 0%, transparent 70%)`, animation: 'verdictGlow 5s ease-in-out infinite' }} />

      <div className="relative space-y-3.5" style={{ animation: 'verdictRise .5s cubic-bezier(.22,1,.36,1)' }}>
        {/* The verdict */}
        <div className="flex items-center gap-4">
          <div
            className="flex items-center justify-center w-14 h-14 rounded-2xl shrink-0"
            style={{ background: c.iconBg, boxShadow: `0 0 24px ${c.dot}55, inset 0 1px 0 rgba(255,255,255,0.08)` }}
          >
            <c.Icon className="h-7 w-7" style={{ color: c.iconColor }} />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: `${c.iconColor}88` }}>
              The verdict
            </p>
            <div className="flex items-center gap-2.5">
              <span
                data-testid="recommendation-type"
                className="font-extrabold text-2xl sm:text-[28px] tracking-tight leading-tight"
                style={{ color: c.textColor }}
              >
                {c.label}
              </span>
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: c.dot, boxShadow: `0 0 8px ${c.dot}` }} />
            </div>
            <p className="text-xs mt-0.5" style={{ color: `${c.iconColor}99` }}>
              {c.sublabel}
            </p>
          </div>
        </div>

        {/* Rationale */}
        <p
          data-testid="recommendation-rationale"
          className="text-sm leading-relaxed border-l-2 pl-3"
          style={{ color: `${c.textColor}cc`, borderColor: `${c.dot}55` }}
        >
          {rationale}
        </p>
      </div>
    </div>
  )
}
