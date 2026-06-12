import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// POST /api/social/follow — follow a user
// Body: { followingId: string }
export async function POST(request: NextRequest) {
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

  const { followingId } = body as { followingId?: string }
  if (!followingId) return NextResponse.json({ error: 'followingId is required' }, { status: 400 })
  if (followingId === user.id) {
    return NextResponse.json({ error: 'Cannot follow yourself' }, { status: 400 })
  }

  // Check the target user's visibility to determine initial status
  const { data: targetProfile } = await supabase
    .from('user_profiles')
    .select('collection_visibility')
    .eq('user_id', followingId)
    .maybeSingle()

  // 'friends' visibility requires approval; everything else auto-accepts
  const status = targetProfile?.collection_visibility === 'friends' ? 'pending' : 'accepted'

  const { data, error } = await supabase
    .from('user_follows')
    .insert({ follower_id: user.id, following_id: followingId, status })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Already following' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ follow: data }, { status: 201 })
}

// DELETE /api/social/follow — unfollow a user
// Body: { followingId: string }
export async function DELETE(request: NextRequest) {
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

  const { followingId } = body as { followingId?: string }
  if (!followingId) return NextResponse.json({ error: 'followingId is required' }, { status: 400 })

  const { error } = await supabase
    .from('user_follows')
    .delete()
    .eq('follower_id', user.id)
    .eq('following_id', followingId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// GET /api/social/follow — return current user's following list with status
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
       status,
       created_at,
       following:user_profiles!user_follows_following_id_fkey (
         user_id, username, display_name, avatar_url, collection_visibility
       )`
    )
    .eq('follower_id', user.id)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ following: data ?? [] })
}
