/**
 * POST /api/optimize/buy-basket
 *
 * A3 — Buy Basket Optimizer (stochastic knapsack MIP)
 * Selects which cards to buy (and optionally grade) at a show or shop
 * to maximise portfolio ROI within a capital budget.
 */

import { NextRequest } from 'next/server'
import { proxyOptimize } from '@/lib/optimize/client'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  return proxyOptimize(req, '/optimize/buy-basket')
}
