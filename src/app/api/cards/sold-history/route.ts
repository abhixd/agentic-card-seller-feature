// GET /api/cards/sold-history?catalogId=123[&lang=en|jp]
// Returns up to 90 days of eBay completed-sale data for charting.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { fetchEbayComps, buildKeyword } from '@/lib/ebay/findingApi'

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000
const GRADED_RE = /\b(PSA|BGS|SGC|CGC|GRADED|SLAB)\b/i

export interface SalePoint {
  date:   string   // ISO string
  price:  number
  title:  string
  graded: boolean
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const catalogIdStr = searchParams.get('catalogId')
  const keywordParam = searchParams.get('keyword')
  const lang         = (searchParams.get('lang') ?? 'en') as 'en' | 'jp'

  if (!catalogIdStr && !keywordParam) {
    return NextResponse.json({ error: 'catalogId or keyword required' }, { status: 400 })
  }

  let keyword = keywordParam ?? ''

  if (catalogIdStr) {
    const supabase = await createClient()
    const { data: card } = await supabase
      .from('card_catalog_items')
      .select('card_name, franchise_or_brand, set_name, year, card_number, variant')
      .eq('catalog_id', catalogIdStr)
      .single()

    if (card) keyword = buildKeyword(card, lang)
  }

  if (!keyword.trim()) {
    return NextResponse.json({ points: [], keyword: '', lang })
  }

  const rawComps = await fetchEbayComps(keyword)
  const cutoff   = Date.now() - NINETY_DAYS_MS

  const points: SalePoint[] = rawComps
    .filter((c) => c.soldAt && c.soldAt.getTime() >= cutoff)
    .map((c) => ({
      date:   c.soldAt!.toISOString(),
      price:  c.soldPrice,
      title:  c.title,
      graded: GRADED_RE.test(c.title),
    }))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  return NextResponse.json({ points, keyword, lang, total: rawComps.length })
}
