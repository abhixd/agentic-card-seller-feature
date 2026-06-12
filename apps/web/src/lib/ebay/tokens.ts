/**
 * Token management — reads/writes ebay_credentials via a Supabase server client.
 * Call getValidToken() before every eBay API call; it auto-refreshes when needed.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { refreshAccessToken } from './auth'

const REFRESH_BUFFER_MS = 5 * 60 * 1000 // refresh 5 min before expiry

export async function getValidToken(
  userId: string,
  supabase: SupabaseClient,
): Promise<string> {
  const { data: creds, error } = await supabase
    .from('ebay_credentials')
    .select('access_token, refresh_token, access_expires_at, refresh_expires_at')
    .eq('user_id', userId)
    .single()

  if (error || !creds) {
    throw new Error('eBay account not connected. Please connect via Settings.')
  }

  const refreshExpiresAt = new Date(creds.refresh_expires_at).getTime()
  if (Date.now() > refreshExpiresAt) {
    throw new Error('eBay session expired. Please reconnect via Settings.')
  }

  const accessExpiresAt = new Date(creds.access_expires_at).getTime()
  if (Date.now() < accessExpiresAt - REFRESH_BUFFER_MS) {
    return creds.access_token
  }

  // Access token expired — refresh it
  const tokens = await refreshAccessToken(creds.refresh_token)
  const now = Date.now()

  await supabase
    .from('ebay_credentials')
    .update({
      access_token:      tokens.access_token,
      access_expires_at: new Date(now + tokens.expires_in * 1000).toISOString(),
    })
    .eq('user_id', userId)

  return tokens.access_token
}
