/**
 * POST /api/grade/analyze
 *
 * Chrome extension entry point — orchestrates:
 *   1. Claude Vision  → grade distribution, issues, card identity
 *   2. eBay completed sales → real PSA 8/9/10 sold prices
 *   3. ROI engine     → max buy price + Buy/Maybe/Skip
 *
 * Requires env vars:
 *   ANTHROPIC_API_KEY — for Claude Vision grading
 *   EBAY_APP_ID       — eBay Finding API key (optional, improves price comps)
 */

import { NextRequest, NextResponse } from 'next/server'
import { fetchEbayComps } from '@/lib/ebay/findingApi'
import { gradeWithClaude } from '@/lib/grading/claudeVision'

export const runtime = 'nodejs'

// ── CORS ──────────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

// ── Config ────────────────────────────────────────────────────────
const GRADING_FEE   = 25      // PSA standard tier (USD)
const SELL_FEE      = 0.1295  // eBay ~12.95% final value fee
const TARGET_MARGIN = 0.20    // 20% net margin target for "buy"

const GRADE_RE = /\bPSA\s*(\d+(?:\.\d)?)\b/i

// ── Types ─────────────────────────────────────────────────────────
export interface GradeAnalysisRequest {
  listing_url?: string
  title:        string
  price:        number
  shipping?:    number
  image_urls:   string[]
  marketplace?: string
  card_category?: string
}

interface GradePrices {
  raw:   number | null
  psa8:  number | null
  psa9:  number | null
  psa10: number | null
}

// ── Helpers ───────────────────────────────────────────────────────

