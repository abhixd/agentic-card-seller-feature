import type { SupabaseClient } from '@supabase/supabase-js'
import type { ListingDraft, ListingDraftInput } from '@/types/listing'
import type { CardSummary, AnalysisAssumptions } from '@/types/analysis'

// ---------------------------------------------------------------------------
// Pure generation functions — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Build a listing title from canonical card metadata.
 * Stays within eBay's 80-character title limit.
 */
export function generateTitle(card: CardSummary): string {
  const parts: string[] = []

  if (card.year)                parts.push(String(card.year))
  parts.push(card.franchise_or_brand)
  parts.push(card.card_name)
  if (card.set_name)            parts.push(card.set_name)
  if (card.card_number)         parts.push(`#${card.card_number}`)
  if (card.variant)             parts.push(card.variant)
  parts.push('Raw')

  const full = parts.join(' ')
  if (full.length <= 80) return full

  // First fallback: drop set_name
  const noSet = [
    card.year ? String(card.year) : null,
    card.franchise_or_brand,
    card.card_name,
    card.card_number ? `#${card.card_number}` : null,
    card.variant,
    'Raw',
  ].filter(Boolean).join(' ')

  if (noSet.length <= 80) return noSet

  // Final fallback: hard truncate
  return full.slice(0, 77) + '...'
}

/**
 * Round a price to the nearest `.99` — a standard retail pricing convention.
 * e.g. 120 → 119.99, 24.3 → 23.99
 */
export function toNinetyNinePrice(value: number): number {
  return Math.max(0.99, Math.ceil(value) - 0.01)
}

/**
 * Build a copy-ready listing description from card data and market context.
 */
export function generateDescription(input: ListingDraftInput): string {
  const {
    card,
    conditionScore,
    estimatedMarketValue,
    compRangeLow,
    compRangeHigh,
    notes,
  } = input

  const lines: string[] = []

  // ── Card Details ─────────────────────────────────────────────
  lines.push('CARD DETAILS')
  lines.push('------------')
  lines.push(`Card Name: ${card.card_name}`)
  if (card.franchise_or_brand) lines.push(`Brand / Franchise: ${card.franchise_or_brand}`)
  if (card.set_name)  lines.push(`Set: ${card.set_name}`)
  if (card.year)      lines.push(`Year: ${card.year}`)
  if (card.card_number) lines.push(`Card Number: #${card.card_number}`)
  if (card.variant)   lines.push(`Variant: ${card.variant}`)
  lines.push('Condition: Raw / Ungraded')
  if (conditionScore !== null) {
    lines.push(`Condition Score: ${conditionScore}/20 (rated on corners, edges, surface, centering)`)
  }
  lines.push('')

  // ── Pricing ──────────────────────────────────────────────────
  lines.push('PRICING & MARKET DATA')
  lines.push('---------------------')
  if (estimatedMarketValue !== null) {
    lines.push(`Estimated Market Value: $${estimatedMarketValue.toFixed(2)}`)
  }
  if (compRangeLow !== null && compRangeHigh !== null) {
    lines.push(`Recent Sold Comp Range: $${compRangeLow.toFixed(2)} – $${compRangeHigh.toFixed(2)}`)
  }
  lines.push('')

  // ── Shipping ─────────────────────────────────────────────────
  lines.push('SHIPPING')
  lines.push('--------')
  lines.push('Card ships securely in a penny sleeve, rigid top loader, and bubble mailer.')
  lines.push('Ships within 1 business day. Tracking number provided.')
  lines.push('')

  // ── Seller Notes ─────────────────────────────────────────────
  if (notes) {
    lines.push('SELLER NOTES')
    lines.push('------------')
    lines.push(notes)
    lines.push('')
  }

  // ── Footer ───────────────────────────────────────────────────
  lines.push('Questions? Message me before purchasing.')

  return lines.join('\n')
}

/**
 * Generate a complete ListingDraft from structured input — pure, no DB.
 */
export function buildListingDraft(
  input: ListingDraftInput,
  itemId: string | null = null,
  analysisId: string | null = null
): ListingDraft {
  const title         = generateTitle(input.card)
  const description   = generateDescription(input)
  const suggestedPrice =
    input.estimatedMarketValue !== null
      ? toNinetyNinePrice(input.estimatedMarketValue)
      : null

  return {
    itemId,
    analysisId,
    card:           input.card,
    title,
    titleCharCount: title.length,
    description,
    suggestedPrice,
    compRangeLow:   input.compRangeLow,
    compRangeHigh:  input.compRangeHigh,
    netProceeds:    input.netProceeds,
    platform:       input.platform,
    generatedAt:    new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// DB-backed draft generation — used by the API route
// ---------------------------------------------------------------------------

export async function generateDraftForItem(
  supabase: SupabaseClient,
  userId: string,
  itemId: string
): Promise<{ draft: ListingDraft | null; error: string | null }> {
  const { data, error } = await supabase
    .from('inventory_items')
    .select(`
      item_id,
      catalog_id,
      analysis_id,
      notes,
      acquisition_cost,
      card_catalog_items (
        card_name,
        franchise_or_brand,
        set_name,
        year,
        card_number,
        variant,
        category
      ),
      card_analyses (
        estimated_market_value,
        comp_range_low,
        comp_range_high,
        assumptions_json
      )
    `)
    .eq('item_id', itemId)
    .eq('user_id', userId)
    .single()

  if (error || !data) {
    return { draft: null, error: error?.message ?? 'Item not found.' }
  }

  const row       = data as any
  const catalog   = row.card_catalog_items
  const analysis  = row.card_analyses

  if (!catalog) {
    return { draft: null, error: 'Card metadata not found.' }
  }

  const card: CardSummary = {
    card_name:          catalog.card_name,
    franchise_or_brand: catalog.franchise_or_brand,
    set_name:           catalog.set_name,
    year:               catalog.year,
    card_number:        catalog.card_number,
    variant:            catalog.variant,
    category:           catalog.category,
  }

  const assumptions: AnalysisAssumptions | null = analysis?.assumptions_json ?? null
  const conditionScore   = assumptions?.conditionScore ?? null
  const netProceeds      = assumptions?.feeResult?.netProceeds ?? null
  const platform         = (assumptions?.platform ?? 'ebay') as 'ebay' | 'tcgplayer'

  const input: ListingDraftInput = {
    card,
    conditionScore,
    estimatedMarketValue: analysis?.estimated_market_value ?? null,
    compRangeLow:         analysis?.comp_range_low  ?? null,
    compRangeHigh:        analysis?.comp_range_high ?? null,
    netProceeds,
    notes:                row.notes ?? null,
    platform,
  }

  const draft = buildListingDraft(input, row.item_id, row.analysis_id)
  return { draft, error: null }
}
