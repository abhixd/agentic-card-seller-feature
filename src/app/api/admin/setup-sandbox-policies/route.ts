// POST /api/admin/setup-sandbox-policies
// One-time endpoint to create the 3 required eBay seller policies in sandbox.
// Protected by ADMIN_SECRET. Delete this route after sandbox testing is done.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getValidToken } from '@/lib/ebay/tokens'
import { EBAY_API_BASE } from '@/lib/ebay/auth'

export async function POST(req: NextRequest) {
  // Admin auth check
  const secret = req.headers.get('x-admin-secret')
  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not logged in' }, { status: 401 })

  let token: string
  try {
    token = await getValidToken(user.id, supabase)
  } catch {
    return NextResponse.json({ error: 'No eBay token — connect eBay first in Settings' }, { status: 400 })
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
  }

  const results: Record<string, unknown> = {}

  // 0. Opt in to Business Policies first
  try {
    const optInRes = await fetch(`${EBAY_API_BASE}/sell/account/v1/program/opt_in`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ programType: 'SELLING_POLICY_MANAGEMENT' }),
    })
    results.optIn = { status: optInRes.status, body: await optInRes.text() }
  } catch (e) {
    results.optIn = { error: String(e) }
  }

  // 1. Fulfillment policy
  try {
    const res = await fetch(`${EBAY_API_BASE}/sell/account/v1/fulfillment_policy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Standard Shipping',
        marketplaceId: 'EBAY_US',
        categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
        handlingTime: { value: 3, unit: 'DAY' },
        shippingOptions: [{
          optionType: 'DOMESTIC',
          costType: 'FLAT_RATE',
          shippingServices: [{
            sortOrder: 1,
            shippingServiceCode: 'USPSFirstClass',
            shippingCost: { value: '4.00', currency: 'USD' },
          }],
        }],
      }),
    })
    results.fulfillment = await res.json()
  } catch (e) {
    results.fulfillment = { error: String(e) }
  }

  // 2. Payment policy
  try {
    const res = await fetch(`${EBAY_API_BASE}/sell/account/v1/payment_policy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Immediate Payment',
        marketplaceId: 'EBAY_US',
        categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
        immediatePay: true,
        paymentMethods: [{ paymentMethodType: 'PAYPAL' }],
      }),
    })
    results.payment = await res.json()
  } catch (e) {
    results.payment = { error: String(e) }
  }

  // 3. Return policy
  try {
    const res = await fetch(`${EBAY_API_BASE}/sell/account/v1/return_policy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: '30 Day Returns',
        marketplaceId: 'EBAY_US',
        categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
        returnsAccepted: true,
        returnPeriod: { value: 30, unit: 'DAY' },
        returnShippingCostPayer: 'BUYER',
        refundMethod: 'MONEY_BACK',
      }),
    })
    results.return = await res.json()
  } catch (e) {
    results.return = { error: String(e) }
  }

  return NextResponse.json({ results })
}
