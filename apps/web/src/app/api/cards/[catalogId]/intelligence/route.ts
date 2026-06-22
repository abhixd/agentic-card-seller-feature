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

  // ── CardMarket prices (guide prices + recent averages) ─────────────────────
  const cm = meta?.cardmarket?.prices as Record<string, number> | undefined
  if (cm) {
    let added = false
    for (const [key, val] of Object.entries({
      averageSellPrice: cm.averageSellPrice, trendPrice: cm.trendPrice, avg7: cm.avg7, avg30: cm.avg30,
    })) {
      if (typeof val === 'number' && val > 0) {
        observations.push({ source: 'cardmarket', kind: 'guide', price: val, version: 'raw', volume: key === 'avg7' ? 6 : 4 })
        added = true
      }
    }
    if (added) dataSources.push('cardmarket')
  }

  // ── eBay sold comps (real transactions) — best-effort ──────────────────────
  let liquidity: { salesPerMonth?: number } | undefined
  try {
    const keyword = buildKeyword(card, 'en')
    const { comps: rawComps } = await fetchEbayComps(keyword)
    if (rawComps.length > 0) {
      const comps = normalizeComps(rawComps)
      observations.push(...observationsFromComps(comps))
      dataSources.push('ebay')
      if (comps.daysOfData > 0) {
        liquidity = { salesPerMonth: (comps.compCount / Math.max(1, comps.daysOfData)) * 30 }
      }
    }
  } catch {
    // eBay not configured locally — consensus still works from guide sources
  }

  // ── Consensus (raw + graded) ───────────────────────────────────────────────
  const byVersion = groupByVersion(observations)
  const consensusRaw = computeConsensus(byVersion.raw, { version: 'raw' })
  const consensusGraded = byVersion.graded.length > 0
    ? computeConsensus(byVersion.graded, { version: 'graded' })
    : null

  // ── Recent price trajectory for momentum/volatility (from CardMarket averages) ─
  const history: PricePoint[] = []
  const now = Date.now()
  const pushPt = (daysAgo: number, price: number | undefined) => {
    if (typeof price === 'number' && price > 0) {
      history.push({ date: new Date(now - daysAgo * 86400000).toISOString().slice(0, 10), price })
    }
  }
  pushPt(30, cm?.avg30)
  pushPt(7, cm?.avg7)
  pushPt(1, cm?.avg1)
  pushPt(0, tcgMarket ?? cm?.trendPrice)

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
  const scores = computeInvestmentScores({
    consensus: consensusRaw,
    gradedConsensus: consensusGraded,
    history: history.length >= 2 ? history : undefined,
    liquidity,
    marketPrice: tcgMarket,
    gradingUpsideRoiPercent,
  })

  return NextResponse.json({
    catalog_id: catalogId,
    card: {
      card_name: card.card_name, set_name: card.set_name,
      year: card.year, card_number: card.card_number,
    },
    consensus: { raw: consensusRaw, graded: consensusGraded },
    scores,
    dataSources,
  })
}
