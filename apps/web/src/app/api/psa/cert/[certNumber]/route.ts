// GET /api/psa/cert/[certNumber]
// Proxy to PSA Public API cert lookup.
// Requires PSA_BEARER_TOKEN env var.

import { NextRequest, NextResponse } from 'next/server'

const PSA_API_BASE = 'https://api.psacard.com/publicapi'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ certNumber: string }> }
) {
  const { certNumber } = await params
  const clean = certNumber.replace(/\D/g, '')

  if (!process.env.PSA_BEARER_TOKEN) {
    return NextResponse.json(
      { error: 'PSA API not configured — add PSA_BEARER_TOKEN to environment variables.' },
      { status: 503 }
    )
  }

  try {
    const res = await fetch(
      `${PSA_API_BASE}/cert/GetByCertNumber/${clean}`,
      {
        headers: {
          Authorization: `bearer ${process.env.PSA_BEARER_TOKEN}`,
          Accept: 'application/json',
        },
        next: { revalidate: 3600 },
      }
    )

    // PSA returns 404 when cert not found — treat as "not found" not an error
    if (res.status === 404) {
      return NextResponse.json({
        PSACert: null,
        IsValidRequest: false,
        ServerMessage: 'Cert number not found. Check the number on your PSA slab.',
      })
    }

    if (!res.ok) {
      const body = await res.text()
      return NextResponse.json(
        { error: `PSA API returned ${res.status}: ${body}` },
        { status: 502 }
      )
    }

    const data = await res.json()
    return NextResponse.json(data)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'PSA API error'
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
