import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ setId: string }> }
) {
  const { setId } = await params
  const setName = decodeURIComponent(setId)

  const supabase = await createClient()

  // Fetch all three tables in parallel
  const [enrichmentRes, investmentRes, psaRes] = await Promise.all([
    supabase
      .from('set_enrichment')
      .select('*')
      .eq('set_name', setName)
      .maybeSingle(),

    supabase
      .from('set_investment_metrics')
      .select('*')
      .eq('set_name', setName)
      .maybeSingle(),

    supabase
      .from('psa_pop_snapshots')
      .select('snapshot_date, psa_10_count, psa_9_count, psa_8_count, card_name')
      .eq('set_name', setName)
      .order('snapshot_date', { ascending: false })
      .limit(200),
  ])

  const enrichment = enrichmentRes.data
  const investment = investmentRes.data
  const psaRows    = psaRes.data ?? []

  // ── Build PSA population summary ───────────────────────────────────────────

  // Group snapshots: latest and one-month-ago per card
  const byCard = new Map<string, { latest: typeof psaRows[0]; older: typeof psaRows[0] | null }>()

  for (const row of psaRows) {
    const cardName = row.card_name ?? 'Unknown'
    const existing = byCard.get(cardName)
    if (!existing) {
      byCard.set(cardName, { latest: row, older: null })
    } else if (!existing.older) {
      // Second-most-recent snapshot — use as the "one month ago" proxy
      existing.older = row
    }
  }

  // Aggregate totals
  let latestPsa10Total = 0
  let growthThisMonth  = 0

  for (const { latest, older } of byCard.values()) {
    latestPsa10Total += latest.psa_10_count ?? 0
    if (older) {
      growthThisMonth += (latest.psa_10_count ?? 0) - (older.psa_10_count ?? 0)
    }
  }

  const latestSnapshotDate = psaRows[0]?.snapshot_date ?? null

  // ── Shape top_cards from investment metrics ────────────────────────────────

  // top_cards is stored as JSONB array in set_investment_metrics
  // Shape: [{ card_name, current_price, cagr_1yr, price_1yr_ago }]
  const topCards = (investment?.top_cards as unknown[] | null) ?? []

  // ── Response ───────────────────────────────────────────────────────────────

  const body = {
    setName,
    releaseYear: enrichment?.release_year ?? null,
    enrichment: enrichment
      ? {
          print_era:       enrichment.print_era,
          reprint_count:   enrichment.reprint_count,
          reprint_risk:    enrichment.reprint_risk,
          print_run_size:  enrichment.print_run_size,
          collector_notes: enrichment.collector_notes,
          last_reprint_year: enrichment.last_reprint_year,
        }
      : null,
    investment: investment
      ? {
          cagr_1yr:          investment.cagr_1yr,
          cagr_3yr:          investment.cagr_3yr,
          cagr_5yr:          investment.cagr_5yr,
          investment_grade:  investment.investment_grade,
          top_cards:         topCards,
        }
      : null,
    psaPopulation: {
      latestSnapshotDate,
      latestPsa10Total,
      growthThisMonth,
    },
  }

  return Response.json(body)
}
