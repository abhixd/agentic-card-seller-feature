/**
 * POST /api/optimize/offer
 *
 * B2 — Offer Negotiation Advisor (EV rule-based)
 * Recommends accept, counter (with optimal counter price), or decline
 * based on expected-value analysis of each outcome.
 */

import { NextRequest } from 'next/server'
import { proxyOptimize } from '@/lib/optimize/client'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  return proxyOptimize(req, '/optimize/offer')
}
