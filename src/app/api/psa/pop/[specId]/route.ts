// GET /api/psa/pop/[specId]
// Proxy to PSA Public API population report.
// Requires PSA_BEARER_TOKEN env var.

import { NextRequest, NextResponse } from 'next/server'
import { getPsaPop } from '@/lib/psa/psaApi'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ specId: string }> }
) {
  const { specId } = await params
  const id = parseInt(specId, 10)

  if (isNaN(id)) {
    return NextResponse.json({ error: 'Invalid specId' }, { status: 400 })
  }

  if (!process.env.PSA_BEARER_TOKEN) {
    return NextResponse.json(
      { error: 'PSA API not configured — add PSA_BEARER_TOKEN to environment variables.' },
      { status: 503 }
    )
  }

  try {
    const data = await getPsaPop(id)
    return NextResponse.json(data)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'PSA API error'
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
