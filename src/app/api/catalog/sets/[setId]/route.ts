import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { syncPokemonCards } from '@/lib/pokemon/pokemonTcgSync'
import type { PokemonTcgCard } from '@/lib/pokemon/pokemonTcgApi'
import type { CardSearchResult } from '@/types/catalog'

const BASE_URL = 'https://api.pokemontcg.io/v2'

function getHeaders(): Record<string, string> {
  const apiKey = process.env.POKEMON_TCG_API_KEY
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['X-Api-Key'] = apiKey
  return headers
}

async function fetchSetCardsFromApi(setId: string): Promise<PokemonTcgCard[]> {
  const params = new URLSearchParams({
    q:        `set.id:${setId}`,
    pageSize: '250',
    orderBy:  'number',
  })
  const res = await fetch(`${BASE_URL}/cards?${params}`, {
    headers: getHeaders(),
    next: { revalidate: 0 },
  })
  if (!res.ok) return []
  const json = await res.json()
  return (json.data ?? []) as PokemonTcgCard[]
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ setId: string }> }
) {
  const { setId } = await params
  const supabase = await createClient()

  // Query our catalog for cards in this set
  const { data: rows } = await supabase
    .from('card_catalog_items')
    .select(
      'catalog_id, category, franchise_or_brand, set_name, year, card_name, card_number, variant, canonical_image_url, metadata_json'
    )
    .eq('franchise_or_brand', 'Pokémon')
    .filter('metadata_json->>set_id', 'eq', setId)
    .order('card_number', { ascending: true })

  const existing = (rows ?? []) as CardSearchResult[]

  // If fewer than 10 results, trigger a sync from pokemontcg.io
  if (existing.length < 10) {
    try {
      const apiCards = await fetchSetCardsFromApi(setId)
      if (apiCards.length > 0) {
        await syncPokemonCards(supabase, apiCards)
      }

      // Re-query after sync
      const { data: refreshed } = await supabase
        .from('card_catalog_items')
        .select(
          'catalog_id, category, franchise_or_brand, set_name, year, card_name, card_number, variant, canonical_image_url, metadata_json'
        )
        .eq('franchise_or_brand', 'Pokémon')
        .filter('metadata_json->>set_id', 'eq', setId)
        .order('card_number', { ascending: true })

      const cards = (refreshed ?? []) as CardSearchResult[]
      return Response.json({ cards, setId, total: cards.length })
    } catch (err) {
      console.error(`[catalog/sets/${setId}] Sync error:`, err)
      return Response.json({ cards: existing, setId, total: existing.length })
    }
  }

  return Response.json({ cards: existing, setId, total: existing.length })
}
