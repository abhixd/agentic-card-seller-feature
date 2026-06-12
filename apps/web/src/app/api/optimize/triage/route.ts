/**
 * POST /api/optimize/triage
 *
 * A2 — Bulk Inventory Triage (assignment MIP)
 * Assigns each card to one of: list-individually, lot, grade, hold, bulk-sell
 * to maximise total net value within labor and grading budget constraints.
 */

import { NextRequest } from 'next/server'
import { proxyOptimize } from '@/lib/optimize/client'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  return proxyOptimize(req, '/optimize/triage')
}
