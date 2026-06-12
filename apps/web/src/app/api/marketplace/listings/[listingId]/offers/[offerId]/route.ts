import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ listingId: string; offerId: string }> }

// ── PATCH /api/marketplace/listings/[listingId]/offers/[offerId] ──────────────
// Seller: accept | reject | counter
// Buyer:  withdraw

export async function PATCH(req: NextRequest, { params }: Params) {
  const { listingId, offerId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Fetch the offer + its listing to determine roles
  const { data: offer, error: offerError } = await supabase
    .from('marketplace_offers')
    .select('id, listing_id, buyer_id, status')
    .eq('id', offerId)
    .eq('listing_id', listingId)
    .single()

  if (offerError || !offer) {
    return NextResponse.json({ error: 'Offer not found' }, { status: 404 })
  }

  const { data: listing } = await supabase
    .from('marketplace_listings')
    .select('seller_id')
    .eq('id', listingId)
    .single()

  const isSeller = listing?.seller_id === user.id
  const isBuyer  = offer.buyer_id === user.id

  if (!isSeller && !isBuyer) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const { status, counter_price } = body

  const SELLER_TRANSITIONS = ['accepted', 'rejected', 'countered'] as const
  const BUYER_TRANSITIONS  = ['withdrawn'] as const

  if (isSeller && !SELLER_TRANSITIONS.includes(status)) {
    return NextResponse.json({ error: 'Sellers can only accept, reject, or counter' }, { status: 400 })
  }
  if (isBuyer && !BUYER_TRANSITIONS.includes(status)) {
    return NextResponse.json({ error: 'Buyers can only withdraw their offer' }, { status: 400 })
  }
  if (status === 'countered' && (counter_price == null || counter_price <= 0)) {
    return NextResponse.json({ error: 'counter_price required when countering' }, { status: 400 })
  }

  const update: Record<string, unknown> = { status }
  if (status === 'countered') update.counter_price = counter_price

  const { data, error } = await supabase
    .from('marketplace_offers')
    .update(update)
    .eq('id', offerId)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // If accepted, mark listing as sold
  if (status === 'accepted' && isSeller) {
    await supabase
      .from('marketplace_listings')
      .update({ status: 'sold', updated_at: new Date().toISOString() })
      .eq('id', listingId)
      .eq('seller_id', user.id)
  }

  return NextResponse.json(data)
}
