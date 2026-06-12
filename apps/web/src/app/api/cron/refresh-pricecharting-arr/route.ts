/**
 * Cron: Weekly refresh of PriceCharting ARR metrics.
 *
 * Only re-fetches sets where last_updated < now() - 6 days, so re-runs
 * within the same week are safe no-ops for already-fresh sets.
 *
 * Schedule (vercel.json): "0 3 * * 0" — Sundays at 3 AM UTC
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export const maxDuration = 300

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function findClosestPrice(
  history: Array<[number, number]>,
  targetMs: number,
): number | null {
  if (!history?.length) return null
  let best: number | null = null
  let bestDiff = Infinity
  for (const [ts, priceCents] of history) {
    const diff = Math.abs(ts - targetMs)
    if (diff < bestDiff) {
      bestDiff = diff
      best = priceCents
    }
  }
  return best != null ? best / 100 : null
}

function computeCagr(
  currentPrice: number,
  pastPrice: number | null,
  years: number,
): number | null {
  if (!pastPrice || pastPrice <= 0 || currentPrice <= 0 || years <= 0) return null
  return (Math.pow(currentPrice / pastPrice, 1 / years) - 1) * 100
}

function assignGrade(cagr1yr: number | null): string {
  if (cagr1yr == null) return 'N/A'
  if (cagr1yr >  30) return 'A+'
  if (cagr1yr >  15) return 'A'
  if (cagr1yr >   8) return 'B+'
  if (cagr1yr >   3) return 'B'
  if (cagr1yr >=  0) return 'C'
  if (cagr1yr > -10) return 'D'
  return 'F'
}

const PC_BASE = 'https://www.pricecharting.com/api'

async function pcSearch(cardName: string, setName: string) {
  const q = encodeURIComponent(`${cardName} ${setName} pokemon`)
  const res = await fetch(`${PC_BASE}/products?q=${q}&status=price-history`)
  if (!res.ok) return null
  return res.json()
}

async function pcPriceHistory(productId: string | number) {
  const res = await fetch(`${PC_BASE}/product?id=${productId}&status=price-history`)
  if (!res.ok) return null
  return res.json()
}

const PRICE_BANDS = [
  'holofoil',
  '1stEditionHolofoil',
  'reverseHolofoil',
  'normal',
  'unlimitedHolofoil',
  '1stEditionNormal',
]

function getMarketPrice(metadata_json: any): number {
  const prices = metadata_json?.tcgplayer?.prices
  if (!prices) return 0
  for (const band of PRICE_BANDS) {
    const p = prices[band]
    if (p?.market && p.market > 0) return p.market
  }
  return 0
}

// ── Route Handler ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  // Only process sets not updated in the last 6 days
  const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString()

  const { data: staleMetrics, error: metricsErr } = await supabase
    .from('set_investment_metrics')
    .select('set_name')
    .or(`last_updated.is.null,last_updated.lt.${sixDaysAgo}`)

  if (metricsErr) {
    console.error('[cron/refresh-pricecharting-arr] metrics query error:', metricsErr.message)
    return NextResponse.json({ error: metricsErr.message }, { status: 500 })
  }

  // Also include sets that have catalog cards but no metrics row yet
  const { data: allSetRows } = await supabase
    .from('card_catalog_items')
    .select('set_name')

  const knownStaleSets = new Set(staleMetrics?.map((r: any) => r.set_name) ?? [])

  // Count cards per set from catalog
  const setCounts: Record<string, number> = {}
  for (const row of allSetRows ?? []) {
    if (!row.set_name) continue
    setCounts[row.set_name] = (setCounts[row.set_name] ?? 0) + 1
  }

  // Top 20 sets with no fresh metrics
  const setsToProcess = Object.entries(setCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([name]) => name)
    .filter((name) => knownStaleSets.has(name) || !staleMetrics?.find((r: any) => r.set_name === name))

  if (setsToProcess.length === 0) {
    return NextResponse.json({ updated: 0, note: 'All sets are fresh' })
  }

  const now        = Date.now()
  const ONE_YR_MS  = 365 * 24 * 60 * 60 * 1000
  const THREE_YR_MS = 3 * ONE_YR_MS
  const FIVE_YR_MS  = 5 * ONE_YR_MS

  let updated = 0

  for (const setName of setsToProcess) {
    const { data: cards } = await supabase
      .from('card_catalog_items')
      .select('catalog_id, card_name, set_name, metadata_json')
      .eq('set_name', setName)

    if (!cards?.length) continue

    const ranked = cards
      .map((c: any) => ({ ...c, marketPrice: getMarketPrice(c.metadata_json) }))
      .filter((c: any) => c.marketPrice > 0)
      .sort((a: any, b: any) => b.marketPrice - a.marketPrice)
      .slice(0, 5)

    if (!ranked.length) continue

    const cagrResults: number[] = []

    for (const card of ranked) {
      await sleep(500)

      let searchResult: any
      try {
        searchResult = await pcSearch(card.card_name, setName)
      } catch {
        continue
      }

      if (!searchResult?.products?.length) continue

      const match = searchResult.products.find(
        (p: any) =>
          p['product-type'] === 'game' &&
          typeof p['console-name'] === 'string' &&
          p['console-name'].toLowerCase().includes('pokemon'),
      )
      if (!match) continue

      await sleep(500)

      let historyResult: any
      try {
        historyResult = await pcPriceHistory(match.id)
      } catch {
        continue
      }

      const history: Array<[number, number]> = historyResult?.prices
      if (!history?.length) continue

      const latestEntry  = history[history.length - 1]
      const currentPrice = latestEntry[1] / 100
      const priceDate    = new Date(latestEntry[0]).toISOString().slice(0, 10)

      const price1yrAgo = findClosestPrice(history, now - ONE_YR_MS)
      const price3yrAgo = findClosestPrice(history, now - THREE_YR_MS)
      const price5yrAgo = findClosestPrice(history, now - FIVE_YR_MS)

      const cagr1yr = computeCagr(currentPrice, price1yrAgo,  1)
      const cagr3yr = computeCagr(currentPrice, price3yrAgo,  3)
      const cagr5yr = computeCagr(currentPrice, price5yrAgo,  5)

      if (cagr1yr != null) cagrResults.push(cagr1yr)

      await supabase
        .from('pricecharting_history')
        .upsert(
          {
            catalog_id:           card.catalog_id,
            pricecharting_id:     String(match.id),
            card_name:            card.card_name,
            set_name:             setName,
            price_date:           priceDate,
            current_price:        currentPrice,
            price_1yr_ago:        price1yrAgo,
            price_3yr_ago:        price3yrAgo,
            price_5yr_ago:        price5yrAgo,
            cagr_1yr:             cagr1yr != null ? Math.round(cagr1yr * 100) / 100 : null,
            cagr_3yr:             cagr3yr != null ? Math.round(cagr3yr * 100) / 100 : null,
            cagr_5yr:             cagr5yr != null ? Math.round(cagr5yr * 100) / 100 : null,
            raw_history_snapshot: history.slice(-365),
            fetched_at:           new Date().toISOString(),
          },
          { onConflict: 'catalog_id,price_date' },
        )
    }

    if (!cagrResults.length) continue

    const avgCagr1yr = cagrResults.reduce((s, v) => s + v, 0) / cagrResults.length
    const grade      = assignGrade(avgCagr1yr)

    const { error: upsertErr } = await supabase
      .from('set_investment_metrics')
      .upsert(
        {
          set_name:         setName,
          avg_cagr_1yr:     Math.round(avgCagr1yr * 100) / 100,
          investment_grade: grade,
          cards_sampled:    cagrResults.length,
          last_updated:     new Date().toISOString(),
        },
        { onConflict: 'set_name' },
      )

    if (!upsertErr) {
      updated++
      console.log(
        `[cron/refresh-pricecharting-arr] ✓ ${setName} — avg CAGR 1yr: ${avgCagr1yr.toFixed(1)}% (${grade})`,
      )
    }
  }

  return NextResponse.json({ updated })
}
