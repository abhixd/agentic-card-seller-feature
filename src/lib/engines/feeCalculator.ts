import type { FeeCalculatorResult } from '@/types/analysis'

export type Platform = 'ebay' | 'tcgplayer'

const PLATFORM_FEES: Record<Platform, { percentFee: number; fixedFee: number; label: string }> = {
  ebay:      { percentFee: 0.1325, fixedFee: 0.30, label: 'eBay (13.25% + $0.30)' },
  tcgplayer: { percentFee: 0.1025, fixedFee: 0.30, label: 'TCGplayer (10.25% + $0.30)' },
}

export interface FeeCalcInput {
  salePrice: number
  platform?: Platform
  shippingCost?: number
  acquisitionCost?: number
}

export function calculateFees({
  salePrice,
  platform = 'ebay',
  shippingCost = 4.0,
  acquisitionCost = 0,
}: FeeCalcInput): FeeCalculatorResult {
  const fees = PLATFORM_FEES[platform]
  const platformFee = salePrice * fees.percentFee + fees.fixedFee
  // netProceeds is the profit after all costs including acquisition
  const netProceeds = salePrice - platformFee - shippingCost - acquisitionCost

  // ROI = net profit / acquisition cost
  // netProceeds already has acquisitionCost subtracted, so it IS the profit
  const roi =
    acquisitionCost > 0
      ? (netProceeds / acquisitionCost) * 100
      : null

  return {
    grossRevenue: salePrice,
    platformFee:     round2(platformFee),
    shippingCost,
    acquisitionCost,
    netProceeds:     round2(netProceeds),
    roi: roi !== null ? round1(roi) : null,
    platform: fees.label,
    breakdown: [
      { label: 'Sale Price',   amount: salePrice },
      { label: fees.label,     amount: -round2(platformFee) },
      { label: 'Shipping',     amount: -shippingCost },
      ...(acquisitionCost > 0
        ? [{ label: 'Acquisition Cost', amount: -acquisitionCost }]
        : []),
      { label: 'Net Proceeds', amount: round2(netProceeds) },
    ],
  }
}

function round2(n: number) { return Math.round(n * 100) / 100 }
function round1(n: number) { return Math.round(n * 10) / 10 }
