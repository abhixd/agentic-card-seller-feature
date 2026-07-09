import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getValidToken } from '@/lib/ebay/tokens'
import { publishListing, buildTitle, getCategoryId } from '@/lib/ebay/sellApi'
import type { EbayCondition } from '@/lib/ebay/sellApi'
import { z } from 'zod'

const ListBody = z.object({
  inventoryItemId:     z.string().uuid(),
  price:               z.number().positive(),
  condition:           z.enum(['NEW','LIKE_NEW','EXCELLENT','VERY_GOOD','GOOD','ACCEPTABLE','FOR_PARTS_OR_NOT_WORKING']),
  conditionDesc:       z.string().max(500).optional().default(''),
  fulfillmentPolicyId: z.string().min(1),
  paymentPolicyId:     z.string().min(1),
  returnPolicyId:      z.string().min(1),
})

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body   = await req.json()
  const parsed = ListBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { inventoryItemId, price, condition, conditionDesc, fulfillmentPolicyId, paymentPolicyId, returnPolicyId } = parsed.data

  // Fetch inventory item + card metadata (verify ownership)
  const { data: item } = await supabase
    .from('inventory_items')
    .select(`
      item_id, status,
      card_catalog_items (
        card_name, franchise_or_brand, set_name, year,
        card_number, variant, canonical_image_url
      )
    `)
    .eq('item_id', inventoryItemId)
    .eq('user_id', user.id)
    .single()

  if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 })

  const cat = item.card_catalog_items as unknown as {
    card_name: string; franchise_or_brand: string; set_name: string | null
    year: number | null; card_number: string | null; variant: string | null
    canonical_image_url: string | null
  } | null

  if (!cat) return NextResponse.json({ error: 'Card catalog data missing' }, { status: 400 })

  // Build listing content
  const title       = buildTitle(cat)
  const categoryId  = getCategoryId(cat.franchise_or_brand)
  const imageUrls   = cat.canonical_image_url ? [cat.canonical_image_url] : []
  const description = [
    title,
    cat.set_name ? `Set: ${cat.set_name}` : null,
    cat.year     ? `Year: ${cat.year}`     : null,
    cat.card_number ? `Card Number: #${cat.card_number}` : null,
    cat.variant  ? `Variant: ${cat.variant}` : null,
    conditionDesc || null,
    'Listed via ScanDex.',
  ].filter(Boolean).join('\n')

  const aspects: Record<string, string[]> = {
    'Type': ['Trading Card'],
  }
  if (cat.set_name)       aspects['Set']              = [cat.set_name]
  if (cat.year)           aspects['Year Manufactured'] = [String(cat.year)]
  if (cat.card_number)    aspects['Card Number']       = [cat.card_number]
  if (cat.franchise_or_brand) aspects['Franchise']    = [cat.franchise_or_brand]

  try {
    const token   = await getValidToken(user.id, supabase)
    const listing = await publishListing(token, {
      inventoryItemId,
      title,
      description,
      imageUrls,
      aspects,
      categoryId,
      price,
      condition: condition as EbayCondition,
      conditionDesc,
      fulfillmentPolicyId,
      paymentPolicyId,
      returnPolicyId,
    })

    // Persist the listing record
    const { data: listingRow } = await supabase
      .from('ebay_listings')
      .insert({
        user_id:           user.id,
        inventory_item_id: inventoryItemId,
        ebay_item_id:      listing.ebayItemId,
        ebay_offer_id:     listing.ebayOfferId,
        sku:               inventoryItemId,
        list_price:        price,
        condition,
        status:            'active',
        ebay_url:          listing.ebayUrl,
      })
      .select('listing_id')
      .single()

    // Update inventory status → listed
    await supabase
      .from('inventory_items')
      .update({ status: 'listed' })
      .eq('item_id', inventoryItemId)
      .eq('user_id', user.id)

    return NextResponse.json({
      listingId:  listingRow?.listing_id,
      ebayItemId: listing.ebayItemId,
      ebayUrl:    listing.ebayUrl,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Listing failed'
    console.error('[ebay/list] error:', message)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
