// GET /api/cards/sold-history?catalogId=123[&lang=en|jp][&force=1]
// Returns up to 90 days of eBay completed-sale data for charting.
// Results are cached in card metadata_json for 24 hours to protect eBay rate limits.

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { fetchEbayComps, buildKeyword } from '@/lib/ebay/findingApi'

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000
const CACHE_TTL_MS   = 24 * 60 * 60 * 1000  // 24 hours

const GRADED_RE = /\b(PSA|BGS|SGC|CGC|GRADED|SLAB)\b/i
const GRADE_RE  = /\b(PSA|BGS|CGC|SGC)\s+(\d+(?:\.\d)?)\b/i

export interface SalePoint {
  date:    string   // ISO string
  price:   number
  title:   string
  graded:  boolean
  grader?: string   // 'PSA' | 'BGS' | 'CGC' | 'SGC'
  grade?:  number   // 10 | 9.5 | 9 | 8 | 7 | etc.
}

function parseGrade(title: string): { grader?: string; grade?: number } {
  const m = GRADE_RE.exec(title)
  if (!m) return {}
  return { grader: m[1].toUpperCase(), grade: parseFloat(m[2]) }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const catalogIdStr = searchParams.get('catalogId')
  const keywordParam = searchParams.get('keyword')
  const lang         = (searchParams.get('lang') ?? 'en') as 'en' | 'jp'
  const force        = searchParams.get('force') === '1'

  if (!catalogIdStr && !keywordParam) {
    return NextResponse.json({ error: 'catalogId or keyword required' }, { status: 400 })
  }

  let keyword  = keywordParam ?? ''
  let card: Record<string, unknown> | null = null

  if (catalogIdStr) {
    const supabase = await createClient()
    const { data } = await supabase
      .from('card_catalog_items')
      .select('catalog_id, card_name, franchise_or_brand, set_name, year, card_number, variant, metadata_json')
      .eq('catalog_id', catalogIdStr)
      .single()
    card = data as Record<string, unknown> | null
    if (card) keyword = buildKeyword(card as any, lang)
  }

  if (!keyword.trim()) {
    return NextResponse.json({ points: [], keyword: '', lang })
  }

  // ── DB cache check ──────────────────────────────────────────────────────────
  if (card && !force) {
    const cacheKey = lang === 'en' ? 'ebay_en_cache' : 'ebay_jp_cache'
    const meta     = card.metadata_json as Record<string, unknown> | null
    const cached   = meta?.[cacheKey] as { points: SalePoint[]; fetched_at: string } | undefined
    if (cached?.fetched_at) {
      const age = Date.now() - new Date(cached.fetched_at).getTime()
      if (age < CACHE_TTL_MS) {
        return NextResponse.json({
          points:  cached.points,
          keyword,
          lang,
          total:   cached.points.length,
          fromCache: true,
        })
      }
    }
  }

  // ── Live eBay fetch ──────────────────────────────────────────────────────────
  const rawComps = await fetchEbayComps(keyword)
  const cutoff   = Date.now() - NINETY_DAYS_MS

  const points: SalePoint[] = rawComps
    .filter((c) => c.soldAt && c.soldAt.getTime() >= cutoff)
    .map((c) => {
      const graded = GRADED_RE.test(c.title)
      const { grader, grade } = graded ? parseGrade(c.title) : {}
      return {
        date:   c.soldAt!.toISOString(),
        price:  c.soldPrice,
        title:  c.title,
        graded,
        ...(grader ? { grader } : {}),
        ...(grade  ? { grade  } : {}),
      }
    })
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  // ── Write back to DB cache ─────────────────────────────────────────────────
  if (card && catalogIdStr && rawComps.length > 0) {
    try {
      const svcClient = createServiceClient()
      const cacheKey  = lang === 'en' ? 'ebay_en_cache' : 'ebay_jp_cache'
      const existingMeta = (card.metadata_json as Record<string, unknown>) ?? {}
      await svcClient
        .from('card_catalog_items')
        .update({
          metadata_json: {
            ...existingMeta,
            [cacheKey]: { points, fetched_at: new Date().toISOString() },
          },
        })
        .eq('catalog_id', catalogIdStr)
    } catch (err) {
      console.error('[sold-history] Cache write error:', err)
    }
  }

  return NextResponse.json({ points, keyword, lang, total: rawComps.length })
}
