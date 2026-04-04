import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

interface TournamentAppearanceRow {
  tournament_id: string
  tournament_name: string
  tournament_date: string
  placement: number | null
  deck_count: number
  format: string | null
  player_name: string | null
}

interface TournamentGroup {
  tournament_id: string
  tournament_name: string
  tournament_date: string
  placement: number | null
  deck_count: number
  format: string | null
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ catalogId: string }> }
) {
  const { catalogId } = await params

  const supabase = await createClient()

  const since = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10)

  const { data, error } = await supabase
    .from('tournament_appearances')
    .select(
      'tournament_id, tournament_name, tournament_date, placement, deck_count, format, player_name'
    )
    .eq('catalog_id', catalogId)
    .gte('tournament_date', since)
    .order('tournament_date', { ascending: false })

  if (error) {
    console.error('[tournament-meta] DB error:', error.message)
    return Response.json({ error: 'Failed to fetch tournament data' }, { status: 500 })
  }

  if (!data || data.length === 0) {
    return Response.json({
      appearances: [],
      totalTournaments: 0,
      avgPlacement: null,
      lastSeen: null,
      trending: false,
    })
  }

  const rows = data as TournamentAppearanceRow[]

  // Group by tournament, picking the best (lowest) placement per tournament
  const byTournament = new Map<string, TournamentGroup>()
  for (const row of rows) {
    const existing = byTournament.get(row.tournament_id)
    if (
      !existing ||
      (row.placement != null &&
        (existing.placement == null || row.placement < existing.placement))
    ) {
      byTournament.set(row.tournament_id, {
        tournament_id:   row.tournament_id,
        tournament_name: row.tournament_name,
        tournament_date: row.tournament_date,
        placement:       row.placement,
        deck_count:      row.deck_count,
        format:          row.format,
      })
    }
  }

  const appearances = [...byTournament.values()].sort(
    (a, b) => b.tournament_date.localeCompare(a.tournament_date)
  )

  const totalTournaments = appearances.length

  const placements = appearances
    .map(a => a.placement)
    .filter((p): p is number => p != null)
  const avgPlacement =
    placements.length > 0
      ? Math.round((placements.reduce((s, p) => s + p, 0) / placements.length) * 10) / 10
      : null

  const lastSeen = appearances[0]?.tournament_date ?? null

  // Trending: appeared in 3+ distinct tournaments in the last 60 days
  const cutoff60 = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10)
  const recentCount = appearances.filter(a => a.tournament_date >= cutoff60).length
  const trending = recentCount >= 3

  return Response.json({
    appearances,
    totalTournaments,
    avgPlacement,
    lastSeen,
    trending,
  })
}
