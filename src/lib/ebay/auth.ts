/**
 * eBay OAuth 2.0 helpers — no database access, pure HTTP.
 *
 * Required env vars:
 *   EBAY_CLIENT_ID     — App ID from eBay Developer Portal
 *   EBAY_CLIENT_SECRET — Cert ID (Client Secret) from eBay Developer Portal
 *   EBAY_RUNAME        — Redirect URI Name registered in eBay Developer Portal
 *   EBAY_SANDBOX       — "true" for sandbox, omit or "false" for production
 */

const SANDBOX = process.env.EBAY_SANDBOX === 'true'

export const EBAY_AUTH_BASE = SANDBOX
  ? 'https://auth.sandbox.ebay.com'
  : 'https://auth.ebay.com'

export const EBAY_API_BASE = SANDBOX
  ? 'https://api.sandbox.ebay.com'
  : 'https://api.ebay.com'

export const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
].join(' ')

export interface EbayTokens {
  access_token:             string
  refresh_token:            string
  expires_in:               number  // seconds
  refresh_token_expires_in: number  // seconds
}

function basicAuth(): string {
  const creds = `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  return `Basic ${Buffer.from(creds).toString('base64')}`
}

/** Generates the URL to redirect the user to for eBay OAuth consent. */
export function getAuthorizationUrl(state: string): string {
  const params = new URLSearchParams({
    client_id:     process.env.EBAY_CLIENT_ID!,
    response_type: 'code',
    redirect_uri:  process.env.EBAY_RUNAME!,
    scope:         EBAY_SCOPES,
    state,
  })
  return `${EBAY_AUTH_BASE}/oauth2/authorize?${params.toString()}`
}

/** Exchanges an authorization code for access + refresh tokens. */
export async function exchangeCode(code: string): Promise<EbayTokens> {
  const res = await fetch(`${EBAY_API_BASE}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': basicAuth(),
    },
    body: new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: process.env.EBAY_RUNAME!,
    }),
    cache: 'no-store',
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`eBay code exchange failed (${res.status}): ${body}`)
  }
  return res.json() as Promise<EbayTokens>
}

/** Refreshes an expired access token using the refresh token. */
export async function refreshAccessToken(refreshToken: string): Promise<EbayTokens> {
  const res = await fetch(`${EBAY_API_BASE}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': basicAuth(),
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      scope:         EBAY_SCOPES,
    }),
    cache: 'no-store',
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`eBay token refresh failed (${res.status}): ${body}`)
  }
  return res.json() as Promise<EbayTokens>
}
