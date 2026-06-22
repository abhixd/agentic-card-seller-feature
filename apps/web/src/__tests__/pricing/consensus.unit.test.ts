import { describe, it, expect } from 'vitest'
import {
  computeConsensus,
  groupByVersion,
  observationsFromComps,
  type PriceObservation,
} from '@/lib/pricing/consensus'
import type { CompsSnapshot } from '@/types/analysis'

const NOW = Date.parse('2026-06-22T00:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

function obs(p: Partial<PriceObservation> & { price: number }): PriceObservation {
  return { source: 'ebay', kind: 'sold', soldAt: daysAgo(5), version: 'raw', ...p }
}

describe('computeConsensus', () => {
  it('returns an empty consensus for no observations', () => {
    const c = computeConsensus([], { now: NOW })
    expect(c.price).toBe(0)
    expect(c.confidence).toBe('low')
    expect(c.sampleSize).toBe(0)
  })

  it('fuses tightly-clustered recent sales into a confident consensus', () => {
    const c = computeConsensus(
      [
        obs({ price: 118 }), obs({ price: 122 }), obs({ price: 120 }),
        obs({ price: 119, source: 'tcgplayer', kind: 'guide' }),
        obs({ price: 121, source: 'pricecharting', kind: 'guide' }),
        obs({ price: 120 }), obs({ price: 123 }), obs({ price: 117 }),
        obs({ price: 121 }), obs({ price: 120 }),
      ],
      { now: NOW },
    )
    expect(c.price).toBeGreaterThan(115)
    expect(c.price).toBeLessThan(125)
    expect(c.range.low).toBeLessThanOrEqual(c.price)
    expect(c.range.high).toBeGreaterThanOrEqual(c.price)
    expect(c.confidence).toBe('high')
    // breakdown sums (roughly) to 1 across sources
    const total = c.sources.reduce((s, x) => s + x.weight, 0)
    expect(total).toBeGreaterThan(0.95)
    expect(c.sources.map((s) => s.source)).toContain('ebay')
  })

  it('rejects a wild outlier from the headline number', () => {
    const c = computeConsensus(
      [
        obs({ price: 100 }), obs({ price: 102 }), obs({ price: 98 }),
        obs({ price: 101 }), obs({ price: 99 }), obs({ price: 100 }),
        obs({ price: 5000 }), // fat-finger / mislabelled graded slab
      ],
      { now: NOW },
    )
    expect(c.outliers.map((o) => o.price)).toContain(5000)
    expect(c.price).toBeLessThan(150)
  })

  it('weights real sold comps above guide/asking prices', () => {
    const soldHeavy = computeConsensus(
      [obs({ price: 100, kind: 'sold' }), obs({ price: 100, kind: 'sold' }), obs({ price: 200, kind: 'listing', source: 'tcgplayer' })],
      { now: NOW },
    )
    // the two sold @100 should dominate the single @200 asking price
    expect(soldHeavy.price).toBeLessThan(150)
  })

  it('decays old sales — recent data moves the number', () => {
    const recentLow = computeConsensus(
      [
        obs({ price: 80, soldAt: daysAgo(2) }), obs({ price: 82, soldAt: daysAgo(3) }),
        obs({ price: 81, soldAt: daysAgo(1) }),
        obs({ price: 130, soldAt: daysAgo(200) }), obs({ price: 132, soldAt: daysAgo(220) }),
      ],
      { now: NOW },
    )
    // fresh ~$81 sales should outweigh stale ~$131 ones
    expect(recentLow.price).toBeLessThan(100)
  })

  it('reports lower confidence for a tiny, stale, single-source sample', () => {
    const c = computeConsensus(
      [obs({ price: 100, soldAt: daysAgo(120) }), obs({ price: 140, soldAt: daysAgo(140) })],
      { now: NOW },
    )
    expect(c.confidence).toBe('low')
  })
})

describe('groupByVersion', () => {
  it('splits raw / graded / sealed', () => {
    const g = groupByVersion([
      obs({ price: 10, version: 'raw' }),
      obs({ price: 500, version: 'graded' }),
      obs({ price: 90, version: 'sealed' }),
      obs({ price: 12, version: 'raw' }),
    ])
    expect(g.raw).toHaveLength(2)
    expect(g.graded).toHaveLength(1)
    expect(g.sealed).toHaveLength(1)
  })
})

describe('observationsFromComps', () => {
  it('adapts an existing CompsSnapshot into consensus observations', () => {
    const snapshot: CompsSnapshot = {
      rawEstimate: 120, compRangeLow: 110, compRangeHigh: 130,
      confidenceScore: 0.7, compCount: 2, daysOfData: 30,
      comps: [
        { sold_price: 118, sold_at: daysAgo(5), grade_state: 'raw', grade_value: null,
          raw_or_graded: 'raw', source_url: null, title: 'Charizard', normalization_weight: 1, venue: 'ebay' },
        { sold_price: 480, sold_at: daysAgo(10), grade_state: 'graded', grade_value: 'PSA 10',
          raw_or_graded: 'graded', source_url: null, title: 'Charizard PSA 10', normalization_weight: 0.8, venue: 'ebay' },
      ],
    }
    const observations = observationsFromComps(snapshot)
    expect(observations).toHaveLength(2)
    expect(observations[0]).toMatchObject({ source: 'ebay', kind: 'sold', version: 'raw', price: 118 })
    expect(observations[1].version).toBe('graded')

    const raw = computeConsensus(groupByVersion(observations).raw, { now: NOW })
    expect(raw.price).toBe(118)
  })
})
