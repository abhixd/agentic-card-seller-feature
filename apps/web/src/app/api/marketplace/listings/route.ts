import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// ── Helpers ───────────────────────────────────────────────────────────────────

function bestMarketPrice(metadataJson: Record<string, unknown> | null): number | null {
  if (!metadataJson) return null
  const prices = (metadataJson as { tcgplayer?: { prices?: Record<string, { market?: number; mid?: number }> } })
    ?.tcgplayer?.prices
  if (!prices) return null

  let best: number | null = null
  for (const band of Object.values(prices)) {
    if (band?.market && band.market > 0) {
      if (best === null || band.market > best) best = band.market
    }
  }
  if (best !== null) return best

  for (const band of Object.values(prices)) {
    if (band?.mid && band.mid > 0) {
      if (best === null || band.mid > best) best = band.mid
    }
  }
  return best
}

// ── GET /api/marketplace/listings ────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { searchParams } = new URL(req.url)

  const q        = searchParams.get('q') ?? ''
  const condition = searchParams.get('condition') ?? ''
  const minPrice = searchParams.get('minPrice') ? Number(searchParams.get('minPrice')) : null
  const maxPrice = searchParams.get('maxPrice') ? Number(searchParams.get('maxPrice')) : null
  const sort     = searchParams.get('sort') ?? 'newest'
  const page     = Number(searchParams.get('page') ?? '1')
  const perPage  = 24

  let query = supabase
    .from('marketplace_listings')
    .select(`
      id, seller_id, catalog_id, title, condition, grade,
      asking_price, ai_market_price, price_delta_pct,
      description, image_urls, accepts_trades, status, created_at,
      card_catalog_items (
        catalog_id, card_name, set_name, card_number,
        canonical_image_url, metadata_json
      )
    `, { count: 'exact' })
    .eq('status', 'active')

  if (q) {
    query = query.ilike('title', `%${q}%`)
  }

  if (condition && condition !== 'All') {
    if (condition === 'Graded') {
      query = query.not('grade', 'is', null)
    } else {
      query = query.eq('condition', condition)
    }
  }

  if (minPrice !== null) query = query.gte('asking_price', minPrice)
  if (maxPrice !== null) query = query.lte('asking_price', maxPrice)

  switch (sort) {
    case 'price_asc':
      query = query.order('asking_price', { ascending: true })
      break
    case 'price_desc':
      query = query.order('asking_price', { ascending: false })
      break
    case 'deal':
      query = query.order('price_delta_pct', { ascending: true })
      break
    default:
      query = query.order('created_at', { ascending: false })
  }

  const from = (page - 1) * perPage
  query = query.range(from, from + perPage - 1)

  const { data, error, count } = await query

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Enrich listings with seller profile username
  const sellerIds = [...new Set((data ?? []).map(l => l.seller_id))]
  const profileMap: Record<string, string> = {}
  if (sellerIds.length > 0) {
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('user_id, username, email')
      .in('user_id', sellerIds)
    if (profiles) {
      for (const p of profiles) {
        profileMap[p.user_id] = p.username ?? (p.email ? p.email.split('@')[0] : 'Anonymous')
      }
    }
  }

  const listings = (data ?? []).map(l => ({
    ...l,
    seller_username: profileMap[l.seller_id] ?? 'Anonymous',
  }))

  return NextResponse.json({ listings, total: count ?? 0, page, perPage })
}

// ── POST /api/marketplace/listings ───────────────────────────────────────────

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { catalog_id, condition, asking_price, description, accepts_trades, image_urls } = body

  if (!catalog_id || !condition || asking_price == null) {
    return NextResponse.json({ error: 'catalog_id, condition, and asking_price are required' }, { status: 400 })
  }

  // Fetch card for title + market price
  const { data: card, error: cardError } = await supabase
    .from('card_catalog_items')
    .select('card_name, set_name, metadata_json')
    .eq('catalog_id', catalog_id)
    .single()

  if (cardError || !card) {
    return NextResponse.json({ error: 'Card not found in catalog' }, { status: 404 })
  }

  const aiMarketPrice = bestMarketPrice(card.metadata_json as Record<string, unknown>)
  const priceDeltaPct = aiMarketPrice
    ? Math.round(((asking_price - aiMarketPrice) / aiMarketPrice) * 1000) / 10
    : null

  const title = `${card.card_name} ${condition}`

  const { data, error } = await supabase
    .from('marketplace_listings')
    .insert({
      seller_id:       user.id,
      catalog_id,
      title,
      condition,
      asking_price,
      ai_market_price: aiMarketPrice,
      price_delta_pct: priceDeltaPct,
      description:     description ?? null,
      image_urls:      image_urls ?? [],
      accepts_trades:  accepts_trades ?? false,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
