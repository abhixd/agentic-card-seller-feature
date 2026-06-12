import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getValidToken } from '@/lib/ebay/tokens'
import { getTrafficReport } from '@/lib/ebay/sellApi'

// GET /api/ebay/listings           — fetch all user listings (+ refresh analytics if ?refresh=1)
// PATCH /api/ebay/listings/[id]    — end / mark sold (handled separately below)

export async function GET(req: NextRequest) {
  const supabase    = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const refreshAnalytics = new URL(req.url).searchParams.get('refresh') === '1'

  const { data: listings, error } = await supabase
    .from('ebay_listings')
    .select(`
      *,
      inventory_items (
        acquisition_cost,
        card_catalog_items ( card_name, franchise_or_brand, set_name, year, card_number, variant, canonical_image_url )
      )
    `)
    .eq('user_id', user.id)
    .order('listed_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Optionally refresh analytics for active listings
  if (refreshAnalytics && listings && listings.length > 0) {
    const activeIds = listings
      .filter(l => l.status === 'active' && l.ebay_item_id)
      .map(l => l.ebay_item_id as string)

    if (activeIds.length > 0) {
      try {
        const token   = await getValidToken(user.id, supabase)
        const reports = await getTrafficReport(token, activeIds)

        await Promise.all(
          reports.map(r =>
            supabase
              .from('ebay_listings')
              .update({
                impressions:          r.impressions,
                views:                r.views,
                transactions:         r.transactions,
                analytics_updated_at: new Date().toISOString(),
              })
              .eq('ebay_item_id', r.ebayItemId)
              .eq('user_id',      user.id),
          ),
        )

        // Re-fetch with fresh data
        const { data: fresh } = await supabase
          .from('ebay_listings')
          .select(`
            *,
            inventory_items (
              acquisition_cost,
              card_catalog_items ( card_name, franchise_or_brand, set_name, year, card_number, variant, canonical_image_url )
            )
          `)
          .eq('user_id', user.id)
          .order('listed_at', { ascending: false })

        return NextResponse.json({ listings: fresh ?? [], analyticsRefreshed: true })
      } catch (err) {
        console.error('[ebay/listings] analytics refresh failed:', err)
        // Fall through — return stale data rather than failing
      }
    }
  }

  return NextResponse.json({ listings: listings ?? [], analyticsRefreshed: false })
}
