// GET /api/cards/[catalogId]/intelligence
//
// Market Consensus Price + Opportunity/Risk scores for a card (PRD pillars 1 & 2).
// Fuses every price source we can reach for this card:
//   • eBay sold comps        (real transactions — best-effort; may be empty locally)
//   • TCGPlayer price bands   (market/mid guide prices, from metadata_json)
//   • CardMarket prices       (EU guide prices + recent averages, from metadata_json)
// then derives the investment scores. Read-only and additive — it does NOT write
// to the DB or touch the existing /api/analysis pipeline.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCatalogItem } from '@/lib/catalog/searchService'
import { buildKeyword, fetchEbayComps } from '@/lib/ebay/findingApi'
import { normalizeComps } from '@/lib/ebay/normalizeComps'
import { calculateFees } from '@/lib/engines/feeCalculator'
import { calculateGradingScenarios } from '@/lib/engines/gradingRoi'
import {
  computeConsensus,
  groupByVersion,
  observationsFromComps,
  type PriceObservation,
} from '@/lib/pricing/consensus'
import { computeInvestmentScores, type PricePoint } from '@/lib/intelligence/scores'

export const runtime = 'nodejs'

type Bands = Record<string, { low?: number; mid?: number; high?: number; market?: number } | null>

/** Highest market (fallback highest mid) across TCGPlayer bands — matches the card page. */
function bestTcgMarket(bands: Bands | undefined): number | null {
  if (!bands) return null
  let m: number | null = null
  let mid: number | null = null
  for (const b of Object.values(bands)) {
    if (!b) continue
    if (typeof b.market === 'number' && b.market > 0 && (m === null || b.market > m)) m = b.market
    if (typeof b.mid === 'number' && b.mid > 0 && (mid === null || b.mid > mid)) mid = b.mid
  }
  return m ?? mid ?? null
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ catalogId: string }> },
) {
  const { catalogId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { card, error } = await getCatalogItem(supabase, catalogId)
  if (error || !card) {
    return NextResponse.json({ error: error ?? 'Card not found.' }, { status: 404 })
  }

  const meta = (card.metadata_json ?? {}) as Record<string, any>
  const dataSources: string[] = []
  const observations: PriceObservation[] = []

  // ── TCGPlayer bands (guide prices) ─────────────────────────────────────────
  const tcgBands = meta?.tcgplayer?.prices as Bands | undefined
  const tcgMarket = bestTcgMarket(tcgBands)
  if (tcgBands) {
    let added = false
    for (const b of Object.values(tcgBands)) {
      if (!b) continue
      if (typeof b.market === 'number' && b.market > 0) {
        observations.push({ source: 'tcgplayer', kind: 'guide', price: b.market, version: 'raw', volume: 8 }); added = true
      } else if (typeof b.mid === 'number' && b.mid > 0) {
        observations.push({ source: 'tcgplayer', kind: 'guide', price: b.mid, version: 'raw', volume: 4 }); added = true
      }
    }
    if (added) dataSources.push('tcgplayer')
  }

  // ── CardMarket is intentionally NOT blended into the consensus: its prices
  //    are in EUR while TCGplayer/eBay are USD. Mixing currencies corrupts the
  //    consensus and fabricates volatility/valuation. (Re-add once we convert
  //    via a real FX rate.) ───────────────────────────────────────────────────

  // ── eBay sold comps (real USD transactions) — best-effort ──────────────────
  let liquidity: { salesPerMonth?: number } | undefined
  let hasEbay = false
  let ebaySold: number | null = null
  try {
    const keyword = buildKeyword(card, 'en')
    const { comps: rawComps } = await fetchEbayComps(keyword)
    if (rawComps.length > 0) {
      const comps = normalizeComps(rawComps)
      observations.push(...observationsFromComps(comps))
      dataSources.push('ebay')
      hasEbay = true
      ebaySold = comps.rawEstimate > 0 ? comps.rawEstimate : null
      if (comps.daysOfData > 0) {
        liquidity = { salesPerMonth: (comps.compCount / Math.max(1, comps.daysOfData)) * 30 }
      }
    }
  } catch {
    // eBay not configured — consensus still works from the TCGplayer guide price
  }

  // ── Consensus (raw + graded), USD-consistent ───────────────────────────────
  const byVersion = groupByVersion(observations)
  const consensusRaw = computeConsensus(byVersion.raw, { version: 'raw' })
  const consensusGraded = byVersion.graded.length > 0
    ? computeConsensus(byVersion.graded, { version: 'graded' })
    : null

  // ── Price history for momentum/volatility — ONLY a real, single-source,
  //    currency-consistent series (stored TCGplayer history). Never stitch one
  //    together from different sources/currencies (that was the bug that maxed
  //    out volatility/risk on cards like Blaine's Charizard). ─────────────────
  const rawHistory = (meta?.tcg_history?.points ?? []) as { date?: unknown; price?: unknown }[]
  const history: PricePoint[] = Array.isArray(rawHistory)
    ? rawHistory
        .filter((p) => typeof p?.date === 'string' && typeof p?.price === 'number' && (p.price as number) > 0)
        .map((p) => ({ date: p.date as string, price: p.price as number }))
    : []

  // ── Raw → graded upside (grading ROI engine) ───────────────────────────────
  let gradingUpsideRoiPercent: number | null = null
  if (consensusRaw.price > 0) {
    const fees = calculateFees({ salePrice: consensusRaw.price, platform: 'ebay', shippingCost: 4, acquisitionCost: 0 })
    const scenarios = calculateGradingScenarios({
      rawEstimate: consensusRaw.price, conditionScore: null, netProceedsRaw: fees.netProceeds,
    })
    const best = scenarios.find((s) => s.recommendation === 'strong') ?? scenarios[0] ?? null
    gradingUpsideRoiPercent = best?.roiPercent ?? null
  }

  // ── Investment scores ──────────────────────────────────────────────────────
  // The fair-value gap is only meaningful when the consensus carries an
  // INDEPENDENT real-sold signal (eBay) to compare the TCGplayer market price
  // against — otherwise we'd be comparing TCGplayer to itself. So pass
  // marketPrice ONLY when eBay sold comps are present.
  const scores = computeInvestmentScores({
    consensus: consensusRaw,
    history: history.length >= 3 ? history : undefined,
    liquidity,
    marketPrice: hasEbay ? tcgMarket : null,
    gradingUpsideRoiPercent,
  })

  const changePct =
    history.length >= 2 && history[0].price > 0
      ? ((history[history.length - 1].price - history[0].price) / history[0].price) * 100
      : null

  // ── Per-site prices for the "compare across sites" dropdown ────────────────
  const cmPrices = meta?.cardmarket?.prices as Record<string, number> | undefined
  const cmRef = cmPrices?.trendPrice ?? cmPrices?.averageSellPrice ?? null
  const prices: { site: string; price: number; note?: string }[] = []
  if (tcgMarket && tcgMarket > 0) prices.push({ site: 'TCGplayer', price: tcgMarket, note: 'market' })
  if (ebaySold != null) prices.push({ site: 'eBay', price: ebaySold, note: 'sold median' })
  if (typeof cmRef === 'number' && cmRef > 0) prices.push({ site: 'CardMarket', price: cmRef, note: 'EUR · EU market' })

  return NextResponse.json({
    catalog_id: catalogId,
    card: {
      card_name: card.card_name, set_name: card.set_name,
      year: card.year, card_number: card.card_number,
    },
    consensus: { raw: consensusRaw, graded: consensusGraded },
    scores,
    trend: { points: history, changePct },
    gradingUpsidePct: gradingUpsideRoiPercent,
    liquidityPerMonth: liquidity?.salesPerMonth ?? null,
    prices,
    dataSources,
  })
}
