import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data } = await supabase
    .from('ebay_credentials')
    .select('connected_at, refresh_expires_at, ebay_username')
    .eq('user_id', user.id)
    .single()

  if (!data) {
    return NextResponse.json({ connected: false })
  }

  const refreshExpired = Date.now() > new Date(data.refresh_expires_at).getTime()

  return NextResponse.json({
    connected:      !refreshExpired,
    expired:        refreshExpired,
    connectedAt:    data.connected_at,
    ebayUsername:   data.ebay_username ?? null,
  })
}

export async function DELETE() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await supabase.from('ebay_credentials').delete().eq('user_id', user.id)

  return NextResponse.json({ disconnected: true })
}
