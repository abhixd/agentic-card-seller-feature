// ---------------------------------------------------------------------------
// Market Consensus Price — the PRD's pillar #1.
//
// The app already ingests prices from several sources (eBay sold comps,
// TCGplayer, PriceCharting, JustTCG) but never *fuses* them into one trusted
// number. This module does that fusion: a weighted consensus that respects
//   • whether the data point is a real completed SALE vs a guide/asking price
//   • how RECENT it is (continuous exponential decay)
//   • how much VOLUME backs it
//   • how RELIABLE the source is
// and reports a range, a confidence level, a per-source breakdown, and the
// outliers it rejected — split by version (raw / graded / sealed).
//
// Pure & deterministic: pass `now` to make it testable. Mirrors the robust
// statistics already used in lib/ebay/normalizeComps.ts, generalised across
// sources.
// ---------------------------------------------------------------------------

import type { CompsSnapshot } from '@/types/analysis'

export type PriceVersion = 'raw' | 'graded' | 'sealed'

/** A real completed sale is worth far more than an asking price or a guide value. */
export type PriceSourceKind = 'sold' | 'guide' | 'listing'

export interface PriceObservation {
  /** 'ebay' | 'tcgplayer' | 'pricecharting' | 'justtcg' | … */
  source: string
  kind: PriceSourceKind
  price: number
  /** ISO timestamp of the sale/quote; undated points are de-weighted, not dropped. */
  soldAt?: string | null
  /** number of underlying sales this observation summarises (1 if a single comp). */
  volume?: number
  version?: PriceVersion
  gradeLabel?: string | null
  /** optional pre-computed weight (e.g. ComparableSale.normalization_weight). */
  preWeight?: number
  url?: string | null
  title?: string
}

export interface ConsensusSourceContribution {
  source: string
  /** weighted-median price contributed by this source */
  price: number
  /** share of total consensus weight, 0..1 */
  weight: number
  /** inlier observation count from this source */
  n: number
}

export type ConfidenceLevel = 'low' | 'medium' | 'high'

export interface ConsensusPrice {
  version: PriceVersion
  /** the headline number */
  price: number
  range: { low: number; high: number }
  confidence: ConfidenceLevel
  /** 0..1 continuous score behind `confidence` */
  confidenceScore: number
  sources: ConsensusSourceContribution[]
  outliers: PriceObservation[]
  /** inlier sample size */
  sampleSize: number
  asOf: string
}

// ── Tunable model constants ────────────────────────────────────────────────

/** How much to trust each source. Real completed-sale venues rank highest. */
const SOURCE_RELIABILITY: Record<string, number> = {
  ebay: 1.0,
  pricecharting: 0.85,
  tcgplayer: 0.7,
  justtcg: 0.6,
}
const DEFAULT_SOURCE_RELIABILITY = 0.5

/** Completed sales dominate; guide values count partially; asking prices least. */
const KIND_WEIGHT: Record<PriceSourceKind, number> = { sold: 1.0, guide: 0.6, listing: 0.35 }

/** Recency half-life in days (a 30-day-old sale carries half the weight of a fresh one). */
const RECENCY_HALF_LIFE_DAYS = 30
const UNDATED_RECENCY_WEIGHT = 0.2

/** MAD outlier threshold (modified z-score). 3.5 is the conventional cutoff. */
const OUTLIER_Z = 3.5

const DAY_MS = 1000 * 60 * 60 * 24

// ── Small robust-stats helpers ─────────────────────────────────────────────

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function weightedMedian(values: number[], weights: number[]): number {
  if (values.length === 0) return 0
  const pairs = values.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v)
  const total = pairs.reduce((s, p) => s + p.w, 0)
  if (total <= 0) return median(values)
  let cum = 0
  for (const p of pairs) {
    cum += p.w
    if (cum >= total / 2) return p.v
  }
  return pairs[pairs.length - 1].v
}

