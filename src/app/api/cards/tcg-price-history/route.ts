// GET /api/cards/tcg-price-history?catalogId=123[&duration=90d][&force=1]
// Returns daily TCGPlayer market price snapshots via JustTCG API.
// Results cached in card metadata_json.tcg_cache for 24h.

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { fetchJustTcgPriceHistory, type JustTcgPoint } from '@/lib/justtcg/justTcgApi'

const CACHE_TTL_MS   = 24 * 60 * 60 * 1000  // 24h for real data
const CACHE_EMPTY_MS =  2 * 60 * 60 * 1000  //  2h for API errors

type Duration = '7d' | '30d' | '90d' | '180d'
const VALID_DURATIONS: Duration[] = ['7d', '30d', '90d', '180d']

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const catalogId = searchParams.get('catalogId')
  const rawDur    = searchParams.get('duration') ?? '90d'
  const duration  = VALID_DURATIONS.includes(rawDur as Duration) ? (rawDur as Duration) : '90d'
  const force     = searchParams.get('force') === '1'

  if (!catalogId) {
    return NextResponse.json({ error: 'catalogId required' }, { status: 400 })
  }

  if (!process.env.JUSTTCG_API_KEY) {
    return NextResponse.json({ points: [], rateLimited: false, configured: false })
  }

  // ── Load card from catalog ────────────────────────────────────────────────
  const supabase = await createClient()
  const { data } = await supabase
    .from('card_catalog_items')
    .select('catalog_id, card_name, card_number, metadata_json')
    .eq('catalog_id', catalogId)
    .single()

  if (!data) return NextResponse.json({ points: [], rateLimited: false })

  const card = data as {
    catalog_id:    string
    card_name:     string
    card_number:   string | null
    metadata_json: Record<string, unknown> | null
  }

  // ── DB cache check ────────────────────────────────────────────────────────
  const cacheKey = `tcg_cache_${duration}`
  if (!force) {
    const meta   = card.metadata_json ?? {}
    const cached = meta[cacheKey] as {
      points:      JustTcgPoint[]
      fetched_at:  string
      empty_until?: string | null
    } | undefined

    if (cached?.fetched_at) {
      if (cached.empty_until && Date.now() < new Date(cached.empty_until).getTime()) {
        return NextResponse.json({ points: [], rateLimited: true, fromCache: true })
      }
      if (cached.points.length > 0) {
        const age = Date.now() - new Date(cached.fetched_at).getTime()
        if (age < CACHE_TTL_MS) {
          return NextResponse.json({ points: cached.points, rateLimited: false, fromCache: true })
        }
      }
    }
  }

  // ── Live JustTCG fetch ────────────────────────────────────────────────────
  const { points, keyword, apiError } = await fetchJustTcgPriceHistory(
    card.card_name,
    card.card_number,
    duration,
    force,
  )

  // ── Write back to DB cache ────────────────────────────────────────────────
  try {
    const svcClient    = createServiceClient()
    const existingMeta = card.metadata_json ?? {}
    const now          = new Date()

    const cachePayload = apiError
      ? { points: [], fetched_at: now.toISOString(), empty_until: new Date(Date.now() + CACHE_EMPTY_MS).toISOString() }
      : { points, fetched_at: now.toISOString(), empty_until: null }

    await svcClient
      .from('card_catalog_items')
      .update({ metadata_json: { ...existingMeta, [cacheKey]: cachePayload } })
      .eq('catalog_id', catalogId)
  } catch (err) {
    console.error('[tcg-price-history] Cache write error:', err)
  }

  return NextResponse.json({ points, keyword, rateLimited: apiError })
}
