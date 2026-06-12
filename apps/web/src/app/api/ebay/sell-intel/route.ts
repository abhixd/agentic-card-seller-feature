import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import { fetchEbayComps, buildKeyword } from '@/lib/ebay/findingApi'
import type { RawEbayComp } from '@/lib/ebay/normalizeComps'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Price statistics ────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const idx = (p / 100) * (sorted.length - 1)
  const lo  = Math.floor(idx)
  const hi  = Math.ceil(idx)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function trendVelocity(comps: RawEbayComp[]): { trendPct: number; recentMedian: number; priorMedian: number } {
  const now      = Date.now()
  const ms30     = 30 * 24 * 60 * 60 * 1000
  const ms60     = 60 * 24 * 60 * 60 * 1000

  const recent = comps.filter(c => c.soldAt && (now - c.soldAt.getTime()) <= ms30).map(c => c.soldPrice)
  const prior  = comps.filter(c => c.soldAt && (now - c.soldAt.getTime()) > ms30 && (now - c.soldAt.getTime()) <= ms60).map(c => c.soldPrice)

  if (!recent.length || !prior.length) return { trendPct: 0, recentMedian: 0, priorMedian: 0 }

  recent.sort((a, b) => a - b)
  prior.sort((a, b) => a - b)
  const recentMedian = percentile(recent, 50)
  const priorMedian  = percentile(prior, 50)
  const trendPct     = priorMedian > 0 ? Math.round(((recentMedian - priorMedian) / priorMedian) * 100) : 0

  return { trendPct, recentMedian, priorMedian }
}

// ── Build the intelligence prompt ───────────────────────────────────────────

function buildPrompt(card: {
  card_name: string
  set_name?: string | null
  card_number?: string | null
  condition?: string | null
}, stats: {
  count30d:     number
  p10: number; p25: number; p50: number; p75: number; p90: number
  trendPct:     number
  recentMedian: number
  priorMedian:  number
  allTimeMin:   number
  allTimeMax:   number
}, recentSampleTitles: string[]): string {
  const conditionLabel = card.condition ?? 'Near Mint'
  const setClause     = card.set_name ? ` from ${card.set_name}` : ''
  const numClause     = card.card_number ? ` #${card.card_number}` : ''

  return `You are a professional trading card market analyst and eBay listing specialist. Analyze this card and provide a complete sell intelligence report.

CARD: ${card.card_name}${setClause}${numClause}
CONDITION: ${conditionLabel}

EBAY MARKET DATA (last 90 days):
- Sold in last 30 days: ${stats.count30d} items
- Price percentiles of ALL sold comps:
  • P10 (floor):  $${stats.p10.toFixed(2)}
  • P25 (low):    $${stats.p25.toFixed(2)}
  • P50 (median): $${stats.p50.toFixed(2)}
  • P75 (high):   $${stats.p75.toFixed(2)}
  • P90 (peak):   $${stats.p90.toFixed(2)}
- 30-day price trend: ${stats.trendPct >= 0 ? '+' : ''}${stats.trendPct}% vs prior 30 days
  • Recent 30d median: $${stats.recentMedian.toFixed(2)}
  • Prior 30d median:  $${stats.priorMedian.toFixed(2)}
- All-time range in dataset: $${stats.allTimeMin.toFixed(2)} – $${stats.allTimeMax.toFixed(2)}

RECENT SOLD LISTING TITLES (buyer search patterns):
${recentSampleTitles.slice(0, 8).map((t, i) => `${i + 1}. ${t}`).join('\n')}

TASK:
1. Determine the OPTIMAL listing price (sweet spot: sells within 7–14 days, not leaving money on table)
2. Write a SELL SCORE from 1–10 (10 = list immediately, market is hot; 1 = hold, market is crashing)
3. Write an eBay listing TITLE (max 80 characters, keyword-rich based on buyer search patterns above)
4. Write a professional DESCRIPTION (200–350 words, HTML-safe plain text, mention condition, card details, fast shipping)
5. Provide a 2–3 sentence ANALYSIS explaining your reasoning

Respond ONLY with a valid JSON object (no markdown, no explanation outside JSON):
{
  "sellScore": <number 1-10>,
  "grade": "<letter: A/B/C/D/F with optional +/->",
  "urgency": "<one of: sell_now | sell_soon | hold | strong_hold>",
  "optimalPrice": <number>,
  "priceConfidenceLow": <number>,
  "priceConfidenceHigh": <number>,
  "trendDirection": "<rising | falling | stable>",
  "title": "<string max 80 chars>",
  "description": "<string 200-350 words plain text>",
  "analysis": "<string 2-3 sentences>",
  "recommendation": "<string one concise action sentence>",
  "sellReasons": ["<string>", ...],
  "holdReasons": ["<string>", ...],
  "estDaysToSell": <number>
}`
}

