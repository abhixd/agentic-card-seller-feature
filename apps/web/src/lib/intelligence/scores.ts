// ---------------------------------------------------------------------------
// Investment Intelligence — the PRD's pillar #2.
//
// Two headline 1–100 numbers, plus a valuation label:
//   • Opportunity Score — how attractive is this to BUY right now?
//   • Risk Score        — how risky is buying right now?
//
// Accuracy-first: a factor is only scored when its underlying data is genuinely
// reliable. We never fabricate a number from thin/derived data. When too few
// factors are supportable, the caller (UI) shows "not enough data" rather than
// a misleading score. Trimmed to the factors that actually drive making money.
//
// Pure & deterministic: pass `now` to make it testable.
// ---------------------------------------------------------------------------

import type { ConsensusPrice } from '@/lib/pricing/consensus'

export interface PricePoint {
  /** ISO date */
  date: string
  price: number
}

export interface LiquiditySignal {
  /** completed sales per month (primary liquidity signal) */
  salesPerMonth?: number
}

export interface ScoreInputs {
  /** raw consensus price (the fair-value anchor) */
  consensus?: ConsensusPrice | null
  /**
   * Chronological price history (oldest → newest) for momentum & volatility.
   * MUST be a single, currency-consistent series — never mix sources/currencies.
   */
  history?: PricePoint[]
  liquidity?: LiquiditySignal
  /**
   * An INDEPENDENT current market/asking price to compare against consensus for
   * the fair-value gap. Only pass this when it comes from a different signal than
   * the consensus itself (e.g. TCGplayer market vs an eBay-sold consensus) — otherwise
   * the gap is meaningless and must be omitted.
   */
  marketPrice?: number | null
  /** best grading scenario ROI %, from engines/gradingRoi (raw→graded upside) */
  gradingUpsideRoiPercent?: number | null
  now?: number
}

export type OpportunityLabel =
  | 'Strong Opportunity' | 'Good Opportunity' | 'Neutral' | 'Weak Opportunity' | 'Poor Opportunity'
export type RiskLabel =
  | 'Very High Risk' | 'High Risk' | 'Moderate Risk' | 'Low Risk' | 'Very Low Risk'
export type ValuationLabel = 'Undervalued' | 'Fairly Valued' | 'Overheated' | 'Unknown'

export interface ScoreFactor {
  key: string
  label: string
  /** this factor's 0..100 sub-score */
  score: number
  /** how heavily it counts toward the headline number, 0..1 */
  weight: number
  /** human-readable reasoning for the UI */
  detail: string
}

export interface Score<L extends string> {
  score: number
  label: L
  factors: ScoreFactor[]
  /** true when there wasn't enough reliable data to score this confidently */
  insufficient: boolean
}

export interface InvestmentScores {
  opportunity: Score<OpportunityLabel>
  risk: Score<RiskLabel>
  valuation: ValuationLabel
  valuationDetail: string
  /** true when the overall read is data-starved */
  lowData: boolean
}

const DAY_MS = 1000 * 60 * 60 * 24

// A score needs at least this many reliable factors to be shown as a real number.
const MIN_FACTORS = 2

// ── helpers ────────────────────────────────────────────────────────────────

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n))
const round = (n: number) => Math.round(n)

function blend(factors: ScoreFactor[]): number {
  const total = factors.reduce((s, f) => s + f.weight, 0)
  if (total <= 0) return 0
  return clamp(round(factors.reduce((s, f) => s + f.score * f.weight, 0) / total))
}

function opportunityLabel(score: number): OpportunityLabel {
  if (score >= 80) return 'Strong Opportunity'
  if (score >= 60) return 'Good Opportunity'
  if (score >= 40) return 'Neutral'
  if (score >= 20) return 'Weak Opportunity'
  return 'Poor Opportunity'
}

function riskLabel(score: number): RiskLabel {
  if (score >= 80) return 'Very High Risk'
  if (score >= 60) return 'High Risk'
  if (score >= 40) return 'Moderate Risk'
  if (score >= 20) return 'Low Risk'
  return 'Very Low Risk'
}

// ── derived market metrics from a single consistent history series ──────────

interface HistoryMetrics {
  momentumPct: number | null   // total % change over the window
  volatility: number | null    // coefficient of variation of step-to-step returns
}

function historyMetrics(history: PricePoint[] | undefined): HistoryMetrics {
  if (!history || history.length < 3) return { momentumPct: null, volatility: null }
  const pts = [...history]
    .map((p) => ({ t: Date.parse(p.date), price: p.price }))
    .filter((p) => Number.isFinite(p.t) && p.price > 0)
    .sort((a, b) => a.t - b.t)
  // Need a real series (≥3 points) for momentum/volatility to mean anything.
  if (pts.length < 3) return { momentumPct: null, volatility: null }

  const first = pts[0]
  const last = pts[pts.length - 1]
  const momentumPct = ((last.price - first.price) / first.price) * 100

  const returns: number[] = []
  for (let i = 1; i < pts.length; i++) {
    if (pts[i - 1].price > 0) returns.push((pts[i].price - pts[i - 1].price) / pts[i - 1].price)
  }
  const mean = returns.reduce((s, r) => s + r, 0) / (returns.length || 1)
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length || 1)
  const volatility = Math.sqrt(variance)

  return { momentumPct, volatility }
}

// ── main ────────────────────────────────────────────────────────────────────

