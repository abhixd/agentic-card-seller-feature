import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getValidToken } from '@/lib/ebay/tokens'
import { getSellerPolicies } from '@/lib/ebay/sellApi'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const token    = await getValidToken(user.id, supabase)
    const policies = await getSellerPolicies(token)
    return NextResponse.json(policies)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch policies'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
