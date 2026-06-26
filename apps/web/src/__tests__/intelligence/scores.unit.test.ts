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
  return [
    { date: '2026-03-24', price: 100 },
    { date: '2026-04-23', price: 109 },
    { date: '2026-05-23', price: 118 },
    { date: '2026-06-22', price: 125 },
  ]
}

describe('computeInvestmentScores', () => {
  it('flags a strong opportunity: rising, liquid, undervalued, grading upside', () => {
    const inputs: ScoreInputs = {
      consensus: consensus(125),
      history: risingHistory(),
      liquidity: { salesPerMonth: 40 },
      marketPrice: 105,            // ~16% below consensus → undervalued
      gradingUpsideRoiPercent: 140,
    }
    const r = computeInvestmentScores(inputs)
    expect(r.opportunity.insufficient).toBe(false)
    expect(r.opportunity.score).toBeGreaterThanOrEqual(60)
    expect(r.valuation).toBe('Undervalued')
    expect(r.risk.score).toBeLessThan(50)
    // only the trimmed, money-relevant factors
    expect(r.opportunity.factors.map((f) => f.key).sort()).toEqual(['fairvalue', 'grading', 'liquidity', 'momentum'])
    expect(r.risk.factors.map((f) => f.key).sort()).toEqual(['overpay', 'thin-volume', 'volatility'])
  })

  it('flags high risk for a thin, volatile, overpriced card', () => {
    const spikeHistory: PricePoint[] = [
      { date: '2026-05-23', price: 100 },
      { date: '2026-06-01', price: 70 },
      { date: '2026-06-10', price: 150 },
      { date: '2026-06-22', price: 95 },
    ]
    const r = computeInvestmentScores({
      consensus: consensus(120),
      history: spikeHistory,
      liquidity: { salesPerMonth: 2 },
      marketPrice: 150,            // 25% above consensus
    })
    expect(r.risk.insufficient).toBe(false)
    expect(r.risk.score).toBeGreaterThanOrEqual(60)
    expect(r.valuation).toBe('Overheated')
  })

  it('reports INSUFFICIENT (no fabricated number) when data is thin', () => {
    // only a consensus price + grading upside → just 1 opportunity factor, 0 risk factors
    const r = computeInvestmentScores({
      consensus: consensus(40, { confidence: 'low', sampleSize: 1 }),
      gradingUpsideRoiPercent: 50,
    })
    expect(r.opportunity.insufficient).toBe(true)  // < 2 reliable factors
    expect(r.risk.insufficient).toBe(true)         // 0 reliable factors
    expect(r.valuation).toBe('Unknown')            // no independent market price
    expect(r.lowData).toBe(true)
  })

  it('does not claim a valuation without an independent market price', () => {
    const r = computeInvestmentScores({
      consensus: consensus(100),
      history: risingHistory(),
      liquidity: { salesPerMonth: 15 },
      // no marketPrice → no fair-value gap
    })
    expect(r.valuation).toBe('Unknown')
    expect(r.opportunity.factors.some((f) => f.key === 'fairvalue')).toBe(false)
    expect(r.risk.factors.some((f) => f.key === 'overpay')).toBe(false)
  })

  it('keeps scores within 1–100', () => {
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
  })
})
