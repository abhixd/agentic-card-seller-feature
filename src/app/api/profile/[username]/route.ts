import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// GET /api/profile/[username] — return public profile by username
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ username: string }> }
) {
  const { username } = await params

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('user_profiles')
    .select('user_id, username, display_name, avatar_url, bio, collection_visibility, created_at')
    .eq('username', username)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

  return NextResponse.json({ profile: data })
}
