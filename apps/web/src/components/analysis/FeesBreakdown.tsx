import type { FeeCalculatorResult } from '@/types/analysis'

interface Props {
  fees: FeeCalculatorResult
}

export function FeesBreakdown({ fees }: Props) {
  const { grossRevenue, platformFee, shippingCost, acquisitionCost, netProceeds, roi, platform } = fees

  const roiPositive = roi !== null && roi >= 0

  return (
    <div data-testid="fees-breakdown" className="space-y-4">
      {/* Hero: You Keep */}
      <div
        className="rounded-xl px-4 py-4 text-center"
        style={{
          background: netProceeds >= 0
            ? 'linear-gradient(135deg, rgba(16,185,129,0.12) 0%, rgba(16,185,129,0.05) 100%)'
            : 'linear-gradient(135deg, rgba(239,68,68,0.12) 0%, rgba(239,68,68,0.05) 100%)',
          border: `1px solid ${netProceeds >= 0 ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)'}`,
        }}
      >
        <p className="text-[10px] uppercase tracking-widest font-semibold text-zinc-500 mb-1">
          You keep
        </p>
        <p
          data-testid="fee-net"
          className="text-4xl font-bold tabular-nums"
          style={{ color: netProceeds >= 0 ? '#34d399' : '#f87171' }}
        >
          ${Math.abs(netProceeds).toFixed(2)}
        </p>
        {roi !== null && (
          <p
            data-testid="fee-roi"
            className="text-sm font-medium mt-1 tabular-nums"
            style={{ color: roiPositive ? '#6ee7b7' : '#fca5a5' }}
          >
            {roi >= 0 ? '+' : ''}{roi.toFixed(1)}% return on cost
          </p>
        )}
      </div>

      {/* Line items */}
      <div className="space-y-0 rounded-xl overflow-hidden border border-zinc-800/60">
        <FeeRow label="Sale price"      value={grossRevenue}      testId="fee-gross"       />
        <FeeRow label={`${platform} fee`} value={-platformFee}  negative testId="fee-platform"  />
        <FeeRow label="Shipping"         value={-shippingCost}  negative testId="fee-shipping"  />
        {acquisitionCost > 0 && (
          <FeeRow label="You paid"       value={-acquisitionCost} negative testId="fee-acquisition" />
        )}
      </div>
    </div>
  )
}

function FeeRow({
  label, value, negative, testId,
}: {
  label: string; value: number; negative?: boolean; testId?: string
}) {
  const display = Math.abs(value)
  const isNeg = value < 0 || negative

  return (
    <div className="flex justify-between items-center px-3.5 py-2.5 bg-zinc-900/50 border-b border-zinc-800/50 last:border-0 text-sm">
      <span className="text-zinc-400">{label}</span>
      <span
        data-testid={testId}
        className={`tabular-nums font-medium ${isNeg ? 'text-zinc-500' : 'text-zinc-200'}`}
      >
        {isNeg ? '−' : ''}${display.toFixed(2)}
      </span>
    </div>
  )
}
