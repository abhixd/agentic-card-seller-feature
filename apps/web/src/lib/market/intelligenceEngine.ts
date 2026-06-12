// ---------------------------------------------------------------
// NEXUS Market Intelligence Engine
// Queries card price history, computes per-card and set-level
// metrics, then calls Claude to generate analyst observations.
// ---------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase/server'

// ── Types ────────────────────────────────────────────────────────────────────

export interface PricePoint {
  date:  string
  price: number
}

export interface CardMetrics {
  catalog_id:    string
  card_name:     string
  card_number:   string | null
  set_name:      string | null
  edition:       '1st_edition' | 'unlimited' | 'reverse_holo' | 'unknown'
  price_now:     number
  change_7d_pct:  number | null
  change_30d_pct: number | null
  all_time_high:  number
  all_time_low:   number
  pct_from_ath:   number
  pct_from_atl:   number
  volatility:     number
  spread_ratio:   number | null
  point_count:    number
  earliest_date:  string
  latest_date:    string
}

export interface SetMomentum {
  set_name:       string
  avg_7d_pct:     number
  card_count:     number
}

export interface MarketSnapshot {
  generated_at:    string
  earliest_data:   string
  card_metrics:    CardMetrics[]
  set_momentum:    SetMomentum[]
  top_movers_up:   CardMetrics[]
  top_movers_down: CardMetrics[]
  near_ath:        CardMetrics[]   // within 10% of ATH
  near_atl:        CardMetrics[]   // within 10% of ATL
  high_volatility: CardMetrics[]
  news_headlines:  string[]
}

export interface IntelPost {
  headline:         string
  body:             string
  signal_types:     string[]
  cards_referenced: { name: string; set: string; price: number; change_pct: number | null }[]
  confidence:       number
}

// ── Math helpers ─────────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0
  const m = mean(arr)
  const variance = arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length
  return Math.sqrt(variance)
}

function trendPct(points: PricePoint[], days: number): number | null {
  if (points.length < 2) return null
  const now    = new Date(points[points.length - 1].date).getTime()
  const cutoff = now - days * 24 * 60 * 60 * 1000
  const anchor = [...points].reverse().find(p => new Date(p.date).getTime() <= cutoff)
  if (!anchor || anchor.price === 0) return null
  const latest = points[points.length - 1].price
  return ((latest - anchor.price) / anchor.price) * 100
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ── Compute metrics for a single card ────────────────────────────────────────

function computeMetrics(
  catalogId: string,
  cardName: string,
  cardNumber: string | null,
  setName: string | null,
  points: PricePoint[],
  spreadRatio: number | null,
): CardMetrics {
  // Sort ascending by date
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date))

  const prices     = sorted.map(p => p.price)
  const priceNow   = prices[prices.length - 1]
  const ath        = Math.max(...prices)
  const positives  = prices.filter(p => p > 0)
  const atl        = positives.length > 0 ? Math.min(...positives) : priceNow

  const last30Prices = prices.slice(-30)
  const vol = last30Prices.length >= 2
    ? (mean(last30Prices) > 0 ? stddev(last30Prices) / mean(last30Prices) : 0)
    : 0

  // Infer edition from card name / number heuristics
  let edition: CardMetrics['edition'] = 'unlimited'
  if (cardName.toLowerCase().includes('1st edition') || cardName.toLowerCase().includes('1st ed')) {
    edition = '1st_edition'
  } else if (cardName.toLowerCase().includes('reverse holo') || cardName.toLowerCase().includes('reverse_holo')) {
    edition = 'reverse_holo'
  }

  return {
    catalog_id:     catalogId,
    card_name:      cardName,
    card_number:    cardNumber,
    set_name:       setName,
    edition,
    price_now:      round2(priceNow),
    change_7d_pct:  trendPct(sorted, 7)  !== null ? round2(trendPct(sorted, 7)!)  : null,
    change_30d_pct: trendPct(sorted, 30) !== null ? round2(trendPct(sorted, 30)!) : null,
    all_time_high:  round2(ath),
    all_time_low:   round2(atl),
    pct_from_ath:   round2((priceNow - ath) / ath * 100),
    pct_from_atl:   round2((priceNow - atl) / atl * 100),
    volatility:     round2(vol),
    spread_ratio:   spreadRatio !== null ? round2(spreadRatio) : null,
    point_count:    sorted.length,
    earliest_date:  sorted[0].date,
    latest_date:    sorted[sorted.length - 1].date,
  }
}

