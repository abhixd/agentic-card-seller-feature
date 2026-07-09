import { NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export const maxDuration = 120

const BASE = 'https://limitlesstcg.com'
const LIST_URL = `${BASE}/tournaments?game=PTCG&type=major&format=standard`
const UA = 'ScanDex/1.0 research-scraper'
const RATE_LIMIT_MS = 500
const LOOKBACK_DAYS = 14

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms))
}

async function fetchWithUA(url: string): Promise<Response> {
  await sleep(RATE_LIMIT_MS)
  return fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  })
}

function parseTournamentIds(html: string): string[] {
  const ids = new Set<string>()
  const re = /href="\/tournament\/([a-zA-Z0-9_-]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) ids.add(m[1])
  return [...ids]
}

function parseDate(raw: unknown): string | null {
  if (!raw || typeof raw !== 'string') return null
  const d = new Date(raw)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

interface AppearanceRow {
  catalog_id:      string | null
  card_name:       string
  set_name:        string | null
  card_number:     string | null
  tournament_id:   string
  tournament_name: string
  tournament_date: string
  placement:       number | null
  deck_count:      number
  format:          string | null
  player_name:     string | null
  source:          string
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const expected = `Bearer ${process.env.CRON_SECRET}`

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const supabase = createServiceClient()
    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10)

    // 1. Fetch tournament listing
    const listRes = await fetchWithUA(LIST_URL)
    if (!listRes.ok) {
      console.warn(`[cron/sync-tournaments] List fetch returned ${listRes.status}`)
      return Response.json({ stored: 0, note: `list page returned ${listRes.status}` })
    }

    const html = await listRes.text()
    const ids = parseTournamentIds(html)

    if (ids.length === 0) {
      return Response.json({ stored: 0, note: 'no tournament IDs found on listing page' })
    }

    let totalStored = 0

    for (const tid of ids) {
      // 2. Fetch tournament details
      const tRes = await fetchWithUA(`${BASE}/api/tournament/${tid}`)
      if (!tRes.ok) continue

      let tournament: Record<string, unknown>
      try {
        tournament = await tRes.json()
      } catch {
        continue
      }

      const t = (tournament.data ?? tournament) as Record<string, unknown>
      const rawDate = t.date ?? t.tournament_date ?? t.start_date
      const tDate = parseDate(rawDate as string | undefined)
      if (!tDate || tDate < cutoff) continue

      const tName  = (t.name ?? t.title ?? `Tournament ${tid}`) as string
      const format = (t.format ?? 'Standard') as string

      const placements = Array.isArray(t.placements)
        ? t.placements
        : Array.isArray(t.players)
          ? t.players
          : []

      const top8 = (placements as Record<string, unknown>[])
        .filter(p => ((p.placement ?? p.rank ?? 99) as number) <= 8)
        .slice(0, 8)

      if (top8.length === 0) continue

      const rows: AppearanceRow[] = []

      for (const player of top8) {
        const placement  = (player.placement ?? player.rank ?? null) as number | null
        const playerName = (player.name ?? player.player_name ?? player.player ?? null) as string | null
        const deckId     = player.decklist_id ?? player.deck_id ?? player.id

        if (!deckId) continue

        // 3. Fetch decklist
        const dlRes = await fetchWithUA(`${BASE}/api/decklist/${deckId}`)
        if (!dlRes.ok) continue

        let decklist: Record<string, unknown>
        try {
          decklist = await dlRes.json()
        } catch {
          continue
        }

        const cards = Array.isArray(decklist.cards)
          ? decklist.cards
          : Array.isArray(decklist.decklist)
            ? decklist.decklist
            : []

        for (const card of cards as Record<string, unknown>[]) {
          const cardName = (card.name ?? card.card_name ?? card.card) as string | undefined
          if (!cardName) continue

          const setName   = (card.set ?? card.set_name ?? card.expansion ?? null) as string | null
          const cardNum   = (card.number ?? card.card_number ?? null) as string | null
          const deckCount = ((card.count ?? card.quantity ?? card.qty ?? 1) as number)

          // 4. Match to catalog
          let catalogId: string | null = null
          const catalogQuery = supabase
            .from('card_catalog_items')
            .select('catalog_id')
            .ilike('card_name', cardName)

          if (setName) catalogQuery.ilike('set_name', setName)

          const { data: match } = await catalogQuery.limit(1).maybeSingle()
          if (match) catalogId = (match as { catalog_id: string }).catalog_id

          rows.push({
            catalog_id:      catalogId,
            card_name:       cardName,
            set_name:        setName,
            card_number:     cardNum,
            tournament_id:   tid,
            tournament_name: tName,
            tournament_date: tDate,
            placement,
            deck_count:      deckCount,
            format,
            player_name:     playerName,
            source:          'limitlesstcg.com',
          })
        }
      }

      if (rows.length > 0) {
        const { error } = await supabase
          .from('tournament_appearances')
          .upsert(rows, {
            onConflict: 'tournament_id,card_name,set_name,placement',
            ignoreDuplicates: true,
          })

        if (error) {
          console.error(`[cron/sync-tournaments] Upsert error for ${tid}:`, error.message)
        } else {
          totalStored += rows.length
          console.log(`[cron/sync-tournaments] ✓ ${tName} ${tDate} — ${rows.length} rows`)
        }
      }
    }

    return Response.json({ stored: totalStored })
  } catch (err) {
    console.error('[cron/sync-tournaments] Error:', err)
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
