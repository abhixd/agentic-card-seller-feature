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

const BATCH_LIMIT   = 60    // max cards per run
const DELAY_MS      = 500   // ms between JustTCG requests
const CACHE_TTL_MS  = 23 * 60 * 60 * 1000   // skip cards refreshed in last 23h

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

  // Fetch unique catalog IDs from active inventory across all users
  const { data: inventoryRows, error: invErr } = await supabase
    .from('inventory_items')
    .select('catalog_id')
    .neq('status', 'sold')

  if (invErr || !inventoryRows?.length) {
    return NextResponse.json({ ok: true, processed: 0, reason: 'no active inventory' })
  }

  // Unique catalog IDs
  const uniqueIds = [...new Set(inventoryRows.map((r: any) => r.catalog_id as string))]

  // Fetch card data for these catalog IDs
  const { data: cards } = await supabase
    .from('card_catalog_items')
    .select('catalog_id, card_name, card_number, set_name, metadata_json')
    .in('catalog_id', uniqueIds.slice(0, BATCH_LIMIT))

  if (!cards?.length) {
    return NextResponse.json({ ok: true, processed: 0 })
  }

  let processed = 0
  let skipped   = 0
  let errors    = 0
  const now     = Date.now()

  for (const card of cards) {
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

      if (result.apiError) { errors++; continue }

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
    }

    await sleep(DELAY_MS)
  }

  return NextResponse.json({
    ok: true,
    processed,
    skipped,
    errors,
    total: cards.length,
  })
}
