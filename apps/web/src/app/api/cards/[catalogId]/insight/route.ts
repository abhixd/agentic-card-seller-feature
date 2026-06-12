/**
 * GET /api/cards/[catalogId]/insight
 *
 * Returns an AI-generated NEXUS market insight for the given card,
 * plus computed price metrics and relevant news headlines.
 *
 * Uses Vercel AI Gateway with OIDC auth (vercel env pull).
 * Response is cached at the edge for 6 hours via Cache-Control.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'

export const runtime = 'nodejs'

// ── Types ─────────────────────────────────────────────────────────────────────

interface TcgPriceBand {
  low?:    number | null
  mid?:    number | null
  high?:   number | null
  market?: number | null
  [key: string]: number | null | undefined
}

interface TcgHistoryPoint {
  date:  string
  price: number
}

interface InsightMetrics {
  dataPoints:      number
  lowDataWarning:  boolean
  stagnant:        boolean   // price flat (<1% move) over 30d with enough data
  currentPrice:    number | null
  price7dAgo:      number | null
  price30dAgo:     number | null
  change7d:        number | null
  change30d:       number | null
  ath:             number | null
  atl:             number | null
  athDate:         string | null
  atlDate:         string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Scan all TCGPlayer price bands — take highest market, fall back to highest mid */
function extractCurrentPrice(prices: Record<string, TcgPriceBand> | undefined): number | null {
  if (!prices) return null
  let bestMarket: number | null = null
  let bestMid:    number | null = null

  for (const band of Object.values(prices)) {
    if (!band) continue
    if (band.market != null && (bestMarket === null || band.market > bestMarket)) {
      bestMarket = band.market
    }
    if (band.mid != null && (bestMid === null || band.mid > bestMid)) {
      bestMid = band.mid
    }
  }

  if (bestMarket != null) return bestMarket
  if (bestMid    != null) return bestMid
  return null
}

/**
 * Find the history point whose date is closest to the target date.
 * Returns null if the closest match is more than 3 days away (avoids spurious
 * data when history is sparse near the boundary).
 */
function closestPrice(
  points: TcgHistoryPoint[],
  targetMs: number,
  toleranceDays = 3,
): number | null {
  if (points.length === 0) return null

  let best:    TcgHistoryPoint | null = null
  let bestDiff = Infinity

  for (const pt of points) {
    const diff = Math.abs(new Date(pt.date).getTime() - targetMs)
    if (diff < bestDiff) {
      bestDiff = diff
      best     = pt
    }
  }

  const toleranceMs = toleranceDays * 24 * 60 * 60 * 1000
  if (bestDiff > toleranceMs) return null
  return best?.price ?? null
}

function computeMetrics(
  meta: Record<string, unknown>,
): InsightMetrics {
  // ── TCG History points ───────────────────────────────────────────────────
  const tcgHistory  = meta.tcg_history as { points?: TcgHistoryPoint[] } | undefined
  const rawPoints   = (tcgHistory?.points ?? []).filter(
    (p): p is TcgHistoryPoint => typeof p?.date === 'string' && typeof p?.price === 'number'
  )

  // Sort ascending by date
  const points = [...rawPoints].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  )

  const dataPoints = points.length

  // ── Current price from TCGPlayer bands ──────────────────────────────────
  const tcgPrices  = (meta.tcgplayer as { prices?: Record<string, TcgPriceBand> } | undefined)?.prices
  const currentPrice = extractCurrentPrice(tcgPrices)

  // ── Low-data warning ─────────────────────────────────────────────────────
  // tcg_history.points comes from a different sync path than the live chart;
  // only warn when there is genuinely no price signal at all.
  // A card with current TCGPlayer pricing but no stored history is NOT thin data.
  const lowDataWarning = currentPrice === null && dataPoints < 3

  // ── Historical prices ────────────────────────────────────────────────────
  const now       = Date.now()
  const ms7d      = now - 7  * 24 * 60 * 60 * 1000
  const ms30d     = now - 30 * 24 * 60 * 60 * 1000

  const price7dAgo  = closestPrice(points, ms7d,  3)
  const price30dAgo = closestPrice(points, ms30d, 4)

  // ── % changes ───────────────────────────────────────────────────────────
  const change7d  = (currentPrice != null && price7dAgo  != null && price7dAgo  !== 0)
    ? ((currentPrice - price7dAgo)  / price7dAgo  * 100) : null
  const change30d = (currentPrice != null && price30dAgo != null && price30dAgo !== 0)
    ? ((currentPrice - price30dAgo) / price30dAgo * 100) : null

  // ── ATH / ATL ────────────────────────────────────────────────────────────
  let ath: number | null = null
  let atl: number | null = null
  let athDate: string | null = null
  let atlDate: string | null = null

  for (const pt of points) {
    if (ath === null || pt.price > ath) { ath = pt.price; athDate = pt.date }
    if (atl === null || pt.price < atl) { atl = pt.price; atlDate = pt.date }
  }

  // ── Stagnant flag ────────────────────────────────────────────────────────
  // Only flag as stagnant when we have solid historical coverage (≥14 points).
  // Cards with sparse tcg_history but active TCGPlayer pricing are not illiquid —
  // they just haven't been scraped enough times yet.
  const stagnant = dataPoints >= 14 && change30d !== null && Math.abs(change30d) < 1

  return {
    dataPoints,
    lowDataWarning,
    stagnant,
    currentPrice,
    price7dAgo,
    price30dAgo,
    change7d,
    change30d,
    ath,
    atl,
    athDate,
    atlDate,
  }
}

