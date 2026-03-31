import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// GET /api/profile — return own profile (null if not set up yet)
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ profile: data })
}

// PATCH /api/profile — upsert profile fields
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

  const {
    username,
    display_name,
    bio,
    collection_visibility,
  } = body as Record<string, string>

  if (!username || typeof username !== 'string' || username.trim() === '') {
    return NextResponse.json({ error: 'username is required' }, { status: 400 })
  }

  const validVisibility = ['public', 'friends', 'private']
  if (collection_visibility && !validVisibility.includes(collection_visibility)) {
    return NextResponse.json({ error: 'Invalid collection_visibility value' }, { status: 400 })
  }

  const upsertData: Record<string, unknown> = {
    user_id: user.id,
    username: username.trim(),
    updated_at: new Date().toISOString(),
  }
  if (display_name !== undefined) upsertData.display_name = display_name
  if (bio !== undefined) upsertData.bio = bio
  if (collection_visibility !== undefined) upsertData.collection_visibility = collection_visibility

  const { data, error } = await supabase
    .from('user_profiles')
    .upsert(upsertData, { onConflict: 'user_id' })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Username already taken' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ profile: data })
}
