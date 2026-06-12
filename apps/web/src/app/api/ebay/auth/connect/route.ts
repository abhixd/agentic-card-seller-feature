import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAuthorizationUrl } from '@/lib/ebay/auth'
import { randomBytes } from 'crypto'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // state = userId:randomNonce — verified in callback to prevent CSRF
  const nonce = randomBytes(16).toString('hex')
  const state = `${user.id}:${nonce}`

  const url = getAuthorizationUrl(state)
  return NextResponse.redirect(url)
}
