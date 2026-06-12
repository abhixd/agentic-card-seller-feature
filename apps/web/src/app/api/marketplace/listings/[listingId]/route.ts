import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ listingId: string }> }

// ── GET /api/marketplace/listings/[listingId] ─────────────────────────────────

export async function GET(_req: NextRequest, { params }: Params) {
  const { listingId } = await params
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('marketplace_listings')
    .select(`
      id, seller_id, catalog_id, title, condition, grade,
      asking_price, ai_market_price, price_delta_pct,
      description, image_urls, accepts_trades, status, created_at, updated_at,
      card_catalog_items (
        catalog_id, card_name, set_name, card_number,
        canonical_image_url, metadata_json
      )
    `)
    .eq('id', listingId)
    .single()

  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Fetch seller username
  let sellerUsername = 'Anonymous'
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('username, email')
    .eq('user_id', data.seller_id)
    .single()
  if (profile) {
    sellerUsername = profile.username ?? (profile.email ? profile.email.split('@')[0] : 'Anonymous')
  }

  return NextResponse.json({ ...data, seller_username: sellerUsername })
}

// ── PATCH /api/marketplace/listings/[listingId] ───────────────────────────────

export async function PATCH(req: NextRequest, { params }: Params) {
  const { listingId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const allowed: Record<string, unknown> = {}

  if (body.condition   !== undefined) allowed.condition    = body.condition
  if (body.asking_price !== undefined) allowed.asking_price = body.asking_price
  if (body.description !== undefined) allowed.description  = body.description
  if (body.accepts_trades !== undefined) allowed.accepts_trades = body.accepts_trades
  if (body.status      !== undefined) allowed.status       = body.status
  if (body.image_urls  !== undefined) allowed.image_urls   = body.image_urls

  allowed.updated_at = new Date().toISOString()

  // If asking_price changed, recompute delta
  if (body.asking_price !== undefined) {
    const { data: listing } = await supabase
      .from('marketplace_listings')
      .select('ai_market_price')
      .eq('id', listingId)
      .single()
    if (listing?.ai_market_price) {
      allowed.price_delta_pct =
        Math.round(((body.asking_price - listing.ai_market_price) / listing.ai_market_price) * 1000) / 10
    }
  }

  const { data, error } = await supabase
    .from('marketplace_listings')
    .update(allowed)
    .eq('id', listingId)
    .eq('seller_id', user.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Not found or not authorized' }, { status: 404 })
  return NextResponse.json(data)
}

// ── DELETE /api/marketplace/listings/[listingId] ──────────────────────────────

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { listingId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { error } = await supabase
    .from('marketplace_listings')
    .delete()
    .eq('id', listingId)
    .eq('seller_id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
