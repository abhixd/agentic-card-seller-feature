import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ listingId: string }> }

// ── GET /api/marketplace/listings/[listingId]/offers ──────────────────────────

export async function GET(_req: NextRequest, { params }: Params) {
  const { listingId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('marketplace_offers')
    .select('id, listing_id, buyer_id, offer_price, message, status, counter_price, created_at')
    .eq('listing_id', listingId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Enrich with buyer usernames
  const buyerIds = [...new Set((data ?? []).map(o => o.buyer_id))]
  const profileMap: Record<string, string> = {}
  if (buyerIds.length > 0) {
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('user_id, username, email')
      .in('user_id', buyerIds)
    if (profiles) {
      for (const p of profiles) {
        profileMap[p.user_id] = p.username ?? (p.email ? p.email.split('@')[0] : 'Anonymous')
      }
    }
  }

  const offers = (data ?? []).map(o => ({
    ...o,
    buyer_username: profileMap[o.buyer_id] ?? 'Anonymous',
  }))

  return NextResponse.json({ offers })
}

// ── POST /api/marketplace/listings/[listingId]/offers ────────────────────────

export async function POST(req: NextRequest, { params }: Params) {
  const { listingId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Fetch listing to validate buyer != seller
  const { data: listing, error: listingError } = await supabase
    .from('marketplace_listings')
    .select('id, seller_id, status')
    .eq('id', listingId)
    .single()

  if (listingError || !listing) {
    return NextResponse.json({ error: 'Listing not found' }, { status: 404 })
  }
  if (listing.status !== 'active') {
    return NextResponse.json({ error: 'Listing is no longer active' }, { status: 400 })
  }
  if (listing.seller_id === user.id) {
    return NextResponse.json({ error: 'You cannot make an offer on your own listing' }, { status: 400 })
  }

  const { offer_price, message } = await req.json()
  if (offer_price == null || offer_price <= 0) {
    return NextResponse.json({ error: 'offer_price must be a positive number' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('marketplace_offers')
    .insert({
      listing_id:  Number(listingId),
      buyer_id:    user.id,
      offer_price,
      message:     message ?? null,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
