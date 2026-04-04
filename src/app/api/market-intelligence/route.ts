import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

// GET /api/market-intelligence?limit=5
// Returns the latest N market intelligence posts (default 5, max 20).
// No auth required — read-only public endpoint.

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const limitParam = parseInt(searchParams.get('limit') ?? '5', 10)
  const limit = Math.min(Math.max(1, isNaN(limitParam) ? 5 : limitParam), 20)

  try {
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from('market_intelligence_posts')
      .select('id, headline, body, signal_types, cards_referenced, confidence, generated_at')
      .order('generated_at', { ascending: false })
      .limit(limit)

    if (error) {
      console.error('[api/market-intelligence] Query error:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ posts: data ?? [] })
  } catch (err) {
    console.error('[api/market-intelligence] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