// ── Build set-level momentum ──────────────────────────────────────────────────

function buildSetMomentum(metrics: CardMetrics[]): SetMomentum[] {
  const bySet = new Map<string, number[]>()
  for (const m of metrics) {
    const key = m.set_name ?? 'Unknown Set'
    if (m.change_7d_pct !== null) {
      const arr = bySet.get(key) ?? []
      arr.push(m.change_7d_pct)
      bySet.set(key, arr)
    }
  }
  return [...bySet.entries()]
    .map(([set_name, pcts]) => ({
      set_name,
      avg_7d_pct: round2(mean(pcts)),
      card_count: pcts.length,
    }))
    .sort((a, b) => Math.abs(b.avg_7d_pct) - Math.abs(a.avg_7d_pct))
}

// ── Claude prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are NEXUS, the market intelligence AI for a Pokemon card seller platform. You have access to real price history data — not just current prices but actual time series. You notice patterns humans miss: set-level correlations, mean-reversion signals, arbitrage between editions, supply signals from bid-ask spreads, and historical analogs.

You write brief, numbered market observations. Each one must:
- Reference specific card names, sets, and numbers
- Include actual percentages or prices from the data
- Make a non-obvious connection or inference
- Be actionable for a card seller (buy, hold, watch, sell, hedge)
- Sound like a genius quant who also loves Pokemon — confident, precise, occasionally dry humor

