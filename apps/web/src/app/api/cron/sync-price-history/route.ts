/**
 * Cron: Proactively refresh JustTCG price history for cards in active inventory.
 *
 * Why: History only accumulates when users open a card detail page.
 * This job ensures all inventory cards get daily history updates,
 * so sparklines stay fresh even for cards not recently viewed.
 *
 * Rate limiting: processes up to 60 cards per run with 500ms delay between
 * requests to avoid hammering the JustTCG API.
 *
 * Trigger: Add to vercel.json crons — run daily at 3 AM UTC.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchJustTcgPriceHistory, type JustTcgPoint } from '@/lib/justtcg/justTcgApi'

export const maxDuration = 300

// Cards per run. Default is FREE-TIER-SAFE for JustTCG (1,000 calls/mo, 100/day):
// 25/day ≈ 750/mo, leaving headroom for on-demand card-page views. On a paid
// JustTCG tier, raise via env: JUSTTCG_CRON_BATCH=60 (Starter 10k/mo supports
// 60-per-run even at a 6-hour cadence).
const BATCH_LIMIT   = Math.max(1, Number(process.env.JUSTTCG_CRON_BATCH ?? 25))
const DELAY_MS      = 500   // ms between JustTCG requests
const MAX_CONSECUTIVE_ERRORS = 3  // stop the run early if the quota is exhausted
const CACHE_TTL_MS  = 23 * 60 * 60 * 1000   // skip cards refreshed in last 23h
const TOP_MARKET    = 300   // also refresh the top-N catalog cards by market value
const PAGE_SIZE     = 1000  // catalog ranking page size
const MAX_PAGES     = 40    // safety cap on the ranking scan

/** Highest TCGplayer market (fallback mid) across a card's price bands. */
function bestMarket(tcg: any): number {
  const prices = tcg?.prices
  if (!prices) return 0
  let best = 0
  for (const b of Object.values(prices) as any[]) {
    const m = typeof b?.market === 'number' && b.market > 0 ? b.market
            : typeof b?.mid === 'number' && b.mid > 0 ? b.mid
            : 0
    if (m > best) best = m
  }
  return best
}

function mergePoints(
  existing: JustTcgPoint[],
  fresh: JustTcgPoint[]
): JustTcgPoint[] {
  const map = new Map<string, number>()
  for (const p of existing) map.set(p.date.slice(0, 10), p.price)
  for (const p of fresh)    map.set(p.date.slice(0, 10), p.price)
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, price]) => ({ date, price }))
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Extract the active TCGPlayer price band for a card (for printing-aware matching) */
function getActivePrinting(metadata_json: any): string | null {
  const prices = metadata_json?.tcgplayer?.prices
  if (!prices) return null
  const BANDS = ['holofoil','1stEditionHolofoil','reverseHolofoil','normal','unlimitedHolofoil','1stEditionNormal']
  for (const band of BANDS) {
    const p = prices[band]
    if (p?.market && p.market > 0) return band
    if (p?.mid    && p.mid   > 0) return band
  }
  return null
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const expected   = `Bearer ${process.env.CRON_SECRET}`
  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!process.env.JUSTTCG_API_KEY) {
    return NextResponse.json({ ok: true, skipped: 'no JUSTTCG_API_KEY' })
  }

  const supabase = createServiceClient()

  // ── Build the refresh set: active inventory + the top cards by market value ──
  // Previously ONLY inventory was covered, which is why the SDX-100 top-100 charts
  // stayed empty — nobody owns most of those cards.
  const { data: inventoryRows } = await supabase
    .from('inventory_items')
    .select('catalog_id')
    .neq('status', 'sold')
  const invIds = [...new Set((inventoryRows ?? []).map((r: any) => r.catalog_id as string))]

  // Rank the catalog by TCGplayer market price (paged light projection of just
  // the pricing subtree, so we don't pull every card's full metadata).
  const ranked: { id: string; price: number }[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data: rows, error } = await supabase
      .from('card_catalog_items')
      .select('catalog_id, tcg:metadata_json->tcgplayer')
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
    if (error || !rows?.length) break
    for (const r of rows as any[]) {
      const price = bestMarket(r.tcg)
      if (price > 0) ranked.push({ id: r.catalog_id as string, price })
    }
    if (rows.length < PAGE_SIZE) break
  }
  const topIds = ranked.sort((a, b) => b.price - a.price).slice(0, TOP_MARKET).map((x) => x.id)

  const candidateIds = [...new Set([...invIds, ...topIds])]
  if (candidateIds.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, reason: 'no candidates' })
  }

  // Fetch full card data, then refresh the BATCH_LIMIT least-recently-updated
  // ones so coverage rotates across runs (every 6h).
  const { data: allCards } = await supabase
    .from('card_catalog_items')
    .select('catalog_id, card_name, card_number, set_name, metadata_json')
    .in('catalog_id', candidateIds)

  const lastFetchedMs = (c: any) => {
    const f = c.metadata_json?.tcg_history?.fetched_at as string | undefined
    return f ? new Date(f).getTime() : 0
  }
  const cards = (allCards ?? [])
    .sort((a: any, b: any) => lastFetchedMs(a) - lastFetchedMs(b))
    .slice(0, BATCH_LIMIT)

  if (!cards.length) {
    return NextResponse.json({ ok: true, processed: 0 })
  }

  let processed = 0
  let skipped   = 0
  let errors    = 0
  let consecutiveErrors = 0
  let stoppedEarly = false
  const now     = Date.now()

  for (const card of cards) {
    // A run of straight failures almost always means the daily/monthly quota
    // is exhausted — stop instead of burning more calls on errors.
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      stoppedEarly = true
      break
    }
    const meta        = (card.metadata_json ?? {}) as Record<string, any>
    const cached      = meta['tcg_history'] as { fetched_at?: string; points?: JustTcgPoint[] } | undefined
    const lastFetched = cached?.fetched_at ? new Date(cached.fetched_at).getTime() : 0

    // Skip if refreshed recently
    if (now - lastFetched < CACHE_TTL_MS) {
      skipped++
      continue
    }

    try {
      const knownPrinting = getActivePrinting(meta)
      const result = await fetchJustTcgPriceHistory(
        card.card_name,
        card.card_number,
        card.set_name,
        false,
        knownPrinting,
      )

      if (result.apiError) { errors++; consecutiveErrors++; continue }
      consecutiveErrors = 0

      const existingPoints: JustTcgPoint[] = cached?.points ?? []
      const mergedPoints = mergePoints(existingPoints, result.points)

      const queryKey = [card.card_name, card.card_number ?? '', card.set_name ?? ''].join('|')
      const cachePayload = {
        points:      mergedPoints,
        fetched_at:  new Date().toISOString(),
        query_key:   queryKey,
        empty_until: null,
      }

      await supabase
        .from('card_catalog_items')
        .update({ metadata_json: { ...meta, tcg_history: cachePayload } })
        .eq('catalog_id', card.catalog_id)

      processed++
    } catch (err) {
      console.error(`[cron/sync-price-history] Error for ${card.card_name}:`, err)
      errors++
      consecutiveErrors++
    }

    await sleep(DELAY_MS)
  }

  return NextResponse.json({
    ok: true,
    processed,
    skipped,
    errors,
    stoppedEarly,
    batchLimit: BATCH_LIMIT,
    total: cards.length,
  })
}
