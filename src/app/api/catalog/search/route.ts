import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { searchCatalog } from '@/lib/catalog/searchService'
import { searchPokemonCards } from '@/lib/pokemon/pokemonTcgApi'
import { syncPokemonCards } from '@/lib/pokemon/pokemonTcgSync'
import type { CatalogSearchResponse, CardSearchResult } from '@/types/catalog'

// Trigger a Pokemon TCG API sync if we have fewer than this many local results.
// 50 is intentionally generous: a common name like "Charizard" has 100+ real
// variants, so 39 local hits doesn't mean the catalog is complete.
const LOCAL_THRESHOLD = 50

function isPokemon(r: CardSearchResult) {
  return r.franchise_or_brand === 'Pokémon' || r.franchise_or_brand === 'Pokemon'
}

function hasPrices(r: CardSearchResult) {
  return !!r.metadata_json?.tcgplayer
}

/**
 * De-duplicate search results by (card_name, card_number, set_name).
 * When two rows represent the same card, prefer the one with a pokemon_tcg_id
 * (synced from the API) over bare seed data.
 */
function deduplicateResults(results: CardSearchResult[]): CardSearchResult[] {
  const seen = new Map<string, CardSearchResult>()
  for (const r of results) {
    const key = [
      (r.card_name ?? '').toLowerCase(),
      (r.card_number ?? '').toLowerCase(),
      (r.set_name ?? '').toLowerCase(),
    ].join('|')

    const existing = seen.get(key)
    if (!existing) {
      seen.set(key, r)
    } else {
      // Prefer the entry that has a pokemon_tcg_id (synced) over raw seed data
      const rHasId       = !!(r.metadata_json as any)?.pokemon_tcg_id
      const existingHasId = !!(existing.metadata_json as any)?.pokemon_tcg_id
      if (rHasId && !existingHasId) {
        seen.set(key, r)
      }
    }
  }
  return [...seen.values()]
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const q     = searchParams.get('q') ?? ''
  const limit = Number(searchParams.get('limit') ?? '100')

  // anon client for reads, service client for writes (bypasses RLS insert policy)
  const supabase      = await createClient()
  const writeSupabase = createServiceClient()

  // 1. Always search local catalog first
  const { results: localResults, error } = await searchCatalog(supabase, { q, limit })
  if (error) {
    return NextResponse.json({ error }, { status: 500 })
  }

  // 2. Fan out to Pokemon TCG API if:
  //    a) fewer than threshold results, OR
  //    b) any Pokemon result is missing TCGPlayer price data, OR
  //    c) all results are pre-2017 (seed data only — fetch modern sets)
  const pokemonResults = localResults.filter(isPokemon)
  const hasModernCards = pokemonResults.some((r) => (r.year ?? 0) >= 2017)
  const needsSync =
    q.trim().length >= 2 &&
    (localResults.length < LOCAL_THRESHOLD ||
      pokemonResults.some((r) => !hasPrices(r)) ||
      (pokemonResults.length > 0 && !hasModernCards))

  let results: CardSearchResult[] = localResults

  if (needsSync) {
    try {
      const apiCards = await searchPokemonCards(q)
      if (apiCards.length > 0) {
        await syncPokemonCards(writeSupabase, apiCards)
        // Re-fetch so all results include fresh metadata + prices
        const { results: refreshed } = await searchCatalog(supabase, { q, limit })
        results = refreshed ?? localResults
      }
    } catch (err) {
      console.error('[PokemonTCG] Sync error:', err)
      // Non-fatal — return local results as-is
    }
  }

  // Deduplicate and cap at the caller-requested limit (dedup works on the
  // larger DB batch fetched by searchCatalog, so we have plenty to choose from)
  const deduped = deduplicateResults(results).slice(0, limit)
  const body: CatalogSearchResponse = { results: deduped, query: q, count: deduped.length }
  return NextResponse.json(body)
}