/** Weighted percentile (p in 0..1) over (value, weight) pairs. */
function weightedPercentile(values: number[], weights: number[], p: number): number {
  if (values.length === 0) return 0
  const pairs = values.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v)
  const total = pairs.reduce((s, x) => s + x.w, 0)
  if (total <= 0) return pairs[Math.floor((pairs.length - 1) * p)].v
  const target = total * p
  let cum = 0
  for (const x of pairs) {
    cum += x.w
    if (cum >= target) return x.v
  }
  return pairs[pairs.length - 1].v
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ── Per-observation weight ─────────────────────────────────────────────────

function recencyWeight(soldAt: string | null | undefined, now: number): number {
  if (!soldAt) return UNDATED_RECENCY_WEIGHT
  const t = Date.parse(soldAt)
  if (Number.isNaN(t)) return UNDATED_RECENCY_WEIGHT
  const daysAgo = Math.max(0, (now - t) / DAY_MS)
  // exponential decay with the configured half-life
  return Math.pow(0.5, daysAgo / RECENCY_HALF_LIFE_DAYS)
}

function volumeWeight(volume: number | undefined): number {
  const v = volume && volume > 0 ? volume : 1
  // diminishing returns; a 9-sale point is ~3x a 1-sale point, capped at 4x
  return Math.min(4, Math.sqrt(v))
}

function observationWeight(o: PriceObservation, now: number): number {
  const reliability = SOURCE_RELIABILITY[o.source] ?? DEFAULT_SOURCE_RELIABILITY
  const kind = KIND_WEIGHT[o.kind] ?? 0.5
  const recency = recencyWeight(o.soldAt, now)
  const vol = volumeWeight(o.volume)
  const pre = o.preWeight != null && o.preWeight > 0 ? o.preWeight : 1
  return reliability * kind * recency * vol * pre
}

// ── Outlier rejection (MAD / modified z-score) ─────────────────────────────

function splitOutliers(obs: PriceObservation[]): { inliers: PriceObservation[]; outliers: PriceObservation[] } {
  if (obs.length < 4) return { inliers: obs, outliers: [] }
  const prices = obs.map((o) => o.price)
  const med = median(prices)
  const mad = median(prices.map((p) => Math.abs(p - med)))
  if (mad === 0) return { inliers: obs, outliers: [] }
  const inliers: PriceObservation[] = []
  const outliers: PriceObservation[] = []
  for (const o of obs) {
    const z = (0.6745 * Math.abs(o.price - med)) / mad
    ;(z > OUTLIER_Z ? outliers : inliers).push(o)
  }
  // never reject so much that we're left with too little signal
  if (inliers.length < 3) return { inliers: obs, outliers: [] }
  return { inliers, outliers }
}

// ── Confidence ─────────────────────────────────────────────────────────────

