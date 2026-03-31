import { Badge } from '@/components/ui/badge'
import type { GradingScenario } from '@/types/analysis'

const REC_CONFIG = {
  strong:   { label: 'Strong',   variant: 'default' as const,    class: '' },
  marginal: { label: 'Marginal', variant: 'secondary' as const,  class: '' },
  negative: { label: 'Negative', variant: 'outline' as const,    class: 'text-muted-foreground' },
}

interface Props {
  scenarios: GradingScenario[]
}

export function GradingScenarios({ scenarios }: Props) {
  if (scenarios.length === 0) return null

  return (
    <div data-testid="grading-scenarios" className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-muted-foreground text-xs">
              <th className="text-left pb-2 font-medium">Grade</th>
              <th className="text-right pb-2 font-medium">Est. Value</th>
              <th className="text-right pb-2 font-medium">Cost</th>
              <th className="text-right pb-2 font-medium">Upside</th>
              <th className="text-right pb-2 font-medium">Rec.</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {scenarios.map((s, i) => {
              const recCfg = REC_CONFIG[s.recommendation]
              const upsideSign = s.netUpsideVsRawSell >= 0 ? '+' : ''
              return (
                <tr
                  key={i}
                  data-testid={`grading-scenario-${s.gradeLabel.replace(' ', '-').toLowerCase()}`}
                  className="py-2"
                >
                  <td className="py-2 font-medium">{s.gradeLabel}</td>
                  <td className="py-2 text-right tabular-nums">${s.gradedValue.toFixed(2)}</td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">
                    ${(s.gradingFee + s.shippingToGrader).toFixed(0)}
                  </td>
                  <td className={`py-2 text-right tabular-nums ${s.netUpsideVsRawSell >= 0 ? 'text-green-600' : 'text-destructive'}`}>
                    {upsideSign}${Math.abs(s.netUpsideVsRawSell).toFixed(2)}
                  </td>
                  <td className="py-2 text-right">
                    <Badge variant={recCfg.variant} className="text-xs">
                      {recCfg.label}
                    </Badge>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Cost includes PSA fee + ~$15 round-trip shipping. Upside is vs. raw sale net proceeds.
      </p>
    </div>
  )
}
