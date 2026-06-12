/**
 * GET /api/cards/pricecharting?catalogId=...
 *
 * Fetches a current price snapshot from PriceCharting.com.
 * Requires PRICECHARTING_API_TOKEN env var (free tier available at
 * https://www.pricecharting.com/api).
 *
 * If the env var is not set, returns { configured: false } so the UI
 * can show a "connect" prompt rather than an error.
 *
 * Prices from PriceCharting are in USD cents in the API response.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'

const CACHE_TTL_MS   = 24 * 60 * 60 * 1000  // 24 h
const CACHE_EMPTY_MS =  4 * 60 * 60 * 1000  //  4 h cooldown after empty result

export interface PriceChartingSnapshot {
  id:          number
  name:        string
  loosePrice:  number | null   // ungraded / raw
  gradedPrice: number | null   // generic "graded" bucket
  psa10Price:  number | null
  psa9Price:   number | null
  url:         string | null
}

export async function GET(req: NextRequest) {
  const catalogId = req.nextUrl.searchParams.get('catalogId')
  if (!catalogId) return NextResponse.json({ error: 'catalogId required' }, { status: 400 })

  if (!process.env.PRICECHARTING_API_TOKEN) {
    return NextResponse.json({ configured: false, snapshot: null })
  }

  const supabase = await createClient()
  const { data: card } = await supabase
    .from('card_catalog_items')
    .select('catalog_id, card_name, card_number, set_name, metadata_json')
    .eq('catalog_id', catalogId)
    .single()

  if (!card) return NextResponse.json({ error: 'Card not found' }, { status: 404 })

  const meta = (card.metadata_json ?? {}) as Record<string, unknown>

  // ── Cache check ─────────────────────────────────────────────────────────────
  type Cache = PriceChartingSnapshot & { fetched_at: string; empty_until?: string }
  const cached = meta['pc_cache'] as Cache | undefined
  if (cached?.fetched_at) {
    if (cached.empty_until && Date.now() < new Date(cached.empty_until).getTime()) {
      return NextResponse.json({ snapshot: null, fromCache: true, configured: true })
    }
    const age = Date.now() - new Date(cached.fetched_at).getTime()
    if (age < CACHE_TTL_MS && cached.loosePrice != null) {
      const { fetched_at: _, empty_until: __, ...snap } = cached
      return NextResponse.json({ snapshot: snap, fromCache: true, configured: true })
    }
  }

  // ── Search PriceCharting ────────────────────────────────────────────────────
  const q = [card.card_name, card.card_number, card.set_name].filter(Boolean).join(' ')

  try {
    const token = process.env.PRICECHARTING_API_TOKEN
    const searchRes = await fetch(
      `https://www.pricecharting.com/api/products?q=${encodeURIComponent(q)}&status=price&access_token=${token}`,
      { next: { revalidate: 86400 } },
    )
    if (!searchRes.ok) throw new Error(`PriceCharting search HTTP ${searchRes.status}`)
    const { products = [] } = await searchRes.json()

    if (!products.length) {
      const svc = createServiceClient()
      await svc.from('card_catalog_items').update({
        metadata_json: {
          ...meta,
          pc_cache: {
            fetched_at: new Date().toISOString(),
            empty_until: new Date(Date.now() + CACHE_EMPTY_MS).toISOString(),
            id: 0, name: q, loosePrice: null, gradedPrice: null,
            psa10Price: null, psa9Price: null, url: null,
          },
        },
      }).eq('catalog_id', catalogId)
      return NextResponse.json({ snapshot: null, configured: true })
    }

    // Best-match: prefer exact card_name match
    const norm = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim()
    const normTarget = norm(card.card_name)
    const product =
      products.find((p: any) => norm(p['product-name'] ?? '').includes(normTarget)) ??
      products[0]

    // PriceCharting prices are in cents
    const usd = (cents: number | null | undefined): number | null =>
      cents != null && cents > 0 ? Math.round(cents) / 100 : null

    const snapshot: PriceChartingSnapshot = {
      id:          product.id,
      name:        product['product-name'] ?? q,
      loosePrice:  usd(product['loose-price']),
      gradedPrice: usd(product['graded-price']),
      // PriceCharting exposes grade-specific prices in the full product detail;
      // the search endpoint may include `graded-price` for the top grade bucket.
      psa10Price:  usd(product['manual-only-price'] ?? product['graded-price']),
      psa9Price:   usd(product['cib-price']),
      url: product.id
        ? `https://www.pricecharting.com/game/pokemon-${encodeURIComponent(
            (product['console-name'] ?? 'cards').toLowerCase().replace(/\s+/g, '-'),
          )}/${encodeURIComponent(
            (product['product-name'] ?? '').toLowerCase().replace(/\s+/g, '-'),
          )}`
        : null,
    }

    const svc = createServiceClient()
    await svc.from('card_catalog_items').update({
      metadata_json: { ...meta, pc_cache: { ...snapshot, fetched_at: new Date().toISOString() } },
    }).eq('catalog_id', catalogId)

    return NextResponse.json({ snapshot, configured: true })
  } catch (err) {
    console.error('[PriceCharting] fetch error:', err)
    return NextResponse.json({ snapshot: null, configured: true, error: 'fetch_failed' })
  }
}