Avoid: generic statements like "prices are moving". Always: specific card + specific data + specific insight.`

// ── Main engine ───────────────────────────────────────────────────────────────

export async function generateMarketIntelligence(): Promise<IntelPost[]> {
  const supabase = createServiceClient()

  // 1. Fetch cards with tcg_history that have at least 7 data points
  const { data: cards, error: cardsError } = await supabase
    .from('card_catalog_items')
    .select('catalog_id, card_name, card_number, set_name, metadata_json')
    .not('metadata_json->tcg_history->points', 'is', null)

  if (cardsError) {
    console.error('[intelligenceEngine] Failed to fetch cards:', cardsError.message)
    return []
  }

  if (!cards || cards.length === 0) {
    console.log('[intelligenceEngine] No cards with price history found')
    return []
  }

  // 2. Filter to cards with ≥7 data points and compute metrics
  const metrics: CardMetrics[] = []

  for (const card of cards) {
    const meta = card.metadata_json as Record<string, unknown> | null
    if (!meta) continue

    const tcgHistory = meta['tcg_history'] as {
      points?: PricePoint[]
      fetched_at?: string
    } | undefined

    const points = tcgHistory?.points ?? []
    if (points.length < 7) continue

    // Compute spread ratio from tcgplayer high/low if available
    const tcgData = meta['tcgplayer'] as Record<string, unknown> | undefined
    let spreadRatio: number | null = null
    if (tcgData) {
      const prices = tcgData['prices'] as Record<string, unknown> | undefined
      if (prices) {
        // Try holofoil, normal, reverseHolofoil bands
        for (const band of ['holofoil', 'normal', 'reverseHolofoil', '1stEditionHolofoil']) {
          const b = prices[band] as Record<string, number> | undefined
          if (b?.high && b?.low && b.low > 0) {
            spreadRatio = b.high / b.low
            break
          }
        }
      }
    }

    metrics.push(
      computeMetrics(
        card.catalog_id,
        card.card_name,
        card.card_number,
        card.set_name,
        points,
        spreadRatio,
      )
    )
  }

  if (metrics.length === 0) {
    console.log('[intelligenceEngine] No cards met the 7-point threshold')
    return []
  }

  // 3. Set-level momentum
  const setMomentum = buildSetMomentum(metrics)

  // 4. Derived lists
  const withChange = metrics.filter(m => m.change_7d_pct !== null)
  const topMoversUp   = [...withChange].sort((a, b) => (b.change_7d_pct ?? 0) - (a.change_7d_pct ?? 0)).slice(0, 5)
  const topMoversDown = [...withChange].sort((a, b) => (a.change_7d_pct ?? 0) - (b.change_7d_pct ?? 0)).slice(0, 5)
  const nearAth  = metrics.filter(m => m.pct_from_ath >= -10).slice(0, 5)
  const nearAtl  = metrics.filter(m => m.pct_from_atl <= 10).slice(0, 5)
  const highVol  = [...metrics].sort((a, b) => b.volatility - a.volatility).slice(0, 5)

  // 5. Fetch last 5 news headlines
  let newsHeadlines: string[] = []
  try {
    const { data: news } = await supabase
      .from('pokemon_news')
      .select('title')
      .order('published_at', { ascending: false })
      .limit(5)
    newsHeadlines = (news ?? []).map((n: { title: string }) => n.title)
  } catch {
    // non-fatal
  }

  // 6. Earliest data date
  const earliestDate = metrics.reduce((min, m) => m.earliest_date < min ? m.earliest_date : min, metrics[0].earliest_date)

  const snapshot: MarketSnapshot = {
    generated_at:    new Date().toISOString(),
    earliest_data:   earliestDate,
    card_metrics:    metrics.slice(0, 50), // cap to keep prompt manageable
    set_momentum:    setMomentum.slice(0, 10),
    top_movers_up:   topMoversUp,
    top_movers_down: topMoversDown,
    near_ath:        nearAth,
    near_atl:        nearAtl,
    high_volatility: highVol,
    news_headlines:  newsHeadlines,
  }

  // 7. Call Claude
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || apiKey.length < 20) {
    console.warn('[intelligenceEngine] No valid ANTHROPIC_API_KEY — skipping Claude call')
    return []
  }

  try {
    const client = new Anthropic({ apiKey })

    const userPrompt =
      `Platform has been collecting price history data since ${earliestDate}. ` +
      `Today is ${new Date().toISOString().slice(0, 10)}. ` +
      `We are tracking ${metrics.length} cards with at least 7 days of price history.\n\n` +
      `Here is today's market snapshot:\n${JSON.stringify(snapshot, null, 2)}\n\n` +
      `Generate 4-6 market intelligence observations as a JSON array. Each element must have:\n` +
      `{\n` +
      `  "headline": "short punchy headline (max 80 chars)",\n` +
      `  "body": "2-4 sentence analysis with specific data points",\n` +
      `  "signal_types": ["momentum"|"arbitrage"|"anomaly"|"mean-reversion"|"supply"|"set-correlation"|"edition-premium"|"volatility"],\n` +
      `  "cards_referenced": [{"name": "...", "set": "...", "price": 0.00, "change_pct": 0.0}],\n` +
      `  "confidence": 0-100\n` +
      `}\n\n` +
      `Reply with ONLY the JSON array. No markdown, no explanation.`

    const message = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 2048,
      system:     SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    })

    const content = message.content[0]
    if (content.type !== 'text') throw new Error('Unexpected response type from Claude')

    // Strip markdown code fences if present
    let text = content.text.trim()
    if (text.startsWith('```')) {
      text = text.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim()
    }

    const parsed = JSON.parse(text) as IntelPost[]
    if (!Array.isArray(parsed)) throw new Error('Claude response is not an array')

    // Attach data_snapshot for storage (trimmed)
    return parsed.map(post => ({
      headline:         (post.headline ?? '').slice(0, 200),
      body:             post.body ?? '',
      signal_types:     Array.isArray(post.signal_types) ? post.signal_types.slice(0, 8) : [],
      cards_referenced: Array.isArray(post.cards_referenced) ? post.cards_referenced.slice(0, 10) : [],
      confidence:       typeof post.confidence === 'number'
        ? Math.min(100, Math.max(0, Math.round(post.confidence)))
        : 75,
    }))

  } catch (err) {
    console.error('[intelligenceEngine] Claude call failed:', err)
    return []
  }
}
