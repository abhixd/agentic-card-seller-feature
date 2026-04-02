// GET /api/cards/tcg-price-history?catalogId=123[&force=1]
//
// Returns ALL accumulated TCGPlayer market price history for a card.
// History is built up over time: every 24 h we fetch the latest 180 d from
// JustTCG and MERGE the new points into the existing stored history rather
// than replacing it.  This means that after a year of usage the stored
// history can span well beyond JustTCG's 180-day API limit.
//
// The set name is passed to JustTCG to disambiguate cards that share a name
// (e.g. "Charizard VSTAR" appears in multiple sets with very different prices).

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { fetchJustTcgPriceHistory, type JustTcgPoint } from '@/lib/justtcg/justTcgApi'

const CACHE_TTL_MS   = 24 * 60 * 60 * 1000  // re-fetch from JustTCG every 24 h
const CACHE_EMPTY_MS =  2 * 60 * 60 * 1000  //  2 h cool-down after an API error

// Merge two sets of price points.
// Fresh data overrides existing data for the same date;
// the result is sorted ascending and deduplicated by date.
function mergePoints(existing: JustTcgPoint[], fresh: JustTcgPoint[]): JustTcgPoint[] {
  const map = new Map<string, number>()
  for (const p of existing) map.set(p.date.slice(0, 10), p.price)
  for (const p of fresh)    map.set(p.date.slice(0, 10), p.price)   // fresh wins
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, price]) => ({ date, price }))
}

/** Compute percentage change from N days ago to the most recent point. */
function trendPct(points: { date: string; price: number }[], days: number): number | null {
  if (points.length < 2) return null
  const now    = new Date(points[points.length - 1].date).getTime()
  const cutoff = now - days * 24 * 60 * 60 * 1000
  const anchor = [...points].reverse().find(p => new Date(p.date).getTime() <= cutoff)
  if (!anchor || anchor.price === 0) return null
  const latest = points[points.length - 1].price
  return ((latest - anchor.price) / anchor.price) * 100
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const catalogId = searchParams.get('catalogId')
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
    .select('catalog_id, card_name, card_number, set_name, metadata_json')
    .eq('catalog_id', catalogId)
    .single()

  if (!data) return NextResponse.json({ points: [], rateLimited: false })

  const card = data as {
    catalog_id:    string
    card_name:     string
    card_number:   string | null
    set_name:      string | null       // column — NOT inside metadata_json
    metadata_json: Record<string, unknown> | null
  }

  const meta    = card.metadata_json ?? {}
  const setName = card.set_name ?? null   // e.g. "Expedition Base Set", "Brilliant Stars"

  // ── Cache check ───────────────────────────────────────────────────────────
  // tcg_history stores ALL accumulated price points plus bookkeeping fields.
  // query_key fingerprints the search parameters used when data was fetched —
  // if it changes (e.g. set name now available), we treat the cache as stale
  // so wrong-set matches are automatically corrected on next view.
  type HistoryCache = {
    points:       JustTcgPoint[]
    fetched_at:   string
    empty_until?: string | null
    query_key?:   string   // "${card_name}|${card_number}|${set_name}"
  }

  // Build current query fingerprint
  const currentQueryKey = [
    card.card_name,
    card.card_number ?? '',
    setName ?? '',
  ].join('|')

  const cached = meta['tcg_history'] as HistoryCache | undefined

  // A cache hit is valid only if the query key matches the current card identity.
  // Mismatched key = set name wasn't known when data was last fetched → re-fetch.
  const queryKeyMatches = !cached?.query_key || cached.query_key === currentQueryKey

  if (!force && cached?.fetched_at && queryKeyMatches) {
    // Honour the API-error cool-down period
    if (cached.empty_until && Date.now() < new Date(cached.empty_until).getTime()) {
      return NextResponse.json({ points: cached.points ?? [], rateLimited: true, fromCache: true })
    }
    // Serve from cache if still fresh
    const age = Date.now() - new Date(cached.fetched_at).getTime()
    if (age < CACHE_TTL_MS && (cached.points?.length ?? 0) > 0) {
      return NextResponse.json({ points: cached.points, rateLimited: false, fromCache: true })
    }
  }

  // ── Live JustTCG fetch (always 180 d — maximum available) ─────────────────
  const fetchResult = await fetchJustTcgPriceHistory(
    card.card_name,
    card.card_number,
    setName,
    force,
  )
  const { points: freshPoints, keyword, apiError } = fetchResult as any

  // ── Merge with existing accumulated history ───────────────────────────────
  // If the query key changed (set name newly known), discard stale points from
  // the wrong card rather than merging wrong data with correct data.
  const existingPoints: JustTcgPoint[] =
    queryKeyMatches ? (cached?.points ?? []) : []

  const mergedPoints = apiError
    ? existingPoints                            // keep old data on API error
    : mergePoints(existingPoints, freshPoints)  // extend history with new data

  // ── Persist accumulated history ───────────────────────────────────────────
  try {
    const svcClient  = createServiceClient()
    const now        = new Date()

    const cachePayload: HistoryCache = apiError
      ? {
          points:      existingPoints,
          fetched_at:  now.toISOString(),
          query_key:   currentQueryKey,
          empty_until: existingPoints.length === 0
            ? new Date(Date.now() + CACHE_EMPTY_MS).toISOString()
            : null,
        }
      : {
          points:      mergedPoints,
          fetched_at:  now.toISOString(),
          query_key:   currentQueryKey,
          empty_until: null,
        }

    await svcClient
      .from('card_catalog_items')
      .update({ metadata_json: { ...meta, tcg_history: cachePayload } })
      .eq('catalog_id', catalogId)
  } catch (err) {
    console.error('[tcg-price-history] Cache write error:', err)
  }

  return NextResponse.json({
    points:      mergedPoints,
    keyword,
    rateLimited: apiError && mergedPoints.length === 0,
    trend7d:     trendPct(mergedPoints, 7),
    trend30d:    trendPct(mergedPoints, 30),
    trend90d:    trendPct(mergedPoints, 90),
  })
}
