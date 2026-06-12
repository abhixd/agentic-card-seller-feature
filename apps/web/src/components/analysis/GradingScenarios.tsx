import type { GradingScenario } from '@/types/analysis'

const REC_CONFIG = {
  strong:   { label: '✓ Worth it',  bg: 'rgba(16,185,129,0.12)',  border: 'rgba(16,185,129,0.30)',  text: '#34d399' },
  marginal: { label: '~ Maybe',     bg: 'rgba(245,158,11,0.10)',  border: 'rgba(245,158,11,0.28)',  text: '#fbbf24' },
  negative: { label: '✗ Skip it',   bg: 'rgba(113,113,122,0.08)', border: 'rgba(113,113,122,0.20)', text: '#71717a' },
}

interface Props {
  scenarios: GradingScenario[]
}

export function GradingScenarios({ scenarios }: Props) {
  if (scenarios.length === 0) return null

  return (
    <div data-testid="grading-scenarios" className="space-y-3">
      {/* Header */}
      <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-4 px-1 text-[10px] uppercase tracking-widest text-zinc-600 font-medium">
        <span>If graded…</span>
        <span className="text-right">Est. value</span>
        <span className="text-right">Cost</span>
        <span className="text-right">Extra profit</span>
        <span className="text-right">Verdict</span>
      </div>

      {/* Rows */}
      <div className="space-y-1.5">
        {scenarios.map((s, i) => {
          const rec = REC_CONFIG[s.recommendation]
          const upsideSign = s.netUpsideVsRawSell >= 0 ? '+' : '−'
          const upsideColor = s.netUpsideVsRawSell >= 0 ? '#34d399' : '#f87171'

          return (
            <div
              key={i}
              data-testid={`grading-scenario-${s.gradeLabel.replace(' ', '-').toLowerCase()}`}
              className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-x-4 rounded-xl px-3.5 py-3 border"
              style={{ background: 'rgba(24,24,27,0.6)', borderColor: 'rgba(63,63,70,0.5)' }}
            >
              {/* Grade label */}
              <span className="font-semibold text-sm text-zinc-200">{s.gradeLabel}</span>

              {/* Graded value */}
              <span className="text-sm tabular-nums font-medium text-zinc-200 text-right">
                ${s.gradedValue.toFixed(2)}
              </span>

              {/* Cost */}
              <span className="text-sm tabular-nums text-zinc-500 text-right">
                −${(s.gradingFee + s.shippingToGrader).toFixed(0)}
              </span>

              {/* Upside */}
              <span className="text-sm tabular-nums font-semibold text-right" style={{ color: upsideColor }}>
                {upsideSign}${Math.abs(s.netUpsideVsRawSell).toFixed(2)}
              </span>

              {/* Recommendation badge */}
              <span
                className="text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap text-right"
                style={{
                  background:  rec.bg,
                  border:      `1px solid ${rec.border}`,
                  color:       rec.text,
                }}
              >
                {rec.label}
              </span>
            </div>
          )
        })}
      </div>

      <p className="text-[10px] text-zinc-600 leading-relaxed px-1">
        Grading cost includes PSA fee + ~$15 round-trip shipping.
        &ldquo;Extra profit&rdquo; is vs. selling raw today.
      </p>
    </div>
  )
}
