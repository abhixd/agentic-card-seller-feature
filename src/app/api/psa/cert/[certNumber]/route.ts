// GET /api/psa/cert/[certNumber]
// Proxy to PSA Public API cert lookup.
// Requires PSA_BEARER_TOKEN env var.

import { NextRequest, NextResponse } from 'next/server'
import { getPsaCert } from '@/lib/psa/psaApi'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ certNumber: string }> }
) {
  const { certNumber } = await params

  if (!process.env.PSA_BEARER_TOKEN) {
    return NextResponse.json(
      { error: 'PSA API not configured — add PSA_BEARER_TOKEN to environment variables.' },
      { status: 503 }
    )
  }

  try {
    const data = await getPsaCert(certNumber)
    return NextResponse.json(data)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'PSA API error'
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
