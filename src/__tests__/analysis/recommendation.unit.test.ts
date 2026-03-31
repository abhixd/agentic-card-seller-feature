import { describe, it, expect } from 'vitest'
import { generateRecommendation, THRESHOLDS } from '@/lib/engines/recommendation'
import type { RecommendationInput, GradingScenario } from '@/types/analysis'

function baseInput(overrides: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    identificationConfidence: 1.0,
    compsConfidence:          0.7,
    compCount:                8,
    rawEstimate:              100,
    netProceedsRaw:           80,
    conditionScore:           18,
    bestGradingScenario:      null,
    daysOfData:               30,
    ...overrides,
  }
}

function mockScenario(rec: GradingScenario['recommendation'], upside = 50): GradingScenario {
  return {
    gradeLabel:         'PSA 10',
    gradedValue:        400,
    gradingFee:         50,
    shippingToGrader:   15,
    netUpsideVsRawSell: upside,
    roiPercent:         62.5,
    recommendation:     rec,
    tierLabel:          'Best Case — PSA Standard (~45 days)',
  }
}

describe('generateRecommendation', () => {
  // Gate 1
  it('returns INSUFFICIENT_CONFIDENCE when id confidence is too low', () => {
    const result = generateRecommendation(baseInput({ identificationConfidence: 0.4 }))
    expect(result.type).toBe('INSUFFICIENT_CONFIDENCE')
    expect(result.rationale).toMatch(/identification confidence/i)
  })

  it('passes gate 1 at exactly MIN_ID_CONFIDENCE', () => {
    const result = generateRecommendation(baseInput({ identificationConfidence: THRESHOLDS.MIN_ID_CONFIDENCE }))
    expect(result.type).not.toBe('INSUFFICIENT_CONFIDENCE')
  })

  // Gate 2
  it('returns INSUFFICIENT_CONFIDENCE when compCount is too low', () => {
    const result = generateRecommendation(baseInput({ compCount: 2 }))
    expect(result.type).toBe('INSUFFICIENT_CONFIDENCE')
    expect(result.rationale).toMatch(/2 recent sales/i)
  })

  it('returns INSUFFICIENT_CONFIDENCE when compsConfidence is too low', () => {
    const result = generateRecommendation(baseInput({ compsConfidence: 0.1 }))
    expect(result.type).toBe('INSUFFICIENT_CONFIDENCE')
  })

  it('uses singular "sale" when compCount is 1', () => {
    const result = generateRecommendation(baseInput({ compCount: 1 }))
    expect(result.rationale).toMatch(/1 recent sale[^s]/)
  })

  // Gate 3
  it('returns HOLD when data is stale and sparse', () => {
    const result = generateRecommendation(
      baseInput({ daysOfData: 100, compCount: 5 })
    )
    expect(result.type).toBe('HOLD')
    expect(result.rationale).toMatch(/sparse/i)
  })

  it('does NOT return HOLD when stale but comp count is sufficient', () => {
    const result = generateRecommendation(
      baseInput({ daysOfData: 100, compCount: THRESHOLDS.STALE_MIN_COMPS })
    )
    expect(result.type).not.toBe('HOLD')
  })

  // Gate 4
  it('returns SELL_RAW for very low value card', () => {
    const result = generateRecommendation(baseInput({ rawEstimate: 10, netProceedsRaw: 5 }))
    expect(result.type).toBe('SELL_RAW')
    expect(result.rationale).toMatch(/below the minimum grading fee threshold/i)
  })

  it('does not trigger low-value gate at exactly LOW_VALUE_CEILING', () => {
    // At exactly the ceiling value, gate 4 fires (< is strictly less than)
    const below = generateRecommendation(baseInput({ rawEstimate: THRESHOLDS.LOW_VALUE_CEILING - 0.01 }))
    const at    = generateRecommendation(baseInput({ rawEstimate: THRESHOLDS.LOW_VALUE_CEILING }))
    expect(below.type).toBe('SELL_RAW')
    expect(at.type).not.toMatch(/INSUFFICIENT/)
  })

  // Gate 5
  it('returns GRADE for strong grading scenario with good condition', () => {
    const result = generateRecommendation(
      baseInput({
        conditionScore:     18,
        rawEstimate:        100,
        bestGradingScenario: mockScenario('strong', 60),
      })
    )
    expect(result.type).toBe('GRADE')
    expect(result.rationale).toMatch(/strong condition/i)
  })

  it('does NOT return GRADE when condition is too low for strong scenario', () => {
    const result = generateRecommendation(
      baseInput({
        conditionScore:     12,  // below MIN_CONDITION_GRADE (16)
        rawEstimate:        100,
        bestGradingScenario: mockScenario('strong', 60),
      })
    )
    expect(result.type).toBe('SELL_RAW')
  })

  it('includes condition warning when conditionScore is null but strong scenario exists', () => {
    const result = generateRecommendation(
      baseInput({
        conditionScore:     null,
        rawEstimate:        100,
        bestGradingScenario: mockScenario('strong', 60),
      })
    )
    // effectiveCondition = 14, which is below MIN_CONDITION_GRADE (16) → SELL_RAW
    expect(result.type).toBe('SELL_RAW')
  })

  // Gate 6
  it('returns GRADE for marginal scenario with sufficient condition and value', () => {
    const result = generateRecommendation(
      baseInput({
        conditionScore:     16,
        rawEstimate:        50,
        bestGradingScenario: mockScenario('marginal', 15),
      })
    )
    expect(result.type).toBe('GRADE')
    expect(result.rationale).toMatch(/marginal/i)
  })

  it('does NOT return GRADE for marginal scenario below MARGINAL_GRADE_MIN', () => {
    const result = generateRecommendation(
      baseInput({
        conditionScore:     16,
        rawEstimate:        25,  // below MARGINAL_GRADE_MIN (30)
        bestGradingScenario: mockScenario('marginal', 5),
      })
    )
    expect(result.type).toBe('SELL_RAW')
  })

  // Default
  it('returns SELL_RAW as default when no grade scenario warrants it', () => {
    const result = generateRecommendation(
      baseInput({ bestGradingScenario: mockScenario('negative', -10) })
    )
    expect(result.type).toBe('SELL_RAW')
    expect(result.rationale).toMatch(/grading upside does not justify/i)
  })

  it('includes condition note in SELL_RAW rationale when condition is too low', () => {
    const result = generateRecommendation(
      baseInput({
        conditionScore:     10,
        bestGradingScenario: mockScenario('marginal', 20),
      })
    )
    expect(result.type).toBe('SELL_RAW')
    expect(result.rationale).toMatch(/condition score does not support/i)
  })
})
