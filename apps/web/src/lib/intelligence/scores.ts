// ---------------------------------------------------------------------------
// Investment Intelligence — the PRD's pillar #2.
//
// Two headline 1–100 numbers on every card/sealed product:
//   • Opportunity Score — how attractive is this as an investment right now?
//   • Risk Score        — how risky is it to buy right now?
// plus a valuation label (Undervalued / Fairly Valued / Overheated).
//
// Every score ships with the FACTORS behind it (the PRD requires "click a
// score and see the reasoning"). Derived entirely from data the app already
// pulls — consensus price, price history, sold cadence, grading ROI, supply.
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
  /** current active listings (supply pressure) */
  activeListings?: number
  /** average days between sales */
  avgDaysBetweenSales?: number
}

export interface ScoreInputs {
  /** raw consensus price (primary fair-value anchor) */
  consensus?: ConsensusPrice | null
  /** graded consensus, if available (used only for context) */
  gradedConsensus?: ConsensusPrice | null
  /** chronological price history (oldest → newest) for momentum & volatility */
  history?: PricePoint[]
  liquidity?: LiquiditySignal
  /** current market/asking price (e.g. TCGplayer market) for the fair-value gap */
  marketPrice?: number | null
  /** best grading scenario ROI %, from engines/gradingRoi (raw→graded upside) */
  gradingUpsideRoiPercent?: number | null
  /** PSA/graded population — high pop = abundant supply = lower opportunity, higher risk */
  gradedPopulation?: number | null
  /** known/strong reprint risk for this card or set */
  reprintRisk?: boolean
  now?: number
}

export type OpportunityLabel =
  | 'Strong Opportunity' | 'Good Opportunity' | 'Neutral' | 'Weak Opportunity' | 'Poor Opportunity'
export type RiskLabel =
  | 'Very High Risk' | 'High Risk' | 'Moderate Risk' | 'Low Risk' | 'Very Low Risk'
export type ValuationLabel = 'Undervalued' | 'Fairly Valued' | 'Overheated'

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
}

export interface InvestmentScores {
  opportunity: Score<OpportunityLabel>
  risk: Score<RiskLabel>
  valuation: ValuationLabel
  valuationDetail: string
  /** true when there wasn't enough data to score confidently */
  lowData: boolean
}

const DAY_MS = 1000 * 60 * 60 * 24

// ── helpers ────────────────────────────────────────────────────────────────

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n))
const round = (n: number) => Math.round(n)

/** Combine weighted sub-scores into a single 0..100 number. */
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

// ── derived market metrics from history ─────────────────────────────────────

interface HistoryMetrics {
  momentumPct: number | null      // total % change over the window
  monthlyGrowthPct: number | null // normalised to 30 days
  volatility: number | null       // coefficient of variation of step-to-step returns
  recentSpikePct: number | null   // last-step jump, for overheating detection
}

function historyMetrics(history: PricePoint[] | undefined): HistoryMetrics {
  if (!history || history.length < 2) {
    return { momentumPct: null, monthlyGrowthPct: null, volatility: null, recentSpikePct: null }
  }
  const pts = [...history]
    .map((p) => ({ t: Date.parse(p.date), price: p.price }))
    .filter((p) => Number.isFinite(p.t) && p.price > 0)
    .sort((a, b) => a.t - b.t)
  if (pts.length < 2) {
    return { momentumPct: null, monthlyGrowthPct: null, volatility: null, recentSpikePct: null }
  }

  const first = pts[0]
  const last = pts[pts.length - 1]
  const momentumPct = ((last.price - first.price) / first.price) * 100

  const spanDays = Math.max(1, (last.t - first.t) / DAY_MS)
  const monthlyGrowthPct = (momentumPct / spanDays) * 30

  // step returns for volatility
  const returns: number[] = []
  for (let i = 1; i < pts.length; i++) {
    if (pts[i - 1].price > 0) returns.push((pts[i].price - pts[i - 1].price) / pts[i - 1].price)
  }
  const mean = returns.reduce((s, r) => s + r, 0) / (returns.length || 1)
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length || 1)
  const std = Math.sqrt(variance)
  const volatility = std // already a fraction (e.g. 0.15 = 15% typical step)

  const prev = pts[pts.length - 2]
  const recentSpikePct = prev.price > 0 ? ((last.price - prev.price) / prev.price) * 100 : null

  return { momentumPct, monthlyGrowthPct, volatility, recentSpikePct }
}