function median(arr: number[]): number | null {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function parseGradeFromTitle(title: string): number | null {
  const m = GRADE_RE.exec(title)
  if (!m) return null
  const g = parseFloat(m[1])
  return g >= 1 && g <= 10 ? Math.round(g) : null
}

function computeGradePrices(
  comps: Array<{ title: string; soldPrice: number }>,
): GradePrices {
  const byGrade: Record<number, number[]> = {}
  const rawPrices: number[] = []

  for (const c of comps) {
    const g = parseGradeFromTitle(c.title)
    if (g !== null) {
      byGrade[g] = [...(byGrade[g] ?? []), c.soldPrice]
    } else if (!/graded|slab|psa|bgs|sgc|cgc/i.test(c.title)) {
      rawPrices.push(c.soldPrice)
    }
  }

  return {
    raw:   median(rawPrices),
    psa8:  median(byGrade[8]  ?? []),
    psa9:  median(byGrade[9]  ?? []),
    psa10: median(byGrade[10] ?? []),
  }
}

function computeROI(
  listingTotal: number,
  gradeDist:   Record<string, number>,
  prices:      GradePrices,
) {
  const { raw = 20, psa8 = 0, psa9 = 0, psa10 = 0 } = prices
  const net = (p: number) => p * (1 - SELL_FEE) - GRADING_FEE

  let ev = 0
  for (const [gradeStr, prob] of Object.entries(gradeDist)) {
    const g = parseInt(gradeStr, 10)
    const salePrice =
      g >= 10 ? (psa10 ?? psa9 ?? raw ?? 0) :
      g === 9  ? (psa9  ?? psa10 ?? raw ?? 0) :
      g >= 7   ? (psa8  ?? psa9  ?? raw ?? 0) :
                 ((raw ?? 20) * (g / 8))
    ev += prob * salePrice * (1 - SELL_FEE)
  }
  ev -= GRADING_FEE

  const maxPsa9 = psa9 ? Math.max(0, net(psa9) * (1 - TARGET_MARGIN)) : null
  const maxPsa8 = psa8 ? Math.max(0, net(psa8) * (1 - TARGET_MARGIN * 0.6)) : null

  return {
    listing_price:                 round2(listingTotal),
    grading_fee:                   GRADING_FEE,
    raw_estimate:                  raw   ? round2(raw)   : null,
    psa8_estimate:                 psa8  ? round2(psa8)  : null,
    psa9_estimate:                 psa9  ? round2(psa9)  : null,
    psa10_estimate:                psa10 ? round2(psa10) : null,
    max_buy_price_for_psa8_target: maxPsa8 ? round2(maxPsa8) : null,
    max_buy_price_for_psa9_target: maxPsa9 ? round2(maxPsa9) : null,
    expected_value:                round2(ev),
  }
}

function computeDecision(
  economics:  ReturnType<typeof computeROI>,
  confidence: string,
) {
  if (confidence === 'low') {
    return { label: 'skip', reason: 'Image quality too low for reliable analysis' }
  }
  const { listing_price: p, max_buy_price_for_psa9_target: m9,
          max_buy_price_for_psa8_target: m8, expected_value: ev } = economics

  if (m9 && p <= m9 && (ev ?? 0) > p) {
    return { label: 'buy',   reason: `Profitable at PSA 9 — max buy $${m9.toFixed(0)}, EV $${(ev??0).toFixed(0)}` }
  }
  if (m8 && p <= m8) {
    return { label: 'maybe', reason: `Profitable if PSA 9, marginal at PSA 8 — max buy $${m8.toFixed(0)}` }
  }
  if (ev && p <= ev * 1.1) {
    return { label: 'maybe', reason: `Borderline — EV $${ev.toFixed(0)} near listing $${p.toFixed(0)}` }
  }
  return { label: 'skip', reason: `Price $${p.toFixed(0)} exceeds break-even${m9 ? ` (PSA 9 target $${m9.toFixed(0)})` : ''}` }
}

function round2(n: number) { return Math.round(n * 100) / 100 }

// ── Inference sanity guard ────────────────────────────────────────
/**
 * Fix contradictions that Claude occasionally returns despite prompt rules.
 * Runs server-side so the extension always gets consistent data.
 *
 * Rules enforced:
 *  1. front_only mode → confidence MUST be "low", limiting_factor "front_only"
 *  2. Both sides non-assessable → confidence "low", gradable "no", caveat added
 *  3. front_only + back_analysis.assessable true → force back to false (impossible state)
 */
function sanitiseInference(
  inf: Awaited<ReturnType<typeof gradeWithClaude>>,
): Awaited<ReturnType<typeof gradeWithClaude>> {
  const frontAssessable = inf.front_analysis?.assessable !== false
  const backAssessable  = inf.back_analysis?.assessable  !== false

  // Rule 1: front_only mode always means low confidence
  if (inf.analysis_mode === 'front_only') {
    inf.grade_estimate.confidence     = 'low'
    inf.grade_estimate.limiting_factor = 'front_only'
    // Back must be non-assessable in front_only mode
    if (inf.back_analysis) inf.back_analysis.assessable = false
    // Ensure the required caveat string is present
    const requiredCaveat = 'Back image not provided — rear corner whitening, edge wear, and back centering cannot be assessed. Grade confidence is limited to low.'
    inf.grading_decision.caveats = inf.grading_decision.caveats ?? []
    if (!inf.grading_decision.caveats.includes(requiredCaveat)) {
      inf.grading_decision.caveats.push(requiredCaveat)
    }
  }

  // Rule 2: both sides non-assessable → can't grade at all
  if (!frontAssessable && !backAssessable) {
    inf.grade_estimate.confidence      = 'low'
    inf.grade_estimate.limiting_factor = 'image_quality'
    inf.grading_decision.gradable_candidate = 'no'
    inf.grading_decision.caveats = inf.grading_decision.caveats ?? []
    const bothBadCaveat = 'Neither front nor back image was assessable — unable to grade reliably.'
    if (!inf.grading_decision.caveats.includes(bothBadCaveat)) {
      inf.grading_decision.caveats.push(bothBadCaveat)
    }
  }

  return inf
}

// ── Route ─────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: GradeAnalysisRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS_HEADERS })
  }

  if (!body.title || !body.price || !body.image_urls?.length) {
    return NextResponse.json(
      { error: 'title, price, and image_urls are required' },
      { status: 400, headers: CORS_HEADERS },
    )
  }

  const listingTotal = body.price + (body.shipping ?? 0)

  // ── 1. Claude Vision grading ──────────────────────────────────
  let inference: Awaited<ReturnType<typeof gradeWithClaude>>
  try {
    inference = sanitiseInference(await gradeWithClaude(body.image_urls, body.title))
  } catch (err) {
    return NextResponse.json(
      { error: `Claude Vision grading failed: ${err instanceof Error ? err.message : 'Unknown error'}` },
      { status: 503, headers: CORS_HEADERS },
    )
  }

  // ── 2. Fetch eBay sold comps ──────────────────────────────────
  let prices: GradePrices = { raw: null, psa8: null, psa9: null, psa10: null }
  let compsSource = 'none'

  if (process.env.EBAY_APP_ID) {
    try {
      const keyword = body.title
        .replace(/\bPSA\s*\d+\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100)

      const { comps } = await fetchEbayComps(keyword)
      if (comps.length > 0) {
        prices = computeGradePrices(comps)
        compsSource = `ebay (${comps.length} sales)`
      }
    } catch {
      // Non-fatal — fall through with null prices
    }
  }

  // ── 3. ROI + decision ─────────────────────────────────────────
  const gradeDist = inference.grade_estimate.distribution
  const economics = computeROI(listingTotal, gradeDist, prices)
  const decision  = computeDecision(economics, inference.grade_estimate.confidence)

  return NextResponse.json({
    ...inference,
    economics,
    decision,
    _meta: { comps_source: compsSource, grading_backend: 'claude-vision' },
  }, { headers: CORS_HEADERS })
}
