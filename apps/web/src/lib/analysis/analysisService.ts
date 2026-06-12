import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  AnalysisRequest,
  FullAnalysisResponse,
  ConditionRatings,
  AnalysisAssumptions,
  CardSummary,
} from '@/types/analysis'
import { getCatalogItem } from '@/lib/catalog/searchService'
import { buildKeyword, fetchEbayComps } from '@/lib/ebay/findingApi'
import { normalizeComps } from '@/lib/ebay/normalizeComps'
import { calculateFees } from '@/lib/engines/feeCalculator'
import { calculateGradingScenarios } from '@/lib/engines/gradingRoi'
import { generateRecommendation } from '@/lib/engines/recommendation'

export interface RunAnalysisResult {
  analysis: FullAnalysisResponse | null
  error: string | null
}

/**
 * Run a full deterministic analysis for a catalog card.
 *
 * Steps:
 *   1. Fetch card metadata from catalog
 *   2. Fetch eBay comps → normalise
 *   3. Calculate fees
 *   4. Calculate grading scenarios
 *   5. Generate recommendation
 *   6. Persist to DB (card_analyses, comparable_sales, condition_assessments)
 *   7. Return FullAnalysisResponse
 */
export async function runAnalysis(
  supabase: SupabaseClient,
  userId: string,
  request: AnalysisRequest
): Promise<RunAnalysisResult> {
  const {
    catalogId,
    conditionRatings = null,
    platform = 'ebay',
    shippingCost = 4.0,
    acquisitionCost = 0,
    edition = null,
  } = request

  // ── 1. Fetch card from catalog ───────────────────────────────────────────
  const { card, error: catalogError } = await getCatalogItem(supabase, catalogId)
  if (catalogError || !card) {
    return { analysis: null, error: catalogError ?? 'Card not found in catalog.' }
  }

  const cardSummary: CardSummary = {
    card_name:         card.card_name,
    franchise_or_brand: card.franchise_or_brand,
    set_name:          card.set_name,
    year:              card.year,
    card_number:       card.card_number,
    variant:           card.variant,
    category:          card.category,
  }

  // ── 2. Fetch & normalise comps ───────────────────────────────────────────
  // Pass edition so eBay keyword includes "1st Edition" or "Reverse Holo" qualifiers
  const keyword    = buildKeyword(card, 'en', edition ?? undefined)
  const { comps: rawComps } = await fetchEbayComps(keyword)
  const comps               = normalizeComps(rawComps)

  // ── 3. Fee calculation ───────────────────────────────────────────────────
  const fees = calculateFees({
    salePrice:       comps.rawEstimate,
    platform,
    shippingCost,
    acquisitionCost,
  })

  // ── 4. Grading scenarios ─────────────────────────────────────────────────
  const conditionScore = conditionRatings
    ? conditionRatings.corners_rating +
      conditionRatings.edges_rating +
      conditionRatings.surface_rating +
      conditionRatings.centering_rating
    : null

  const gradingScenarios = calculateGradingScenarios({
    rawEstimate:    comps.rawEstimate,
    conditionScore,
    netProceedsRaw: fees.netProceeds,
  })

  const bestGradingScenario =
    gradingScenarios.find((s) => s.recommendation === 'strong') ??
    gradingScenarios[0] ?? null

  // ── 5. Recommendation ────────────────────────────────────────────────────
  const recommendation = generateRecommendation({
    identificationConfidence: 1.0,   // manual search → always 1.0
    compsConfidence:          comps.confidenceScore,
    compCount:                comps.compCount,
    rawEstimate:              comps.rawEstimate,
    netProceedsRaw:           fees.netProceeds,
    conditionScore,
    bestGradingScenario,
    daysOfData:               comps.daysOfData,
  })

  // ── 6. Persist ───────────────────────────────────────────────────────────
  const assumptions: AnalysisAssumptions = {
    platform,
    shippingCost,
    acquisitionCost,
    ebayKeyword:   keyword,
    compCount:     comps.compCount,
    daysOfData:    comps.daysOfData,
    conditionScore,
    feeResult:     fees,
  }

  const { data: analysisRow, error: insertError } = await supabase
    .from('card_analyses')
    .insert({
      user_id:                userId,
      catalog_id:             catalogId,
      estimated_market_value: comps.rawEstimate,
      comp_range_low:         comps.compRangeLow,
      comp_range_high:        comps.compRangeHigh,
      confidence_score:       comps.confidenceScore,
      recommendation_type:    recommendation.type,
      rationale_text:         recommendation.rationale,
      assumptions_json:       assumptions,
    })
    .select('analysis_id, created_at')
    .single()

  if (insertError || !analysisRow) {
    return { analysis: null, error: insertError?.message ?? 'Failed to save analysis.' }
  }

  const analysisId = analysisRow.analysis_id as string
  const createdAt  = analysisRow.created_at as string

  // Persist comps (best-effort — don't fail the response if this errors)
  if (comps.comps.length > 0) {
    await supabase.from('comparable_sales').insert(
      comps.comps.map((c) => ({
        analysis_id:          analysisId,
        catalog_id:           catalogId,
        venue:                c.venue,
        sold_price:           c.sold_price,
        sold_at:              c.sold_at,
        grade_state:          c.grade_state,
        grade_value:          c.grade_value,
        raw_or_graded:        c.raw_or_graded,
        source_url:           c.source_url,
        title:                c.title,
        normalization_weight: c.normalization_weight,
      }))
    )
  }

  // Persist condition assessment
  if (conditionRatings) {
    await supabase.from('condition_assessments').insert({
      analysis_id:     analysisId,
      corners_rating:  conditionRatings.corners_rating,
      edges_rating:    conditionRatings.edges_rating,
      surface_rating:  conditionRatings.surface_rating,
      centering_rating: conditionRatings.centering_rating,
      notes:           conditionRatings.notes ?? null,
    })
  }

  // ── 7. Return FullAnalysisResponse ──────────────────────────────────────
  const result: FullAnalysisResponse = {
    analysis_id:       analysisId,
    catalog_id:        catalogId,
    card:              cardSummary,
    comps,
    fees,
    grading_scenarios: gradingScenarios,
    recommendation,
    condition_score:   conditionScore,
    condition_ratings: conditionRatings ?? null,
    assumptions,
    created_at:        createdAt,
  }

  return { analysis: result, error: null }
}
