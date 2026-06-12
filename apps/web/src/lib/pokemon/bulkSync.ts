// ---------------------------------------------------------------
// Bulk sync ALL Pokemon TCG cards from pokemontcg.io into Supabase.
// Only syncs cards that have TCGPlayer pricing data.
// Uses a single dedup map (loaded once) to avoid per-batch re-fetches.
// ---------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'
import type { PokemonTcgCard, PokemonTcgSet } from './pokemonTcgApi'
import { pokemonCardToRow, buildMetadata } from './pokemonTcgSync'

const BASE_URL = 'https://api.pokemontcg.io/v2'

function getHeaders(): Record<string, string> {
  const apiKey = process.env.POKEMON_TCG_API_KEY
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['X-Api-Key'] = apiKey
  return headers
}

async function fetchSets(): Promise<PokemonTcgSet[]> {
  const res = await fetch(`${BASE_URL}/sets?pageSize=250`, {
    headers: getHeaders(),
    next: { revalidate: 0 },
  })
  if (!res.ok) throw new Error(`Failed to fetch sets: ${res.status}`)
  const json = await res.json()
  return (json.data ?? []) as PokemonTcgSet[]
}

async function fetchCardsForSet(setId: string): Promise<PokemonTcgCard[]> {
  const params = new URLSearchParams({
    q:        `set.id:${setId}`,
    pageSize: '250',
    page:     '1',
  })
  const res = await fetch(`${BASE_URL}/cards?${params}`, {
    headers: getHeaders(),
    next: { revalidate: 0 },
  })
  if (!res.ok) {
    console.error(`[BulkSync] Failed to fetch cards for set ${setId}: ${res.status}`)
    return []
  }
  const json = await res.json()
  return (json.data ?? []) as PokemonTcgCard[]
}

function toYear(releaseDate: string): number | null {
  const year = parseInt(releaseDate.split('/')[0], 10)
  return isNaN(year) ? null : year
}

export async function bulkSyncAllCards(
  supabase: SupabaseClient,
  onProgress?: (msg: string) => void,
  opts?: { startIndex?: number; batchSize?: number },
): Promise<{ sets: number; cards: number; inserted: number; updated: number; nextIndex?: number; totalSets?: number }> {
  const log = (msg: string) => {
    console.log(`[BulkSync] ${msg}`)
    onProgress?.(msg)
  }

  // Step 1: Fetch all sets
  log('Fetching all sets from pokemontcg.io...')
  const sets = await fetchSets()
  log(`Found ${sets.length} sets`)

  // Step 2: Load existing Pokemon cards once to build dedup map
  log('Loading existing Pokemon cards from Supabase...')
  const { data: existing } = await supabase
    .from('card_catalog_items')
    .select('catalog_id, metadata_json')
    .or('franchise_or_brand.eq.Pokémon,franchise_or_brand.eq.Pokemon')

  // Map: pokemon_tcg_id → catalog_id
  const byTcgId = new Map<string, string>()
  for (const row of (existing ?? []) as Array<{ catalog_id: string; metadata_json: Record<string, unknown> | null }>) {
    const tcgId = row.metadata_json?.pokemon_tcg_id as string | undefined
    if (tcgId) byTcgId.set(tcgId, row.catalog_id)
  }
  log(`Loaded ${byTcgId.size} existing cards`)

  const startIndex = opts?.startIndex ?? 0
  const batchSize  = opts?.batchSize  ?? sets.length  // default: all sets
  const setsSlice  = sets.slice(startIndex, startIndex + batchSize)

  let totalCards = 0
  let totalInserted = 0
  let totalUpdated = 0
  let setsProcessed = 0

  // Step 3: Process each set in the slice
  for (const set of setsSlice) {
    if (set.total === 0) continue

    log(`Syncing set: ${set.name} (${set.id}) — ${set.total} cards`)
    const cards = await fetchCardsForSet(set.id)

    // Step 4: Filter cards with no tcgplayer prices
    const pricedCards = cards.filter(
      (c) => c.tcgplayer?.prices && Object.keys(c.tcgplayer.prices).length > 0
    )

    if (pricedCards.length === 0) {
      log(`  Skipping ${set.name} — no priced cards`)
      setsProcessed++
      continue
    }

    // Step 5: Split into inserts and updates
    const toInsert: Record<string, unknown>[] = []
    const toUpdate: { catalogId: string; card: PokemonTcgCard }[] = []

    for (const card of pricedCards) {
      const existingId = byTcgId.get(card.id)
      if (existingId) {
        toUpdate.push({ catalogId: existingId, card })
      } else {
        toInsert.push(pokemonCardToRow(card))
      }
    }

    // Step 6: Bulk insert new cards in batches of 100
    for (let i = 0; i < toInsert.length; i += 100) {
      const batch = toInsert.slice(i, i + 100)
      const { error } = await supabase.from('card_catalog_items').insert(batch)
      if (error) {
        console.error(`[BulkSync] Insert error for ${set.name}:`, error.message)
      } else {
        totalInserted += batch.length
        // Update dedup map with new inserts won't have IDs yet, but that's fine
        // since we're processing each set once
      }
    }

    // Step 7: Update existing cards in batches of 20 concurrent
    for (let i = 0; i < toUpdate.length; i += 20) {
      const batch = toUpdate.slice(i, i + 20)
      await Promise.all(
        batch.map(({ catalogId, card }) =>
          supabase
            .from('card_catalog_items')
            .update({
              franchise_or_brand:  'Pokémon',
              set_name:            card.set.name,
              year:                toYear(card.set.releaseDate),
              canonical_image_url: card.images?.small ?? null,
              metadata_json:       buildMetadata(card),
            })
            .eq('catalog_id', catalogId)
        )
      )
      totalUpdated += batch.length
    }

    totalCards += pricedCards.length
    setsProcessed++
    log(`  ${set.name}: ${toInsert.length} inserted, ${toUpdate.length} updated`)
  }

  const nextStart  = startIndex + setsSlice.length
  const hasMore    = nextStart < sets.length
  log(`Batch complete: ${setsProcessed} sets (${startIndex}–${nextStart - 1} of ${sets.length}), ${totalCards} cards, ${totalInserted} inserted, ${totalUpdated} updated${hasMore ? ` — next: ${nextStart}` : ' — DONE'}`)
  return {
    sets:      setsProcessed,
    cards:     totalCards,
    inserted:  totalInserted,
    updated:   totalUpdated,
    nextIndex: hasMore ? nextStart : undefined,
    totalSets: sets.length,
  }
}
