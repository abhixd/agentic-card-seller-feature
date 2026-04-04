import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { saveToInventory, listInventory } from '@/lib/inventory/inventoryService'

const SaveSchema = z.object({
  catalogId:       z.string().uuid(),
  analysisId:      z.string().uuid().nullable().default(null),
  acquisitionCost: z.number().min(0).default(0),
  notes:           z.string().optional(),
})

/**
 * Extract the best available TCGPlayer market price from a card's metadata_json.
 *
 * Scans ALL bands and picks the HIGHEST market price found.
 * Falls back to highest mid price only when no market data exists at all.
 *
 * Why highest? When defaulting acquisition cost for inventory P&L, we want
 * the most valuable variant's price (e.g. 1st-edition holo at $150, not
 * unlimited normal at $0.50). The user can always adjust if they have a
 * different variant.
 */
function getBestMarketPrice(metadata: any): number | null {
  const prices = metadata?.tcgplayer?.prices
  if (!prices || typeof prices !== 'object') return null

  let bestMarket: number | null = null
  let bestMid:    number | null = null

  for (const band of Object.values(prices) as any[]) {
    const m   = typeof band?.market === 'number' && band.market > 0 ? band.market : null
    const mid = typeof band?.mid    === 'number' && band.mid    > 0 ? band.mid    : null
    if (m   != null && (bestMarket == null || m   > bestMarket)) bestMarket = m
    if (mid != null && (bestMid    == null || mid > bestMid))    bestMid    = mid
  }

  return bestMarket ?? bestMid ?? null
}

// POST /api/inventory — save card to inventory
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = SaveSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  let { acquisitionCost } = parsed.data

  // When no acquisition cost was provided (default 0), fall back to the card's
  // current TCGPlayer market price so P&L metrics are meaningful from day one.
  // The user can always update the cost later if they know what they actually paid.
  if (acquisitionCost === 0) {
    const { data: catalogCard } = await supabase
      .from('card_catalog_items')
      .select('metadata_json')
      .eq('catalog_id', parsed.data.catalogId)
      .maybeSingle()

    const marketPrice = getBestMarketPrice(catalogCard?.metadata_json)
    if (marketPrice && marketPrice > 0) {
      acquisitionCost = marketPrice
    }
  }

  const { item, error } = await saveToInventory(supabase, user.id, {
    ...parsed.data,
    acquisitionCost,
  })
  if (error || !item) {
    return NextResponse.json({ error: error ?? 'Save failed' }, { status: 500 })
  }
  return NextResponse.json(item, { status: 201 })
}

// GET /api/inventory — list all items for authenticated user
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { items, error } = await listInventory(supabase, user.id)
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ items, count: items.length })
}
