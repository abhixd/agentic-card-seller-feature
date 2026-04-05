/**
 * GET /api/cards/forecast?catalogId=...&source=tcg|ebay&horizon=30[&force=1]
 *
 * Source-agnostic Prophet forecasting endpoint.
 * Reads whichever price cache is available for the requested source,
 * normalises it into daily {date, price} points, calls the Prophet
 * microservice, caches the result for 24 h, and returns it.
 *
 * Adding a new source later:  implement a `PriceExtractor` below and
 * add one entry to the SOURCE_EXTRACTORS map — nothing else changes.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import type { SalePoint } from '@/app/api/cards/sold-history/route'
import type { JustTcgPoint } from '@/lib/justtcg/justTcgApi'

export const runtime = 'nodejs'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ForecastSource  = 'tcg' | 'ebay'
export type ForecastHorizon = 7 | 30 | 90 | 180

export interface DailyPoint  { date: string; price: number }
export interface ForecastPoint  { date: string; yhat: number; lower: number; upper: number }
export interface ChangePoint    { date: string; delta: number }

interface CacheEntry {
  forecast:     ForecastPoint[]
  fitted:       ForecastPoint[]
  changepoints: ChangePoint[]
  fetched_at:   string
}

interface ProphetResponse {
  forecast:     ForecastPoint[]
  fitted:       ForecastPoint[]
  changepoints: ChangePoint[]
  model_info:   Record<string, unknown>
}

// ── Source extractors ─────────────────────────────────────────────────────────
//
// Each extractor knows:
//   cacheKeys  – metadata_json keys to try (in preference order)
//   warmPath   – API path to call if the cache is cold
//   toPoints   – how to normalise the raw cache data into DailyPoint[]
//
// eBay sales are individual transactions; we aggregate to daily median price
// so Prophet sees one value per day (same as TCG data).

type PriceExtractor = {
  cacheKeys: string[]
  warmPath:  (catalogId: string) => string
  toPoints:  (raw: unknown) => DailyPoint[]
}

function dailyMedian(points: DailyPoint[]): DailyPoint[] {
  const byDay = new Map<string, number[]>()
  for (const p of points) {
    const day = p.date.slice(0, 10)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day)!.push(p.price)
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, prices]) => {
      const sorted = [...prices].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      const median = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid]
      return { date, price: Math.round(median * 100) / 100 }
    })
}

const SOURCE_EXTRACTORS: Record<ForecastSource, PriceExtractor> = {
  tcg: {
    // tcg_history is the accumulating key written by /api/cards/tcg-price-history.
    // Legacy duration-specific keys are tried as fallback for backward compat.
    cacheKeys: ['tcg_history', 'tcg_cache_180d', 'tcg_cache_90d', 'tcg_cache_30d'],
    warmPath:  (id) => `/api/cards/tcg-price-history?catalogId=${id}`,
    toPoints:  (raw) => {
      const cache = raw as { points?: JustTcgPoint[] } | undefined
      return (cache?.points ?? []).map((p) => ({
        date:  p.date.slice(0, 10),
        price: p.price,
      }))
    },
  },
  ebay: {
    // eBay caches EN raw + graded sales together under ebay_en_cache
    cacheKeys: ['ebay_en_cache'],
    warmPath:  (id) => `/api/cards/sold-history?catalogId=${id}&lang=en`,
    toPoints:  (raw) => {
      const cache = raw as { points?: SalePoint[] } | undefined
      const sales = (cache?.points ?? [])
        .filter((p) => !p.graded)          // raw ungraded sales only
        .map((p) => ({ date: p.date.slice(0, 10), price: p.price }))
      // Aggregate to daily median — eBay has multiple sales per day
      return dailyMedian(sales)
    },
  },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_HORIZONS = new Set<number>([7, 30, 90, 180])
const CACHE_TTL_MS   = 24 * 60 * 60 * 1000

function cacheKey(source: ForecastSource, horizon: number) {
  return `forecast_${source}_${horizon}d`
}

function extractPoints(
  meta: Record<string, unknown>,
  extractor: PriceExtractor,
): DailyPoint[] {
  for (const key of extractor.cacheKeys) {
    const raw = meta[key]
    if (raw) {
      const pts = extractor.toPoints(raw)
      if (pts.length > 0) return pts
    }
  }
  return []
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const catalogId  = searchParams.get('catalogId')
  const sourceRaw  = searchParams.get('source') ?? 'tcg'
  const horizonRaw = parseInt(searchParams.get('horizon') ?? '30', 10)
  const force      = searchParams.get('force') === '1'

  if (!catalogId) {
    return NextResponse.json({ error: 'catalogId required' }, { status: 400 })
  }

  const source = (sourceRaw === 'ebay' ? 'ebay' : 'tcg') as ForecastSource
  const horizon = (VALID_HORIZONS.has(horizonRaw) ? horizonRaw : 30) as ForecastHorizon

  const serviceUrl = process.env.FORECAST_SERVICE_URL
  if (!serviceUrl) {
    return NextResponse.json(
      { error: 'Forecast service not configured. Set FORECAST_SERVICE_URL.' },
      { status: 503 }
    )
  }

  const extractor = SOURCE_EXTRACTORS[source]

  // ── Read card from DB ──────────────────────────────────────────────────────
  const supabase = await createClient()
  const { data: card } = await supabase
    .from('card_catalog_items')
    .select('catalog_id, metadata_json')
    .eq('catalog_id', catalogId)
    .single()

  if (!card) {
    return NextResponse.json({ error: 'Card not found' }, { status: 404 })
  }

  let meta: Record<string, unknown> = (card.metadata_json as Record<string, unknown>) ?? {}
  const key = cacheKey(source, horizon)

  // ── Serve from cache ───────────────────────────────────────────────────────
  if (!force) {
    const cached = meta[key] as CacheEntry | undefined
    if (cached?.fetched_at) {
      const age = Date.now() - new Date(cached.fetched_at).getTime()
      if (age < CACHE_TTL_MS) {
        return NextResponse.json({
          forecast:     cached.forecast,
          fitted:       cached.fitted,
          changepoints: cached.changepoints,
          fromCache:    true,
        })
      }
    }
  }

  // ── Build daily price series ───────────────────────────────────────────────
  let points = extractPoints(meta, extractor)

  // Cache is cold — warm it via the data route then retry
  if (points.length < 10) {
    const origin = req.nextUrl.origin
    const warmHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
    if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
      warmHeaders['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
    }
    await fetch(`${origin}${extractor.warmPath(catalogId)}`, { cache: 'no-store', headers: warmHeaders })

    const { data: refreshed } = await supabase
      .from('card_catalog_items')
      .select('metadata_json')
      .eq('catalog_id', catalogId)
      .single()

    meta   = (refreshed?.metadata_json as Record<string, unknown>) ?? meta
    points = extractPoints(meta, extractor)
  }

  if (points.length < 10) {
    return NextResponse.json(
      { error: `Not enough price data for forecasting (need ≥ 10, have ${points.length})` },
      { status: 422 }
    )
  }

  // ── Call Prophet microservice ──────────────────────────────────────────────
  let serviceData: ProphetResponse
  try {
    const res = await fetch(`${serviceUrl}/forecast`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        points,
        horizon,
        secret: process.env.FORECAST_API_SECRET ?? '',
      }),
      cache: 'no-store',
    })

    if (!res.ok) {
      const text = await res.text()
      console.error('[forecast] Prophet service error:', res.status, text)
      return NextResponse.json({ error: 'Forecast service returned an error' }, { status: 502 })
    }

    serviceData = await res.json()
  } catch (err) {
    console.error('[forecast] Prophet service unreachable:', err)
    return NextResponse.json({ error: 'Forecast service unreachable' }, { status: 503 })
  }

  // ── Cache result in Supabase ───────────────────────────────────────────────
  const entry: CacheEntry = {
    forecast:     serviceData.forecast,
    fitted:       serviceData.fitted,
    changepoints: serviceData.changepoints,
    fetched_at:   new Date().toISOString(),
  }

  const serviceClient = createServiceClient()
  await serviceClient
    .from('card_catalog_items')
    .update({ metadata_json: { ...meta, [key]: entry } })
    .eq('catalog_id', catalogId)

  return NextResponse.json({
    forecast:     serviceData.forecast,
    fitted:       serviceData.fitted,
    changepoints: serviceData.changepoints,
    model_info:   serviceData.model_info,
    fromCache:    false,
  })
}