function computeConfidence(args: {
  sampleSize: number
  distinctSources: number
  recentWeightShare: number   // share of weight from sold points < 30d old
  dispersion: number          // (high-low)/price
}): { score: number; level: ConfidenceLevel } {
  const { sampleSize, distinctSources, recentWeightShare, dispersion } = args
  const sizeScore = Math.min(1, sampleSize / 10)              // 10+ points → full
  const sourceScore = Math.min(1, (distinctSources - 1) / 2)  // 3+ sources → full
  const recencyScore = Math.min(1, recentWeightShare / 0.5)   // half the weight recent → full
  const tightnessScore = Math.max(0, 1 - dispersion / 0.6)    // ±30% band → 0
  const score =
    0.35 * sizeScore + 0.25 * sourceScore + 0.2 * recencyScore + 0.2 * tightnessScore
  const level: ConfidenceLevel = score >= 0.7 ? 'high' : score >= 0.45 ? 'medium' : 'low'
  return { score: round2(score), level }
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface ConsensusOptions {
  version?: PriceVersion
  now?: number
}

/**
 * Fuse a set of price observations into one Market Consensus Price.
 * Pass observations for a single version (raw/graded/sealed) — use
 * `groupByVersion` first if you have mixed input.
 */
export function computeConsensus(
  observations: PriceObservation[],
  opts: ConsensusOptions = {},
): ConsensusPrice {
  const now = opts.now ?? Date.now()
  const version = opts.version ?? observations[0]?.version ?? 'raw'
  const asOf = new Date(now).toISOString()

  const valid = observations.filter((o) => Number.isFinite(o.price) && o.price > 0)
  if (valid.length === 0) {
    return {
      version, price: 0, range: { low: 0, high: 0 },
      confidence: 'low', confidenceScore: 0, sources: [], outliers: [], sampleSize: 0, asOf,
    }
  }

  const { inliers, outliers } = splitOutliers(valid)

  const prices = inliers.map((o) => o.price)
  const weights = inliers.map((o) => observationWeight(o, now))
  const totalWeight = weights.reduce((s, w) => s + w, 0)

  const price = round2(weightedMedian(prices, weights))
  const low = round2(weightedPercentile(prices, weights, 0.15))
  const high = round2(weightedPercentile(prices, weights, 0.85))

  // per-source breakdown
  const bySource = new Map<string, { prices: number[]; weights: number[] }>()
  inliers.forEach((o, i) => {
    const e = bySource.get(o.source) ?? { prices: [], weights: [] }
    e.prices.push(o.price)
    e.weights.push(weights[i])
    bySource.set(o.source, e)
  })
  const sources: ConsensusSourceContribution[] = [...bySource.entries()]
    .map(([source, e]) => ({
      source,
      price: round2(weightedMedian(e.prices, e.weights)),
      weight: totalWeight > 0 ? round2(e.weights.reduce((s, w) => s + w, 0) / totalWeight) : 0,
      n: e.prices.length,
    }))
    .sort((a, b) => b.weight - a.weight)

  // recent-weight share (sold points < 30d)
  let recentWeight = 0
  inliers.forEach((o, i) => {
    if (o.kind === 'sold' && o.soldAt) {
      const days = (now - Date.parse(o.soldAt)) / DAY_MS
      if (days >= 0 && days <= 30) recentWeight += weights[i]
    }
  })
  const recentWeightShare = totalWeight > 0 ? recentWeight / totalWeight : 0

  const dispersion = price > 0 ? (high - low) / price : 1
  const { score: confidenceScore, level: confidence } = computeConfidence({
    sampleSize: inliers.length,
    distinctSources: bySource.size,
    recentWeightShare,
    dispersion,
  })

  return {
    version,
    price,
    range: { low, high },
    confidence,
    confidenceScore,
    sources,
    outliers,
    sampleSize: inliers.length,
    asOf,
  }
}

/** Split mixed-version observations into per-version buckets. */
export function groupByVersion(observations: PriceObservation[]): Record<PriceVersion, PriceObservation[]> {
  const out: Record<PriceVersion, PriceObservation[]> = { raw: [], graded: [], sealed: [] }
  for (const o of observations) out[o.version ?? 'raw'].push(o)
  return out
}

/**
 * Adapter: turn the existing eBay `CompsSnapshot` (single-source sold comps)
 * into consensus observations. Lets us drop consensus in on top of the current
 * analysis pipeline immediately, then add TCGplayer/PriceCharting observations
 * later for true multi-source fusion.
 */
export function observationsFromComps(comps: CompsSnapshot): PriceObservation[] {
  return comps.comps.map((c) => ({
    source: c.venue || 'ebay',
    kind: 'sold' as const,
    price: c.sold_price,
    soldAt: c.sold_at,
    volume: 1,
    version: c.raw_or_graded === 'graded' ? ('graded' as const) : ('raw' as const),
    gradeLabel: c.grade_value,
    preWeight: c.normalization_weight,
    url: c.source_url,
    title: c.title,
  }))
}
