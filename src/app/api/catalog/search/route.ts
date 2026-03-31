import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { searchCatalog } from '@/lib/catalog/searchService'
import { searchPokemonCards } from '@/lib/pokemon/pokemonTcgApi'
import { syncPokemonCards } from '@/lib/pokemon/pokemonTcgSync'
import type { CatalogSearchResponse, CardSearchResult } from '@/types/catalog'

const LOCAL_THRESHOLD = 5

function isPokemon(r: CardSearchResult) {
  return r.franchise_or_brand === 'Pokémon' || r.franchise_or_brand === 'Pokemon'
}

function hasPrices(r: CardSearchResult) {
  return !!r.metadata_json?.tcgplayer
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const q     = searchParams.get('q') ?? ''
  const limit = Number(searchParams.get('limit') ?? '36')

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

  const body: CatalogSearchResponse = { results, query: q, count: results.length }
  return NextResponse.json(body)
}
