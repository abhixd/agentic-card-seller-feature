import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { exchangeCode } from '@/lib/ebay/auth'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const code  = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

  if (error) {
    console.error('[ebay/callback] eBay denied consent:', error)
    return NextResponse.redirect(`${appUrl}/settings?ebay=denied`)
  }

  if (!code || !state) {
    return NextResponse.redirect(`${appUrl}/settings?ebay=error&reason=missing_params`)
  }

  // state format: "{userId}:{nonce}" — extract userId for credential storage
  const [userId] = state.split(':')
  if (!userId) {
    return NextResponse.redirect(`${appUrl}/settings?ebay=error&reason=bad_state`)
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.id !== userId) {
    return NextResponse.redirect(`${appUrl}/settings?ebay=error&reason=user_mismatch`)
  }

  try {
    const tokens = await exchangeCode(code)
    const now    = Date.now()

    await supabase
      .from('ebay_credentials')
      .upsert({
        user_id:             user.id,
        access_token:        tokens.access_token,
        refresh_token:       tokens.refresh_token,
        access_expires_at:   new Date(now + tokens.expires_in * 1000).toISOString(),
        refresh_expires_at:  new Date(now + tokens.refresh_token_expires_in * 1000).toISOString(),
        connected_at:        new Date(now).toISOString(),
      }, { onConflict: 'user_id' })

    return NextResponse.redirect(`${appUrl}/settings?ebay=connected`)
  } catch (err) {
    console.error('[ebay/callback] token exchange failed:', err)
    return NextResponse.redirect(`${appUrl}/settings?ebay=error&reason=token_exchange`)
  }
}
