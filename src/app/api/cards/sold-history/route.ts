// GET /api/cards/sold-history?catalogId=123[&lang=en|jp][&force=1]
// Returns up to 90 days of eBay completed-sale data for charting.
// Results are cached in card metadata_json for 24 hours to protect eBay rate limits.

import { NextRequest, NextResponse, after } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { fetchEbayComps, buildKeyword } from '@/lib/ebay/findingApi'

const NINETY_DAYS_MS    = 90 * 24 * 60 * 60 * 1000
const CACHE_TTL_MS      = 24 * 60 * 60 * 1000  // 24h for real data
const CACHE_EMPTY_MS    =  2 * 60 * 60 * 1000  //  2h for rate-limited / empty

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
    const cached   = meta?.[cacheKey] as {
      points: SalePoint[]
      fetched_at: string
      empty_until?: string   // set when eBay was rate-limited; retry after this time
    } | undefined

    if (cached?.fetched_at) {
      // Rate-limited response cached with short TTL — don't retry until window expires
      if (cached.empty_until && Date.now() < new Date(cached.empty_until).getTime()) {
        return NextResponse.json({ points: [], keyword, lang, total: 0, fromCache: true, rateLimited: true })
      }
      // Successful cache hit — return if still fresh (even if 0 results)
      const age = Date.now() - new Date(cached.fetched_at).getTime()
      if (age < CACHE_TTL_MS) {
        return NextResponse.json({ points: cached.points, keyword, lang, total: cached.points.length, fromCache: true })
      }
    }
  }

  // ── Live eBay fetch ──────────────────────────────────────────────────────────
  // Pass force=true so a manual refresh bypasses the Next.js 8h fetch cache too.
  const { comps: rawComps, apiError } = await fetchEbayComps(keyword, force)
  const cutoff = Date.now() - NINETY_DAYS_MS

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

  // ── Write back to DB cache ────────────────────────────────────────────────
  // - API error (rate limit / auth failure): cache with 2h empty_until so we
  //   back off and surface the amber warning.
  // - Success with 0 results (genuine no data): cache for full 24h, no warning.
  // - Success with results: cache for 24h.
  if (card && catalogIdStr) {
    try {
      const svcClient    = createServiceClient()
      const cacheKey     = lang === 'en' ? 'ebay_en_cache' : 'ebay_jp_cache'
      const existingMeta = (card.metadata_json as Record<string, unknown>) ?? {}
      const now          = new Date()

      const cachePayload = apiError
        ? {
            points:      [],
            fetched_at:  now.toISOString(),
            empty_until: new Date(Date.now() + CACHE_EMPTY_MS).toISOString(),
          }
        : {
            points,
            fetched_at: now.toISOString(),
            // Clear any stale empty_until from a previous rate-limit period
            empty_until: null,
          }

      await svcClient
        .from('card_catalog_items')
        .update({ metadata_json: { ...existingMeta, [cacheKey]: cachePayload } })
        .eq('catalog_id', catalogIdStr)
    } catch (err) {
      console.error('[sold-history] Cache write error:', err)
    }
  }

  // ── Persist sold listings to ebay_sold_history (post-response, non-blocking) ─
  if (card && catalogIdStr && !apiError && rawComps.length > 0) {
    const cardName = (card.card_name as string) ?? ''
    const setName  = (card.set_name  as string) ?? ''
    after(async () => {
      try {
        const svc = createServiceClient()
        const rows = rawComps
          .filter((c) => c.soldAt && c.soldPrice > 0)
          .map((c) => {
            // Extract eBay item ID from the viewItemURL  e.g. https://www.ebay.com/itm/123456789
            const itemIdMatch = c.sourceUrl.match(/\/itm\/(\d+)/)
            const ebayItemId  = itemIdMatch ? itemIdMatch[1] : c.sourceUrl

            // Derive condition label from title keywords
            const t    = c.title.toLowerCase()
            const cond = /\b(psa|bgs|sgc|cgc)\b/.test(t)
              ? 'Graded'
              : /\bNM\b|near.?mint/i.test(c.title)
              ? 'Near Mint'
              : /\bLP\b|lightly.?played/i.test(c.title)
              ? 'Lightly Played'
              : /\bMP\b|moderately.?played/i.test(c.title)
              ? 'Moderately Played'
              : /\bHP\b|heavily.?played/i.test(c.title)
              ? 'Heavily Played'
              : /\bdamaged/i.test(c.title)
              ? 'Damaged'
              : 'Unspecified'

            return {
              catalog_id:   catalogIdStr,
              card_name:    cardName,
              set_name:     setName,
              ebay_item_id: ebayItemId,
              sold_price:   c.soldPrice,
              currency:     'USD',
              condition:    cond,
              title:        c.title,
              listing_url:  c.sourceUrl,
              sold_at:      c.soldAt!.toISOString(),
            }
          })

        if (rows.length > 0) {
          const { error } = await svc
            .from('ebay_sold_history')
            .upsert(rows, { onConflict: 'ebay_item_id', ignoreDuplicates: true })
          if (error) {
            console.error('[sold-history] ebay_sold_history upsert error:', error.message)
          } else {
            console.log(`[sold-history] stored ${rows.length} listings for catalog_id=${catalogIdStr}`)
          }
        }
      } catch (err) {
        console.error('[sold-history] after() persistence error:', err)
      }
    })
  }

  return NextResponse.json({
    points,
    keyword,
    lang,
    total:       rawComps.length,
    rateLimited: apiError,
  })
}
