/**
 * POST /api/optimize/grading-submission
 *
 * A1 — Grading Submission Optimizer (stochastic knapsack MIP)
 * Selects which cards to submit, to which grader, at which tier,
 * to maximise expected net profit within budget and deadline constraints.
 */

import { NextRequest } from 'next/server'
import { proxyOptimize } from '@/lib/optimize/client'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  return proxyOptimize(req, '/optimize/grading-submission')
}
