import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('user_wantlist')
    .select(`
      id, target_price, notes, created_at,
      card_catalog_items (
        catalog_id, card_name, set_name, card_number,
        canonical_image_url, metadata_json
      )
    `)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ items: data ?? [] })
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { catalogId, targetPrice, notes } = await req.json()
  if (!catalogId) return NextResponse.json({ error: 'catalogId required' }, { status: 400 })

  const { data, error } = await supabase
    .from('user_wantlist')
    .upsert(
      { user_id: user.id, catalog_id: catalogId, target_price: targetPrice ?? null, notes: notes ?? null },
      { onConflict: 'user_id,catalog_id' }
    )
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
