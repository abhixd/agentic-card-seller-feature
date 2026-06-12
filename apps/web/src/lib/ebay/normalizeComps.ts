import type { ComparableSale, CompsSnapshot } from '@/types/analysis'

export interface RawEbayComp {
  title: string
  soldPrice: number
  soldAt: Date | null
  sourceUrl: string
}

// ── Grade detection ──────────────────────────────────────────────────────────

function detectGradeState(title: string): Pick<ComparableSale, 'grade_state' | 'grade_value' | 'raw_or_graded'> {
  const psaMatch  = title.match(/PSA\s*(\d+\.?\d*)/i)
  if (psaMatch)  return { grade_state: 'graded', grade_value: `PSA ${psaMatch[1]}`,  raw_or_graded: 'graded' }

  const bgsMatch  = title.match(/BGS\s*(\d+\.?\d*)/i)
  if (bgsMatch)  return { grade_state: 'graded', grade_value: `BGS ${bgsMatch[1]}`,  raw_or_graded: 'graded' }

  const sgcMatch  = title.match(/SGC\s*(\d+)/i)
  if (sgcMatch)  return { grade_state: 'graded', grade_value: `SGC ${sgcMatch[1]}`,  raw_or_graded: 'graded' }

  const cgcMatch  = title.match(/CGC\s*(\d+\.?\d*)/i)
  if (cgcMatch)  return { grade_state: 'graded', grade_value: `CGC ${cgcMatch[1]}`,  raw_or_graded: 'graded' }

  const t = title.toUpperCase()
  if (t.includes(' GRADED') || t.includes('SLAB')) {
    return { grade_state: 'graded', grade_value: null, raw_or_graded: 'graded' }
  }

  return { grade_state: 'raw', grade_value: null, raw_or_graded: 'raw' }
}

// ── Recency weight ────────────────────────────────────────────────────────────

function recencyWeight(soldAt: Date | null): number {
  if (!soldAt) return 0.3
  const daysAgo = (Date.now() - soldAt.getTime()) / (1000 * 60 * 60 * 24)
  if (daysAgo <= 7)  return 1.0
  if (daysAgo <= 30) return 0.8
  if (daysAgo <= 90) return 0.5
  return 0.2
}

// ── IQR outlier removal ───────────────────────────────────────────────────────

function removeOutliers(prices: number[]): number[] {
  if (prices.length < 4) return prices
  const sorted = [...prices].sort((a, b) => a - b)
  const q1 = sorted[Math.floor(sorted.length * 0.25)]
  const q3 = sorted[Math.floor(sorted.length * 0.75)]
  const iqr = q3 - q1
  return prices.filter((p) => p >= q1 - 1.5 * iqr && p <= q3 + 1.5 * iqr)
}

// ── Weighted median ───────────────────────────────────────────────────────────

function weightedMedian(values: number[], weights: number[]): number {
  if (values.length === 0) return 0
  const pairs = values.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v)
  const total = pairs.reduce((s, p) => s + p.w, 0)
  let cum = 0
  for (const p of pairs) {
    cum += p.w
    if (cum >= total / 2) return p.v
  }
  return pairs[pairs.length - 1].v
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1)
  return sorted[idx]
}

// ── Main normalizer ───────────────────────────────────────────────────────────

export function normalizeComps(rawComps: RawEbayComp[]): CompsSnapshot {
  if (rawComps.length === 0) {
    return {
      rawEstimate: 0, compRangeLow: 0, compRangeHigh: 0,
      confidenceScore: 0.1, compCount: 0, daysOfData: 0, comps: [],
    }
  }

  const allComps: ComparableSale[] = rawComps.map((raw) => ({
    sold_price:           raw.soldPrice,
    sold_at:              raw.soldAt?.toISOString() ?? null,
    ...detectGradeState(raw.title),
    source_url:           raw.sourceUrl,
    normalization_weight: recencyWeight(raw.soldAt),
    venue:                'ebay',
    title:                raw.title,
  }))

  // Prefer raw-only comps for the estimate; fall back to all comps if too few
  const rawOnly    = allComps.filter((c) => c.raw_or_graded === 'raw')
  const working    = rawOnly.length >= 3 ? rawOnly : allComps

  const prices         = working.map((c) => c.sold_price)
  const filtered       = removeOutliers(prices)
  const filteredComps  = working.filter((c) => filtered.includes(c.sold_price))
  const weights        = filteredComps.map((c) => c.normalization_weight)
  const sortedFiltered = [...filtered].sort((a, b) => a - b)

  const rawEstimate   = weightedMedian(filtered, weights)
  const compRangeLow  = percentile(sortedFiltered, 10)
  const compRangeHigh = percentile(sortedFiltered, 90)

  const validDates = working.filter((c) => c.sold_at).map((c) => new Date(c.sold_at!).getTime())
  const oldestMs   = validDates.length > 0 ? Math.min(...validDates) : Date.now()
  const daysOfData = Math.round((Date.now() - oldestMs) / (1000 * 60 * 60 * 24))

  const recentCount = working.filter((c) => {
    if (!c.sold_at) return false
    return (Date.now() - new Date(c.sold_at).getTime()) / (1000 * 60 * 60 * 24) <= 30
  }).length

  const confidenceScore =
    recentCount >= 10  ? 0.9
    : recentCount >= 5 ? 0.7
    : working.length >= 5 ? 0.7
    : working.length >= 3 ? 0.5
    : working.length >= 1 ? 0.3
    : 0.1

  return {
    rawEstimate:    Math.round(rawEstimate * 100) / 100,
    compRangeLow:   Math.round(compRangeLow * 100) / 100,
    compRangeHigh:  Math.round(compRangeHigh * 100) / 100,
    confidenceScore,
    compCount:      working.length,
    daysOfData,
    comps:          allComps,
  }
}