export function computeInvestmentScores(inputs: ScoreInputs): InvestmentScores {
  const m = historyMetrics(inputs.history)
  const consensus = inputs.consensus ?? null
  const fairValue = consensus?.price ?? null
  const market = inputs.marketPrice ?? null

  // fair-value gap: only when we have an independent market price vs consensus.
  let fairValueGapPct: number | null = null
  if (fairValue && fairValue > 0 && market && market > 0) {
    fairValueGapPct = ((market - fairValue) / fairValue) * 100
  }

  // =========================================================================
  // OPPORTUNITY — the four signals that drive making money on the buy
  // =========================================================================
  const oppFactors: ScoreFactor[] = []

  if (m.momentumPct != null) {
    const s = clamp(((m.momentumPct + 20) / 50) * 100) // -20% → 0, +30% → 100
    oppFactors.push({
      key: 'momentum', label: 'Price trend', score: round(s), weight: 0.3,
      detail: `${m.momentumPct >= 0 ? '+' : ''}${m.momentumPct.toFixed(1)}% over the tracked window.`,
    })
  }
  if (inputs.liquidity?.salesPerMonth != null) {
    const spm = inputs.liquidity.salesPerMonth
    const s = clamp((spm / 30) * 100) // 30+ sales/mo → full liquidity
    oppFactors.push({
      key: 'liquidity', label: 'Sells easily', score: round(s), weight: 0.25,
      detail: `~${spm.toFixed(0)} completed sales per month.`,
    })
  }
  if (fairValueGapPct != null) {
    const s = clamp(50 - fairValueGapPct * 2.5) // 20% below fair value → 100; 20% above → 0
    oppFactors.push({
      key: 'fairvalue', label: 'Underpriced', score: round(s), weight: 0.3,
      detail:
        fairValueGapPct <= -1
          ? `Trading ${Math.abs(fairValueGapPct).toFixed(0)}% below consensus fair value.`
          : fairValueGapPct >= 1
            ? `Trading ${fairValueGapPct.toFixed(0)}% above consensus fair value.`
            : 'Trading near consensus fair value.',
    })
  }
  if (inputs.gradingUpsideRoiPercent != null) {
    const s = clamp((inputs.gradingUpsideRoiPercent / 150) * 100) // +150% grade ROI → full
    oppFactors.push({
      key: 'grading', label: 'Grading upside', score: round(s), weight: 0.15,
      detail: `Best grading scenario projects ${inputs.gradingUpsideRoiPercent >= 0 ? '+' : ''}${inputs.gradingUpsideRoiPercent.toFixed(0)}% vs selling raw.`,
    })
  }

  // =========================================================================
  // RISK — the three ways you lose money on the buy (higher = riskier)
  // =========================================================================
  const riskFactors: ScoreFactor[] = []

  if (m.volatility != null) {
    const s = clamp((m.volatility / 0.3) * 100) // 30% typical step → max risk
    riskFactors.push({
      key: 'volatility', label: 'Price swings', score: round(s), weight: 0.35,
      detail: `Typical move of ${(m.volatility * 100).toFixed(0)}% between data points.`,
    })
  }
  if (inputs.liquidity?.salesPerMonth != null) {
    const spm = inputs.liquidity.salesPerMonth
    const s = clamp(100 - (spm / 20) * 100) // thin volume = hard to exit
    riskFactors.push({
      key: 'thin-volume', label: 'Hard to sell', score: round(s), weight: 0.35,
      detail: `~${spm.toFixed(0)} sales/month — ${spm < 5 ? 'hard' : 'reasonable'} to exit.`,
    })
  }
  if (fairValueGapPct != null) {
    const s = clamp(50 + fairValueGapPct * 2.5) // paying above fair value = risk
    riskFactors.push({
      key: 'overpay', label: 'Overpaying', score: round(s), weight: 0.3,
      detail:
        fairValueGapPct >= 1
          ? `Market is ${fairValueGapPct.toFixed(0)}% above consensus.`
          : 'Market at or below consensus.',
    })
  }

  const oppInsufficient = oppFactors.length < MIN_FACTORS
  const riskInsufficient = riskFactors.length < MIN_FACTORS
  const opportunityScore = blend(oppFactors)
  const riskScore = blend(riskFactors)

  // =========================================================================
  // VALUATION — only claimed when we have an independent fair-value gap
  // =========================================================================
  let valuation: ValuationLabel = 'Unknown'
  let valuationDetail = 'Not enough independent sold data to judge valuation yet.'
  if (fairValueGapPct != null) {
    if (fairValueGapPct <= -7) {
      valuation = 'Undervalued'
      valuationDetail = `Trading ${Math.abs(fairValueGapPct).toFixed(0)}% below consensus fair value.`
    } else if (fairValueGapPct >= 12) {
      valuation = 'Overheated'
      valuationDetail = `Trading ${fairValueGapPct.toFixed(0)}% above consensus fair value.`
    } else {
      valuation = 'Fairly Valued'
      valuationDetail = 'Market price is in line with consensus fair value.'
    }
  }

  return {
    opportunity: {
      score: opportunityScore,
      label: opportunityLabel(opportunityScore),
      factors: oppFactors,
      insufficient: oppInsufficient,
    },
    risk: {
      score: riskScore,
      label: riskLabel(riskScore),
      factors: riskFactors,
      insufficient: riskInsufficient,
    },
    valuation,
    valuationDetail,
    lowData: oppInsufficient || riskInsufficient || (consensus?.confidence === 'low'),
  }
}
