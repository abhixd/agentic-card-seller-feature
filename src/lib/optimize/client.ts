/**
 * Shared proxy helper for the optimization microservice.
 *
 * All /api/optimize/* routes use this to forward requests to
 * the Railway optimize service and return the response.
 */

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

const OPTIMIZE_SERVICE_URL = process.env.OPTIMIZE_SERVICE_URL

/**
 * Forward a POST request body to the optimize microservice endpoint
 * and stream the JSON response back to the caller.
 */
export async function proxyOptimize(
  req:      NextRequest,
  endpoint: string,   // e.g. "/optimize/grading-submission"
): Promise<NextResponse> {
  if (!OPTIMIZE_SERVICE_URL) {
    return NextResponse.json(
      { error: 'Optimization service not configured. Set OPTIMIZE_SERVICE_URL.' },
      { status: 503 },
    )
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const url = `${OPTIMIZE_SERVICE_URL.replace(/\/$/, '')}${endpoint}`

  let res: Response
  try {
    res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      // No caching — optimization results depend on real-time inputs
      cache: 'no-store',
    })
  } catch (err) {
    console.error(`[optimize] Service unreachable at ${url}:`, err)
    return NextResponse.json(
      { error: 'Optimization service unreachable.' },
      { status: 503 },
    )
  }

  const data = await res.json()

  if (!res.ok) {
    console.error(`[optimize] Service error ${res.status} at ${endpoint}:`, data)
    return NextResponse.json(
      { error: data?.detail ?? 'Optimization service returned an error.' },
      { status: res.status },
    )
  }

  return NextResponse.json(data)
}
