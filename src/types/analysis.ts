// ---------------------------------------------------------------
// Analysis types — designed to be self-explanatory to the chat layer
// ---------------------------------------------------------------

export type RecommendationType =
  | 'SELL_RAW'
  | 'GRADE'
  | 'HOLD'
  | 'INSUFFICIENT_CONFIDENCE'

// ---------------------------------------------------------------
// Condition input
// ---------------------------------------------------------------

export interface ConditionRatings {
  corners_rating: number   // 1–5
  edges_rating: number     // 1–5
  surface_rating: number   // 1–5
  centering_rating: number // 1–5
  notes?: string
}

// ---------------------------------------------------------------
// Comps snapshot
// ---------------------------------------------------------------

export interface ComparableSale {
  sold_price: number
  sold_at: string | null
  grade_state: 'raw' | 'graded' | 'unknown'
  grade_value: string | null
  raw_or_graded: 'raw' | 'graded'
  source_url: string | null
  title: string
  normalization_weight: number
  venue: string
}

export interface CompsSnapshot {
  rawEstimate: number
  compRangeLow: number
  compRangeHigh: number
  confidenceScore: number  // 0–1
  compCount: number
  daysOfData: number
  comps: ComparableSale[]
}

// ---------------------------------------------------------------
// Fee calculation
// ---------------------------------------------------------------

export interface FeeBreakdownItem {
  label: string
  amount: number
}

export interface FeeCalculatorResult {
  grossRevenue: number
  platformFee: number
  shippingCost: number
  acquisitionCost: number
  netProceeds: number
  roi: number | null   // % return on acquisition cost; null if no acquisition cost given
  platform: string     // human-readable platform label
  breakdown: FeeBreakdownItem[]
}

// ---------------------------------------------------------------
// Grading scenarios
// ---------------------------------------------------------------

export interface GradingScenario {
  gradeLabel: string                              // e.g. "PSA 10"
  gradedValue: number                             // estimated value at that grade
  gradingFee: number                              // PSA tier fee
  shippingToGrader: number                        // round-trip shipping
  netUpsideVsRawSell: number                      // gradedNetProceeds − rawNetProceeds
  roiPercent: number                              // % upside vs raw sell
  recommendation: 'strong' | 'marginal' | 'negative'
  tierLabel: string                               // e.g. "PSA Economy (~90 days)"
}

// ---------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------

export interface RecommendationOutput {
  type: RecommendationType
  rationale: string
}

export interface RecommendationInput {
  identificationConfidence: number   // 1.0 for manual search
  compsConfidence: number
  compCount: number
  rawEstimate: number
  netProceedsRaw: number
  conditionScore: number | null      // sum of 4 ratings (4–20), null if not entered
  bestGradingScenario: GradingScenario | null
  daysOfData: number
}

// ---------------------------------------------------------------
// Analysis assumptions snapshot (persisted in assumptions_json)
// ---------------------------------------------------------------

export interface AnalysisAssumptions {
  platform: 'ebay' | 'tcgplayer'
  shippingCost: number
  acquisitionCost: number
  ebayKeyword: string
  compCount: number
  daysOfData: number
  conditionScore: number | null
  feeResult: FeeCalculatorResult
}

// ---------------------------------------------------------------
// Full analysis — the complete response returned by POST /api/analysis
// Designed to be self-contained: the chat layer should be able to
// explain any part of this response without additional lookups.
// ---------------------------------------------------------------

export interface CardSummary {
  card_name: string
  franchise_or_brand: string
  set_name: string
  year: number | null
  card_number: string | null
  variant: string | null
  category: string
}

export interface FullAnalysisResponse {
  analysis_id: string
  catalog_id: string
  card: CardSummary
  comps: CompsSnapshot
  fees: FeeCalculatorResult
  grading_scenarios: GradingScenario[]
  recommendation: RecommendationOutput
  condition_score: number | null
  condition_ratings: ConditionRatings | null
  assumptions: AnalysisAssumptions
  created_at: string
}

// ---------------------------------------------------------------
// Request schema (validated with Zod in the route)
// ---------------------------------------------------------------

export interface AnalysisRequest {
  catalogId: string
  conditionRatings?: ConditionRatings | null
  platform?: 'ebay' | 'tcgplayer'
  shippingCost?: number
  acquisitionCost?: number
}
