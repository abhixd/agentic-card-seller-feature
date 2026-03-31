import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// GET /api/social/requests — pending follow requests received by current user
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('user_follows')
    .select(
      `id,
       created_at,
       follower:user_profiles!user_follows_follower_id_fkey (
         user_id, username, display_name, avatar_url
       )`
    )
    .eq('following_id', user.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ requests: data ?? [] })
}

// PATCH /api/social/requests — accept or reject a pending request
// Body: { followerId: string, action: 'accept' | 'reject' }
export async function PATCH(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { followerId, action } = body as { followerId?: string; action?: string }
  if (!followerId) return NextResponse.json({ error: 'followerId is required' }, { status: 400 })
  if (action !== 'accept' && action !== 'reject') {
    return NextResponse.json({ error: 'action must be "accept" or "reject"' }, { status: 400 })
  }

  if (action === 'accept') {
    const { data, error } = await supabase
      .from('user_follows')
      .update({ status: 'accepted' })
      .eq('follower_id', followerId)
      .eq('following_id', user.id)
      .eq('status', 'pending')
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'Request not found' }, { status: 404 })
    return NextResponse.json({ follow: data })
  }

  // reject — delete the pending row
  const { error } = await supabase
    .from('user_follows')
    .delete()
    .eq('follower_id', followerId)
    .eq('following_id', user.id)
    .eq('status', 'pending')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
