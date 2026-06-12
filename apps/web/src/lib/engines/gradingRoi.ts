import type { GradingScenario } from '@/types/analysis'
import { calculateFees } from './feeCalculator'

// Grade multipliers applied to the raw estimate
const GRADE_MULTIPLIERS: Record<string, number> = {
  'PSA 10': 4.5,
  'PSA 9':  2.0,
  'PSA 8':  1.2,
  'PSA 7':  0.8,
}

// PSA fee tiers selected by card value
const PSA_TIERS = {
  economy:  { fee: 25,  label: 'PSA Economy (~90 days)' },
  standard: { fee: 50,  label: 'PSA Standard (~45 days)' },
  express:  { fee: 150, label: 'PSA Express (~10 days)' },
}

const SHIPPING_TO_GRADER = 15  // round-trip, estimated

// Map condition score (4–20) to likely grade bands: best / base / downside
function conditionToBands(score: number): { best: string; base: string; down: string } {
  if (score >= 18) return { best: 'PSA 10', base: 'PSA 9', down: 'PSA 8' }
  if (score >= 16) return { best: 'PSA 9',  base: 'PSA 8', down: 'PSA 7' }
  if (score >= 12) return { best: 'PSA 8',  base: 'PSA 7', down: 'PSA 7' }
  return              { best: 'PSA 7',  base: 'PSA 7', down: 'PSA 7' }
}

export interface GradingInput {
  rawEstimate: number
  conditionScore: number | null  // null → assume moderate (14)
  netProceedsRaw: number
}

export function calculateGradingScenarios(input: GradingInput): GradingScenario[] {
  const { rawEstimate, conditionScore, netProceedsRaw } = input
  const score = conditionScore ?? 14
  const bands = conditionToBands(score)

  // Deduplicate bands while preserving order (best → base → downside)
  const targetGrades = [bands.best, bands.base, bands.down].filter(
    (g, i, arr) => arr.indexOf(g) === i
  )

  // Choose PSA tier by card value
  const tier =
    rawEstimate >= 200 ? PSA_TIERS.express
    : rawEstimate >= 50 ? PSA_TIERS.standard
    : PSA_TIERS.economy

  const scenarioLabels = ['Best Case', 'Base Case', 'Downside']

  return targetGrades.map((gradeLabel, index) => {
    const multiplier  = GRADE_MULTIPLIERS[gradeLabel] ?? 1.0
    const gradedValue = rawEstimate * multiplier
    const totalCost   = tier.fee + SHIPPING_TO_GRADER

    const gradedNetProceeds =
      calculateFees({ salePrice: gradedValue, platform: 'ebay' }).netProceeds - totalCost

    const netUpsideVsRawSell = gradedNetProceeds - netProceedsRaw
    const roiPercent = netProceedsRaw > 0 ? (netUpsideVsRawSell / netProceedsRaw) * 100 : 0

    const recommendation: GradingScenario['recommendation'] =
      netUpsideVsRawSell > netProceedsRaw * 0.5 && gradedValue > 50 ? 'strong'
      : netUpsideVsRawSell > netProceedsRaw * 0.1                   ? 'marginal'
      : 'negative'

    return {
      gradeLabel,
      gradedValue:          round2(gradedValue),
      gradingFee:           tier.fee,
      shippingToGrader:     SHIPPING_TO_GRADER,
      netUpsideVsRawSell:   round2(netUpsideVsRawSell),
      roiPercent:           round1(roiPercent),
      recommendation,
      tierLabel:            `${scenarioLabels[index]} — ${tier.label}`,
    }
  })
}

function round2(n: number) { return Math.round(n * 100) / 100 }
function round1(n: number) { return Math.round(n * 10) / 10 }
