import { describe, it, expect } from 'vitest'
import { calculateGradingScenarios } from '@/lib/engines/gradingRoi'
import { calculateFees } from '@/lib/engines/feeCalculator'

describe('calculateGradingScenarios', () => {
  it('returns 3 deduplicated grade scenarios for a high-condition card', () => {
    // score >= 18 → PSA 10 / PSA 9 / PSA 8 (3 distinct bands)
    const result = calculateGradingScenarios({ rawEstimate: 100, conditionScore: 19, netProceedsRaw: 80 })
    expect(result).toHaveLength(3)
    expect(result.map((s) => s.gradeLabel)).toEqual(['PSA 10', 'PSA 9', 'PSA 8'])
  })

  it('deduplicates when bands collapse (low condition)', () => {
    // score < 12 → all bands → PSA 7
    const result = calculateGradingScenarios({ rawEstimate: 100, conditionScore: 8, netProceedsRaw: 80 })
    expect(result).toHaveLength(1)
    expect(result[0].gradeLabel).toBe('PSA 7')
  })

  it('uses economy PSA tier for cards under $50', () => {
    const result = calculateGradingScenarios({ rawEstimate: 30, conditionScore: 18, netProceedsRaw: 20 })
    result.forEach((s) => expect(s.gradingFee).toBe(25))
  })

  it('uses standard PSA tier for cards $50–$199', () => {
    const result = calculateGradingScenarios({ rawEstimate: 100, conditionScore: 18, netProceedsRaw: 80 })
    result.forEach((s) => expect(s.gradingFee).toBe(50))
  })

  it('uses express PSA tier for cards >= $200', () => {
    const result = calculateGradingScenarios({ rawEstimate: 250, conditionScore: 18, netProceedsRaw: 200 })
    result.forEach((s) => expect(s.gradingFee).toBe(150))
  })

  it('uses score=14 (moderate) when conditionScore is null', () => {
    // score 14 → 12–15 range → PSA 8 / PSA 7 bands
    const withNull   = calculateGradingScenarios({ rawEstimate: 100, conditionScore: null, netProceedsRaw: 80 })
    const withScore14 = calculateGradingScenarios({ rawEstimate: 100, conditionScore: 14, netProceedsRaw: 80 })
    expect(withNull.map((s) => s.gradeLabel)).toEqual(withScore14.map((s) => s.gradeLabel))
  })

  it('gradedValue = rawEstimate * multiplier for PSA 10', () => {
    const result = calculateGradingScenarios({ rawEstimate: 100, conditionScore: 19, netProceedsRaw: 80 })
    const psa10 = result.find((s) => s.gradeLabel === 'PSA 10')!
    expect(psa10.gradedValue).toBe(450) // 100 * 4.5
  })

  it('netUpsideVsRawSell = gradedNetProceeds - netProceedsRaw', () => {
    const rawEstimate = 100
    const netProceedsRaw = 80
    const result = calculateGradingScenarios({ rawEstimate, conditionScore: 19, netProceedsRaw })
    const psa10 = result.find((s) => s.gradeLabel === 'PSA 10')!

    // gradedValue = 100 * 4.5 = 450
    // gradedNetProceeds = calculateFees({ salePrice: 450 }).netProceeds - (50 + 15)
    const feeResult = calculateFees({ salePrice: 450 })
    const expectedGradedNet = feeResult.netProceeds - 65 // standard tier (100 >= 50) + shipping
    const expectedUpside = expectedGradedNet - netProceedsRaw

    expect(psa10.netUpsideVsRawSell).toBeCloseTo(expectedUpside, 1)
  })

  it('marks strong recommendation when upside > 50% of netProceedsRaw and gradedValue > 50', () => {
    // Use a $200 card — PSA 10 would be 900, huge upside
    const result = calculateGradingScenarios({ rawEstimate: 200, conditionScore: 19, netProceedsRaw: 150 })
    const psa10 = result.find((s) => s.gradeLabel === 'PSA 10')!
    expect(psa10.recommendation).toBe('strong')
  })

  it('marks negative when upside <= 10% of netProceedsRaw', () => {
    // Very low value — PSA 7 on $12 card
    const result = calculateGradingScenarios({ rawEstimate: 12, conditionScore: 8, netProceedsRaw: 5 })
    expect(result[0].recommendation).toBe('negative')
  })

  it('shippingToGrader is always 15', () => {
    const result = calculateGradingScenarios({ rawEstimate: 100, conditionScore: 19, netProceedsRaw: 80 })
    result.forEach((s) => expect(s.shippingToGrader).toBe(15))
  })

  it('roiPercent is 0 when netProceedsRaw is 0', () => {
    const result = calculateGradingScenarios({ rawEstimate: 100, conditionScore: 19, netProceedsRaw: 0 })
    result.forEach((s) => expect(s.roiPercent).toBe(0))
  })
})