// ── Route ───────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json()
    const { itemId, catalogId, cardName, setName, cardNumber, condition } = body

    // ── Resolve card details ──
    let resolvedCard = { card_name: cardName, set_name: setName, card_number: cardNumber, condition }

    if (itemId && !cardName) {
      const { data: item } = await supabase
        .from('inventory_items')
        .select(`
          condition,
          card_catalog_items (card_name, set_name, card_number)
        `)
        .eq('id', itemId)
        .eq('user_id', user.id)
        .single()

      if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 })
      const cat = (item as any).card_catalog_items
      resolvedCard = {
        card_name:   cat?.card_name   ?? 'Unknown Card',
        set_name:    cat?.set_name    ?? null,
        card_number: cat?.card_number ?? null,
        condition:   (item as any).condition ?? null,
      }
    }

    if (!resolvedCard.card_name) {
      return NextResponse.json({ error: 'card_name is required' }, { status: 400 })
    }

    // ── Fetch eBay comps ──
    const keyword = buildKeyword({
      card_name:           resolvedCard.card_name,
      set_name:            resolvedCard.set_name ?? undefined,
      card_number:         resolvedCard.card_number ?? undefined,
      franchise_or_brand:  'Pokemon',
    })

    const { comps } = await fetchEbayComps(keyword, false)

    if (comps.length < 3) {
      return NextResponse.json({
        error: 'Not enough eBay sold data to generate intelligence. Try again later.',
        comps: 0,
      }, { status: 422 })
    }

    // ── Compute statistics ──
    const now     = Date.now()
    const ms90    = 90 * 24 * 60 * 60 * 1000
    const recent  = comps.filter(c => c.soldAt && (now - c.soldAt.getTime()) <= ms90)
    const prices  = recent.map(c => c.soldPrice).sort((a, b) => a - b)

    const p10 = percentile(prices, 10)
    const p25 = percentile(prices, 25)
    const p50 = percentile(prices, 50)
    const p75 = percentile(prices, 75)
    const p90 = percentile(prices, 90)

    const allPrices    = comps.map(c => c.soldPrice)
    const allTimeMin   = Math.min(...allPrices)
    const allTimeMax   = Math.max(...allPrices)
    const count30d     = comps.filter(c => c.soldAt && (now - c.soldAt.getTime()) <= 30 * 24 * 60 * 60 * 1000).length
    const { trendPct, recentMedian, priorMedian } = trendVelocity(comps)

    const stats = { count30d, p10, p25, p50, p75, p90, trendPct, recentMedian, priorMedian, allTimeMin, allTimeMax }

    // ── Recent listing titles for keyword analysis ──
    const recentSampleTitles = comps
      .filter(c => c.soldAt && (now - c.soldAt.getTime()) <= ms90)
      .sort((a, b) => (b.soldAt?.getTime() ?? 0) - (a.soldAt?.getTime() ?? 0))
      .slice(0, 12)
      .map(c => c.title)

    // ── Claude intelligence ──
    const prompt  = buildPrompt(resolvedCard, stats, recentSampleTitles)
    const message = await anthropic.messages.create({
      model:      'claude-opus-4-5',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    })

    const raw   = (message.content[0] as any)?.text ?? ''
    const clean = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const intel = JSON.parse(clean)

    // ── Build price distribution for chart ──
    const distribution = prices.reduce((acc: Record<number, number>, p) => {
      const bucket = Math.round(p / 5) * 5
      acc[bucket] = (acc[bucket] ?? 0) + 1
      return acc
    }, {})

    const chartData = Object.entries(distribution)
      .map(([price, count]) => ({ price: Number(price), count: count as number }))
      .sort((a, b) => a.price - b.price)

    return NextResponse.json({
      card:     resolvedCard,
      keyword,
      compsCount: comps.length,
      stats,
      chartData,
      intel,
    })
  } catch (e: any) {
    console.error('[sell-intel] error:', e)
    return NextResponse.json({ error: e?.message ?? 'Intelligence generation failed' }, { status: 500 })
  }
}
