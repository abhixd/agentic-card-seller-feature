// ---------------------------------------------------------------
// eBay Marketplace Account Deletion Notification Endpoint
// Required by eBay to keep Production keyset enabled.
// Docs: https://developer.ebay.com/marketplace-account-deletion
//
// GET  — eBay verification challenge (one-time setup)
// POST — Account deletion notification (ongoing)
// ---------------------------------------------------------------

import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'

// Set EBAY_VERIFICATION_TOKEN in .env.local to any random string you choose.
// You'll enter this same value in the eBay developer dashboard when registering
// this endpoint URL.
const VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN ?? ''

// ---------------------------------------------------------------
// GET — eBay sends ?challenge_code=xxx to verify endpoint ownership
// We must respond with SHA256(challengeCode + verificationToken + endpointUrl)
// ---------------------------------------------------------------

export async function GET(req: NextRequest) {
  const challengeCode = req.nextUrl.searchParams.get('challenge_code')

  if (!challengeCode) {
    return NextResponse.json({ error: 'Missing challenge_code' }, { status: 400 })
  }

  if (!VERIFICATION_TOKEN) {
    console.error('[eBay] EBAY_VERIFICATION_TOKEN not set')
    return NextResponse.json({ error: 'Endpoint not configured' }, { status: 500 })
  }

  // Derive the canonical endpoint URL from the incoming request — no env var needed.
  // eBay requires the URL to exactly match what you registered in the developer portal.
  const ENDPOINT_URL = `${req.nextUrl.protocol}//${req.nextUrl.host}/api/ebay/account-deletion`

  console.log('[eBay] challenge verification | endpoint:', ENDPOINT_URL)

  // Hash: SHA256(challengeCode + verificationToken + endpointUrl) — no separators
  const hash = createHash('sha256')
    .update(challengeCode + VERIFICATION_TOKEN + ENDPOINT_URL)
    .digest('hex')

  return NextResponse.json({ challengeResponse: hash })
}

// ---------------------------------------------------------------
// POST — eBay notifies us of an account deletion
// We must delete or anonymise any stored data for that user.
// For this app: we don't store eBay user data, so we just acknowledge.
// ---------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const topic = body?.metadata?.topic ?? 'unknown'
    const userId = body?.notification?.data?.userId ?? null

    console.log(`[eBay] Account deletion notification | topic: ${topic} | userId: ${userId}`)

    // This app does not store eBay user account data.
    // If you add eBay OAuth user tokens in the future, delete them here.

    return NextResponse.json({ acknowledged: true }, { status: 200 })
  } catch (err) {
    console.error('[eBay] Failed to parse deletion notification:', err)
    // Still return 200 — eBay will retry on non-200 responses
    return NextResponse.json({ acknowledged: true }, { status: 200 })
  }
}