function fallbackInsight(
  cardName: string,
  setName:  string,
  m: InsightMetrics,
): string {
  const price = m.currentPrice != null ? `$${m.currentPrice.toFixed(2)}` : 'an unknown price'

  if (m.dataPoints < 7) {
    return `${cardName} (${setName}) is trading at ${price}. Limited price history makes trend analysis unreliable.`
  }

  const direction = (m.change30d ?? 0) >= 0 ? 'up' : 'down'
  const change30dStr = m.change30d != null ? Math.abs(m.change30d).toFixed(1) : '?'
  const athStr = m.ath != null && m.athDate
    ? `ATH was $${m.ath.toFixed(2)} on ${m.athDate.slice(0, 10)}.`
    : ''

  return `${cardName} (${setName}) is trading at ${price} — ${direction} ${change30dStr}% over 30 days. ${athStr}`.trim()
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ catalogId: string }> }
) {
  const { catalogId } = await params

  const supabase = createServiceClient()

  // ── Fetch card ───────────────────────────────────────────────────────────
  const { data: card, error: cardError } = await supabase
    .from('card_catalog_items')
    .select('catalog_id, card_name, set_name, metadata_json')
    .eq('catalog_id', catalogId)
    .single()

  if (cardError || !card) {
    return NextResponse.json({ error: 'Card not found' }, { status: 404 })
  }

  const meta      = (card.metadata_json as Record<string, unknown>) ?? {}
  const cardName  = (card.card_name as string) ?? 'Unknown Card'
  const setName   = (card.set_name  as string) ?? 'Unknown Set'

  // ── Extract card lore fields from metadata ───────────────────────────────
  const types       = (meta.types     as string[] | undefined) ?? []
  const hp          = meta.hp         as string | number | undefined
  const rarity      = meta.rarity     as string | undefined
  const flavorText  = meta.flavorText as string | undefined ?? meta.flavor_text as string | undefined
  const artist      = meta.artist     as string | undefined
  const releaseDate = (meta.set as Record<string, unknown> | undefined)?.releaseDate as string | undefined
  const setYear     = releaseDate ? releaseDate.slice(0, 4) : null
  const seriesName  = (meta.set as Record<string, unknown> | undefined)?.series as string | undefined

  // Evolution chain
  const evolvesFrom = meta.evolvesFrom as string | undefined
  const evolvesTo   = (meta.evolvesTo   as string[] | undefined) ?? []

  // Pokédex number (first entry)
  const nationalDex = (meta.nationalPokedexNumbers as number[] | undefined)?.[0] ?? null

  // Subtypes (e.g. "EX", "VSTAR", "Stage 2", "Supporter")
  const subtypes  = (meta.subtypes  as string[] | undefined) ?? []
  const supertype = meta.supertype  as string | undefined   // "Pokémon" | "Trainer" | "Energy"

  // Card number within set
  const cardNumber = meta.number as string | undefined

  // Top attack names + damage for context
  const attacks = (meta.attacks as Array<{ name: string; damage?: string; text?: string }> | undefined) ?? []
  const attackSummary = attacks.slice(0, 2).map(a => `${a.name}${a.damage ? ` (${a.damage})` : ''}`).join(', ')

  // Abilities (e.g. Ability name)
  const abilities = (meta.abilities as Array<{ name: string; text?: string }> | undefined) ?? []
  const abilitySummary = abilities.map(a => a.name).join(', ')

  // ── Fetch relevant news ──────────────────────────────────────────────────
  const { data: newsRows } = await supabase
    .from('pokemon_news')
    .select('title')
    .or(`title.ilike.%${cardName}%,body.ilike.%${cardName}%,title.ilike.%${setName}%,body.ilike.%${setName}%`)
    .order('published_at', { ascending: false })
    .limit(5)

  const newsHeadlines: string[] = (newsRows ?? []).map((r: { title: string }) => r.title).filter(Boolean)

  // ── Compute metrics ──────────────────────────────────────────────────────
  const metrics = computeMetrics(meta)

  // ── Build AI prompt ──────────────────────────────────────────────────────
  const fmt = (n: number | null, decimals = 2) =>
    n != null ? n.toFixed(decimals) : 'N/A'
  const pct = (n: number | null) =>
    n != null ? `${n >= 0 ? '+' : ''}${n.toFixed(1)}%` : 'N/A'

  // ── Build AI prompt ──────────────────────────────────────────────────────
  const cardFactLines = [
    supertype && subtypes.length ? `Card type: ${supertype} — ${subtypes.join(', ')}` : supertype ? `Card type: ${supertype}` : null,
    types.length      ? `Type: ${types.join(' / ')}`                                  : null,
    hp                ? `HP: ${hp}`                                                   : null,
    nationalDex       ? `Pokédex #${nationalDex}`                                     : null,
    evolvesFrom       ? `Evolves from: ${evolvesFrom}`                                : null,
    evolvesTo.length  ? `Evolves into: ${evolvesTo.join(', ')}`                       : null,
    rarity            ? `Rarity: ${rarity}`                                           : null,
    cardNumber        ? `Card number: ${cardNumber}`                                  : null,
    seriesName        ? `Series: ${seriesName}`                                       : null,
    setYear           ? `Set released: ${setYear}`                                    : null,
    abilitySummary    ? `Ability: ${abilitySummary}`                                  : null,
    attackSummary     ? `Attacks: ${attackSummary}`                                   : null,
    artist            ? `Illustrated by: ${artist}`                                   : null,
    flavorText        ? `Flavor text: "${flavorText}"`                                : null,
  ].filter(Boolean).join('\n')

  const prompt = [
    `Card: ${cardName}`,
    `Set: ${setName}`,
    cardFactLines || null,
    '',
    `Current Price: $${fmt(metrics.currentPrice)}`,
    `7d Change: ${pct(metrics.change7d)}`,
    `30d Change: ${pct(metrics.change30d)}`,
    metrics.ath != null ? `All-time high (tracked): $${fmt(metrics.ath)} on ${metrics.athDate ?? 'N/A'}` : null,
    metrics.atl != null ? `All-time low (tracked):  $${fmt(metrics.atl)} on ${metrics.atlDate ?? 'N/A'}` : null,
    metrics.stagnant ? 'Note: price has barely moved in 30 days — very low market activity.' : null,
    newsHeadlines.length > 0
      ? `\nRecent news:\n${newsHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
      : null,
    `\nWrite 3 sentences:
1. What makes this card genuinely interesting — reference the specific artist if known (their style, other famous cards they illustrated), the Pokémon's lore/Pokédex significance, its place in the evolution line, or any iconic moment from the anime/games tied to it. Be a real collector, not a Wikipedia summary.
2. Market read right now — use the exact price and % changes above. Be sharp and specific.
3. Collector angle or forward-looking take — if there's relevant news use it; otherwise give a real insight about rarity, print runs, competitive play, or why collectors care.`,
  ].filter(Boolean).join('\n')

  // ── Generate insight ─────────────────────────────────────────────────────
  let insight: string
  let cached = false

  try {
    const apiKey = process.env.VERCEL_OIDC_TOKEN
    const anthropic = new Anthropic({
      apiKey,
      baseURL: 'https://ai-gateway.vercel.sh/v1/providers/anthropic',
      defaultHeaders: { 'Authorization': `Bearer ${apiKey}` },
    })

    const msg = await anthropic.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 380,
      system:     `You are NEXUS — a Pokemon TCG market intelligence AI with the energy of a passionate collector and the precision of a quant trader. Your writing style: confident, vivid, a little obsessive about details. You love the lore and history behind cards just as much as the price action.

Rules:
- Write exactly 3 sentences as instructed by the user prompt.
- Sentence 1: Make it genuinely interesting. If an artist is listed, name them and connect their style or other famous cards they've illustrated. Reference the Pokédex number, evolution line, or iconic anime/game moments tied to this specific Pokémon. Don't be generic — "Mitsuhiro Arita's brushwork defined a generation of Base Set nostalgia" beats "This is a Charizard."
- Sentence 2: Sharp market analysis using the exact price numbers and % changes provided. No hedging unless truly warranted.
- Sentence 3: Forward-looking or contextual — use news if present; otherwise give a real collector insight about rarity, print run era, competitive viability, or what drives demand for this specific card.
- No emojis. No bullet points. No headers. Just three great sentences.
- Sound like someone who has been collecting for 20 years and also runs a hedge fund.`,
      messages:   [{ role: 'user', content: prompt }],
    })

    const block = msg.content[0]
    insight = block.type === 'text' ? block.text : fallbackInsight(cardName, setName, metrics)
  } catch (err) {
    console.error('[insight] AI call failed — using fallback:', err)
    insight = fallbackInsight(cardName, setName, metrics)
    cached  = false
  }

  // ── Return with edge cache headers ────────────────────────────────────────
  return NextResponse.json(
    {
      insight,
      metrics,
      newsHeadlines,
      cached,
    },
    {
      headers: {
        'Cache-Control': 's-maxage=21600, stale-while-revalidate=3600',
      },
    }
  )
}
