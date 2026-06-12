import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// GET /api/profile/[username]/collection — return user's inventory with privacy check
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ username: string }> }
) {
  const { username } = await params

  const supabase = await createClient()

  // Get the viewer (may be null/anon)
  const {
    data: { user: viewer },
  } = await supabase.auth.getUser()

  // Resolve the target profile
  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('user_id, collection_visibility')
    .eq('username', username)
    .maybeSingle()

  if (profileError) return NextResponse.json({ error: profileError.message }, { status: 500 })
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

  const isOwner = viewer?.id === profile.user_id

  // Privacy gate
  if (!isOwner) {
    if (profile.collection_visibility === 'private') {
      return NextResponse.json({ error: 'This collection is private' }, { status: 403 })
    }

    if (profile.collection_visibility === 'friends') {
      if (!viewer) {
        return NextResponse.json({ error: 'Follow to see this collection' }, { status: 403 })
      }
      const { data: follow } = await supabase
        .from('user_follows')
        .select('status')
        .eq('follower_id', viewer.id)
        .eq('following_id', profile.user_id)
        .maybeSingle()

      if (!follow || follow.status !== 'accepted') {
        return NextResponse.json({ error: 'Follow to see this collection' }, { status: 403 })
      }
    }
  }

  // Fetch inventory items with catalog join
  const { data: items, error: itemsError } = await supabase
    .from('inventory_items')
    .select(
      `item_id,
       catalog_id,
       status,
       acquisition_cost,
       card:card_catalog_items (
         card_name,
         set_name,
         year,
         card_number,
         canonical_image_url,
         metadata_json
       )`
    )
    .eq('user_id', profile.user_id)
    .order('created_at', { ascending: false })

  if (itemsError) return NextResponse.json({ error: itemsError.message }, { status: 500 })

  // Omit acquisition_cost for non-owners
  const sanitized = (items ?? []).map((item) => {
    if (isOwner) return item
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { acquisition_cost: _omit, ...rest } = item
    return rest
  })

  return NextResponse.json({ items: sanitized, count: sanitized.length })
}
