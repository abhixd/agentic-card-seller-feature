import { describe, it, expect } from 'vitest'
import { computeInvestmentScores, type PricePoint, type ScoreInputs } from '@/lib/intelligence/scores'
import type { ConsensusPrice } from '@/lib/pricing/consensus'

function consensus(price: number, over: Partial<ConsensusPrice> = {}): ConsensusPrice {
  return {
    version: 'raw', price, range: { low: price * 0.9, high: price * 1.1 },
    confidence: 'high', confidenceScore: 0.8, sources: [{ source: 'ebay', price, weight: 1, n: 10 }],
    outliers: [], sampleSize: 10, asOf: '2026-06-22T00:00:00Z', ...over,
  }
}

function risingHistory(): PricePoint[] {
  // ~+25% over 90 days, smooth
  return [
    { date: '2026-03-24', price: 100 },
    { date: '2026-04-08', price: 104 },
    { date: '2026-04-23', price: 109 },
    { date: '2026-05-08', price: 113 },
    { date: '2026-05-23', price: 118 },
    { date: '2026-06-07', price: 122 },
    { date: '2026-06-22', price: 125 },
  ]
}

describe('computeInvestmentScores', () => {
  it('flags a strong opportunity: rising, liquid, undervalued, grading upside', () => {
    const inputs: ScoreInputs = {
      consensus: consensus(125),
      history: risingHistory(),
      liquidity: { salesPerMonth: 40 },
      marketPrice: 105,            // 16% below consensus → undervalued
      gradingUpsideRoiPercent: 140,
      gradedPopulation: 800,
      reprintRisk: false,
    }
    const r = computeInvestmentScores(inputs)
    expect(r.opportunity.score).toBeGreaterThanOrEqual(60)
    expect(['Strong Opportunity', 'Good Opportunity']).toContain(r.opportunity.label)
    expect(r.valuation).toBe('Undervalued')
    expect(r.risk.score).toBeLessThan(50)
    expect(['Low Risk', 'Very Low Risk', 'Moderate Risk']).toContain(r.risk.label)
    // factors are exposed for the "see reasoning" UI
    expect(r.opportunity.factors.find((f) => f.key === 'fairvalue')).toBeTruthy()
    expect(r.opportunity.factors.every((f) => f.detail.length > 0)).toBe(true)
  })

  it('flags high risk for a thin, volatile, overheated, high-pop card', () => {
    const spikeHistory: PricePoint[] = [
      { date: '2026-05-23', price: 100 },
      { date: '2026-06-01', price: 96 },
      { date: '2026-06-10', price: 140 },
      { date: '2026-06-22', price: 185 }, // +32% latest move
    ]
    const r = computeInvestmentScores({
      consensus: consensus(150, { confidence: 'medium' }),
      history: spikeHistory,
      liquidity: { salesPerMonth: 3 },
      marketPrice: 185,            // 23% above consensus
      gradedPopulation: 9000,
      reprintRisk: true,
    })
    expect(r.risk.score).toBeGreaterThanOrEqual(60)
    expect(['High Risk', 'Very High Risk']).toContain(r.risk.label)
    expect(r.valuation).toBe('Overheated')
  })

  it('produces 1–100 scores with matching labels', () => {
    const r = computeInvestmentScores({
      consensus: consensus(50),
      history: risingHistory(),
      liquidity: { salesPerMonth: 12 },
      marketPrice: 50,
    })
    for (const s of [r.opportunity.score, r.risk.score]) {
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(100)
    }
    // label thresholds line up with the score
    if (r.opportunity.score >= 80) expect(r.opportunity.label).toBe('Strong Opportunity')
    if (r.risk.score < 20) expect(r.risk.label).toBe('Very Low Risk')
  })

  it('marks lowData when inputs are sparse', () => {
    const r = computeInvestmentScores({
      consensus: consensus(20, { confidence: 'low', sampleSize: 1 }),
      marketPrice: 20,
    })
    expect(r.lowData).toBe(true)
  })

  it('neutral valuation when market sits at consensus', () => {
    const r = computeInvestmentScores({
      consensus: consensus(100),
      history: risingHistory(),
      liquidity: { salesPerMonth: 15 },
      marketPrice: 100,
    })
    expect(r.valuation).toBe('Fairly Valued')
  })
})
