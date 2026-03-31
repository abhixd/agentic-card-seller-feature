import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// GET /api/social/users?q=search_term — search users by username or display_name
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const q = new URL(request.url).searchParams.get('q') ?? ''

  let query = supabase
    .from('user_profiles')
    .select('user_id, username, display_name, avatar_url, collection_visibility')
    .neq('user_id', user.id)
    .limit(30)

  if (q.trim() !== '') {
    query = query.or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
  }

  const { data, error } = await query.order('username')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ users: data ?? [] })
}