// ── main ────────────────────────────────────────────────────────────────────

export function computeInvestmentScores(inputs: ScoreInputs): InvestmentScores {
  const m = historyMetrics(inputs.history)
  const consensus = inputs.consensus ?? null
  const fairValue = consensus?.price ?? null
  const market = inputs.marketPrice ?? null
  const liq = inputs.liquidity ?? {}

  // ---- fair-value gap: how far the current market sits below/above fair value
  // negative gap (market below consensus) = undervalued = opportunity
  let fairValueGapPct: number | null = null
  if (fairValue && fairValue > 0 && market && market > 0) {
    fairValueGapPct = ((market - fairValue) / fairValue) * 100
  }

  // =========================================================================
  // OPPORTUNITY
  // =========================================================================
  const oppFactors: ScoreFactor[] = []

  if (m.momentumPct != null) {
    // -20% → 0, +30% → 100
    const s = clamp(((m.momentumPct + 20) / 50) * 100)
    oppFactors.push({
      key: 'momentum', label: 'Price momentum', score: round(s), weight: 0.22,
      detail: `${m.momentumPct >= 0 ? '+' : ''}${m.momentumPct.toFixed(1)}% over the tracked window.`,
    })
  }
  if (m.monthlyGrowthPct != null) {
    const s = clamp(((m.monthlyGrowthPct + 5) / 15) * 100) // -5%/mo → 0, +10%/mo → 100
    oppFactors.push({
      key: 'growth', label: 'Monthly growth', score: round(s), weight: 0.15,
      detail: `~${m.monthlyGrowthPct >= 0 ? '+' : ''}${m.monthlyGrowthPct.toFixed(1)}% per month.`,
    })
  }
  if (liq.salesPerMonth != null) {
    const s = clamp((liq.salesPerMonth / 30) * 100) // 30+ sales/mo → full liquidity
    oppFactors.push({
      key: 'liquidity', label: 'Sales volume / liquidity', score: round(s), weight: 0.18,
      detail: `~${liq.salesPerMonth.toFixed(0)} completed sales per month.`,
    })
  }
  if (fairValueGapPct != null) {
    // market 20% below fair value → 100; 20% above → 0
    const s = clamp(50 - fairValueGapPct * 2.5)
    oppFactors.push({
      key: 'fairvalue', label: 'Price vs fair value', score: round(s), weight: 0.2,
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
      key: 'grading', label: 'Raw → graded upside', score: round(s), weight: 0.15,
      detail: `Best grading scenario projects ${inputs.gradingUpsideRoiPercent >= 0 ? '+' : ''}${inputs.gradingUpsideRoiPercent.toFixed(0)}% vs selling raw.`,
    })
  }
  if (inputs.gradedPopulation != null) {
    const s = clamp(100 - Math.min(100, (inputs.gradedPopulation / 5000) * 100)) // scarce pop → high
    oppFactors.push({
      key: 'scarcity', label: 'Supply scarcity', score: round(s), weight: 0.1,
      detail: `${inputs.gradedPopulation.toLocaleString()} graded copies in the population.`,
    })
  }

  const opportunityScore = blend(oppFactors)

  // =========================================================================
  // RISK  (higher sub-score = riskier)
  // =========================================================================
  const riskFactors: ScoreFactor[] = []

  if (m.volatility != null) {
    const s = clamp((m.volatility / 0.3) * 100) // 30% typical step → max risk
    riskFactors.push({
      key: 'volatility', label: 'Price volatility', score: round(s), weight: 0.22,
      detail: `Typical step-to-step move of ${(m.volatility * 100).toFixed(0)}%.`,
    })
  }
  if (liq.salesPerMonth != null) {
    const s = clamp(100 - (liq.salesPerMonth / 20) * 100) // thin volume = risk
    riskFactors.push({
      key: 'thin-volume', label: 'Low sales volume', score: round(s), weight: 0.2,
      detail: `~${liq.salesPerMonth.toFixed(0)} sales/month — ${liq.salesPerMonth < 5 ? 'hard' : 'reasonable'} to exit.`,
    })
  }
  if (m.recentSpikePct != null) {
    const s = clamp(m.recentSpikePct * 3) // a sharp recent jump = overheating risk
    riskFactors.push({
      key: 'overheating', label: 'Hype / overheating', score: round(s), weight: 0.18,
      detail:
        m.recentSpikePct >= 5
          ? `Jumped ${m.recentSpikePct.toFixed(0)}% in the latest move — possible hype spike.`
          : 'No sharp recent spike.',
    })
  }
  if (fairValueGapPct != null) {
    const s = clamp(50 + fairValueGapPct * 2.5) // paying above fair value = risk
    riskFactors.push({
      key: 'overpay', label: 'Paying above fair value', score: round(s), weight: 0.15,
      detail:
        fairValueGapPct >= 1
          ? `Market is ${fairValueGapPct.toFixed(0)}% above consensus.`
          : 'Market at or below consensus.',
    })
  }
  if (inputs.gradedPopulation != null) {
    const s = clamp((inputs.gradedPopulation / 8000) * 100) // huge pop = oversupply risk
    riskFactors.push({
      key: 'population', label: 'High graded population', score: round(s), weight: 0.12,
      detail: `${inputs.gradedPopulation.toLocaleString()} graded copies already in the market.`,
    })
  }
  if (inputs.reprintRisk != null) {
    riskFactors.push({
      key: 'reprint', label: 'Reprint risk', score: inputs.reprintRisk ? 80 : 20, weight: 0.13,
      detail: inputs.reprintRisk ? 'Card/set carries known reprint risk.' : 'No notable reprint risk.',
    })
  }

  const riskScore = blend(riskFactors)

  // =========================================================================
  // VALUATION
  // =========================================================================
  let valuation: ValuationLabel = 'Fairly Valued'
  let valuationDetail = 'Market price is in line with consensus fair value.'
  if (fairValueGapPct != null) {
    if (fairValueGapPct <= -7) {
      valuation = 'Undervalued'
      valuationDetail = `Trading ${Math.abs(fairValueGapPct).toFixed(0)}% below consensus fair value.`
    } else if (fairValueGapPct >= 12 || (m.recentSpikePct ?? 0) >= 20) {
      valuation = 'Overheated'
      valuationDetail =
        fairValueGapPct >= 12
          ? `Trading ${fairValueGapPct.toFixed(0)}% above consensus fair value.`
          : `Recent ${(m.recentSpikePct ?? 0).toFixed(0)}% spike suggests overheating.`
    }
  } else if ((m.recentSpikePct ?? 0) >= 20) {
    valuation = 'Overheated'
    valuationDetail = `Recent ${(m.recentSpikePct ?? 0).toFixed(0)}% spike suggests overheating.`
  }

  const lowData =
    oppFactors.length < 3 ||
    (consensus?.confidence === 'low') ||
    (consensus?.sampleSize ?? 0) < 3

  return {
    opportunity: { score: opportunityScore, label: opportunityLabel(opportunityScore), factors: oppFactors },
    risk: { score: riskScore, label: riskLabel(riskScore), factors: riskFactors },
    valuation,
    valuationDetail,
    lowData,
  }
}
