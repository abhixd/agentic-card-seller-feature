import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { calculateGradingScenarios } from '@/lib/engines/gradingRoi'
import type {
  FullAnalysisResponse,
  CompsSnapshot,
  ComparableSale,
  AnalysisAssumptions,
  CardSummary,
  RecommendationOutput,
  ConditionRatings,
} from '@/types/analysis'

interface Props {
  params: Promise<{ analysisId: string }>
}

export async function GET(_request: NextRequest, { params }: Props) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { analysisId } = await params

  // Fetch analysis row — scoped to authenticated user
  const { data: row, error: rowError } = await supabase
    .from('card_analyses')
    .select('*')
    .eq('analysis_id', analysisId)
    .eq('user_id', user.id)
    .single()

  if (rowError || !row) {
    return NextResponse.json({ error: 'Analysis not found' }, { status: 404 })
  }

  // Fetch card metadata
  const { data: card, error: cardError } = await supabase
    .from('card_catalog_items')
    .select('card_name, franchise_or_brand, set_name, year, card_number, variant, category')
    .eq('catalog_id', row.catalog_id)
    .single()

  if (cardError || !card) {
    return NextResponse.json({ error: 'Card not found' }, { status: 404 })
  }

  // Fetch comparable sales (best-effort — may be empty for placeholder eBay key)
  const { data: compsRows } = await supabase
    .from('comparable_sales')
    .select('*')
    .eq('analysis_id', analysisId)
    .order('sold_at', { ascending: false })

  // Fetch condition assessment (optional)
  const { data: conditionRow } = await supabase
    .from('condition_assessments')
    .select('*')
    .eq('analysis_id', analysisId)
    .maybeSingle()

  const assumptions = row.assumptions_json as AnalysisAssumptions

  const comparableSales: ComparableSale[] = (compsRows ?? []).map((c) => ({
    sold_price:           c.sold_price,
    sold_at:              c.sold_at,
    grade_state:          c.grade_state,
    grade_value:          c.grade_value,
    raw_or_graded:        c.raw_or_graded,
    source_url:           c.source_url,
    title:                c.title,
    normalization_weight: c.normalization_weight,
    venue:                c.venue,
  }))

  const comps: CompsSnapshot = {
    rawEstimate:     row.estimated_market_value,
    compRangeLow:    row.comp_range_low,
    compRangeHigh:   row.comp_range_high,
    confidenceScore: row.confidence_score,
    compCount:       assumptions.compCount,
    daysOfData:      assumptions.daysOfData,
    comps:           comparableSales,
  }

  // Re-compute grading scenarios from stored assumptions (not persisted separately)
  const gradingScenarios = calculateGradingScenarios({
    rawEstimate:    row.estimated_market_value,
    conditionScore: assumptions.conditionScore,
    netProceedsRaw: assumptions.feeResult.netProceeds,
  })

  const recommendation: RecommendationOutput = {
    type:      row.recommendation_type,
    rationale: row.rationale_text,
  }

  const conditionRatings: ConditionRatings | null = conditionRow
    ? {
        corners_rating:   conditionRow.corners_rating,
        edges_rating:     conditionRow.edges_rating,
        surface_rating:   conditionRow.surface_rating,
        centering_rating: conditionRow.centering_rating,
        notes:            conditionRow.notes ?? undefined,
      }
    : null

  const cardSummary: CardSummary = {
    card_name:          card.card_name,
    franchise_or_brand: card.franchise_or_brand,
    set_name:           card.set_name,
    year:               card.year,
    card_number:        card.card_number,
    variant:            card.variant,
    category:           card.category,
  }

  const result: FullAnalysisResponse = {
    analysis_id:       analysisId,
    catalog_id:        row.catalog_id,
    card:              cardSummary,
    comps,
    fees:              assumptions.feeResult,
    grading_scenarios: gradingScenarios,
    recommendation,
    condition_score:   assumptions.conditionScore,
    condition_ratings: conditionRatings,
    assumptions,
    created_at:        row.created_at,
  }

  return NextResponse.json(result)
}
