/**
 * POST /api/optimize/rebalance
 *
 * A4 — Portfolio Rebalancing (constrained portfolio MIP)
 * Recommends which holdings to sell to realise profit, reduce concentration,
 * and improve liquidity within session constraints.
 */

import { NextRequest } from 'next/server'
import { proxyOptimize } from '@/lib/optimize/client'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  return proxyOptimize(req, '/optimize/rebalance')
}
