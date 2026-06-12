/**
 * POST /api/optimize/listing-price
 *
 * B1 — Listing Price Optimizer (continuous LP / EV)
 * Returns Quick Sale / Fair Market / Stretch price bands using
 * recency-weighted comp analysis and sell-through probability.
 */

import { NextRequest } from 'next/server'
import { proxyOptimize } from '@/lib/optimize/client'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  return proxyOptimize(req, '/optimize/listing-price')
}
