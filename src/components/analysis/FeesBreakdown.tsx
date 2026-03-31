import { Separator } from '@/components/ui/separator'
import type { FeeCalculatorResult } from '@/types/analysis'

interface LineProps {
  label: string
  amount: number
  bold?: boolean
  positive?: boolean
  testId?: string
}

function Line({ label, amount, bold, positive, testId }: LineProps) {
  const sign = amount >= 0 ? (positive ? '+' : '') : ''
  return (
    <div className={`flex justify-between text-sm ${bold ? 'font-semibold' : ''}`}>
      <span className={bold ? '' : 'text-muted-foreground'}>{label}</span>
      <span
        data-testid={testId}
        className={`tabular-nums ${amount < 0 ? 'text-destructive' : bold ? '' : ''}`}
      >
        {sign}${Math.abs(amount).toFixed(2)}
      </span>
    </div>
  )
}

interface Props {
  fees: FeeCalculatorResult
}

export function FeesBreakdown({ fees }: Props) {
  const { grossRevenue, platformFee, shippingCost, acquisitionCost, netProceeds, roi, platform } = fees

  return (
    <div data-testid="fees-breakdown" className="space-y-2">
      <Line label="Sale Price" amount={grossRevenue} testId="fee-gross" />
      <Line label={`${platform} Fee`} amount={-platformFee} testId="fee-platform" />
      <Line label="Shipping" amount={-shippingCost} testId="fee-shipping" />
      {acquisitionCost > 0 && (
        <Line label="Acquisition Cost" amount={-acquisitionCost} testId="fee-acquisition" />
      )}
      <Separator />
      <Line label="Net Proceeds" amount={netProceeds} bold testId="fee-net" />
      {roi !== null && (
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">ROI</span>
          <span
            data-testid="fee-roi"
            className={`tabular-nums font-medium ${roi >= 0 ? 'text-green-600' : 'text-destructive'}`}
          >
            {roi >= 0 ? '+' : ''}{roi.toFixed(1)}%
          </span>
        </div>
      )}
    </div>
  )
}
