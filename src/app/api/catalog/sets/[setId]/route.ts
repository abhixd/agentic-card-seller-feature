import { NextRequest } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { syncPokemonCards } from '@/lib/pokemon/pokemonTcgSync'
import type { PokemonTcgCard } from '@/lib/pokemon/pokemonTcgApi'
import type { CardSearchResult } from '@/types/catalog'

const BASE_URL = 'https://api.pokemontcg.io/v2'

interface SetApiResponse {
  cards:   CardSearchResult[]
  setId:   string
  total:   number
  setMeta: {
    name:        string
    series:      string
    total:       number
    logo?:       string
    symbol?:     string
    releaseDate?: string
  } | null
}

function getHeaders(): Record<string, string> {
  const apiKey  = process.env.POKEMON_TCG_API_KEY
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['X-Api-Key'] = apiKey
  return headers
}

async function fetchSetCardsFromApi(setId: string): Promise<PokemonTcgCard[]> {
  const params = new URLSearchParams({ q: `set.id:${setId}`, pageSize: '250', orderBy: 'number' })
  const res = await fetch(`${BASE_URL}/cards?${params}`, {
    headers: getHeaders(),
    next: { revalidate: 3600 },
  })
  if (!res.ok) return []
  const json = await res.json()
  return (json.data ?? []) as PokemonTcgCard[]
}

async function fetchSetMeta(setId: string) {
  try {
    const res = await fetch(`${BASE_URL}/sets/${setId}`, {
      headers: getHeaders(),
      next: { revalidate: 86400 },
    })
    if (!res.ok) return null
    const json = await res.json()
    const s = json.data
    if (!s) return null
    return {
      name:        s.name        ?? setId,
      series:      s.series      ?? '',
      total:       s.total       ?? 0,
      logo:        s.images?.logo ?? null,
      symbol:      s.images?.symbol ?? null,
      releaseDate: s.releaseDate ?? null,
    }
  } catch {
    return null
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ setId: string }> }
) {
  const { setId } = await params
  const readClient  = await createClient()
  const writeClient = createServiceClient()

  // Query our catalog for all cards in this set (no default 1000-row limit → use range)
  const { data: rows } = await readClient
    .from('card_catalog_items')
    .select(
      'catalog_id, category, franchise_or_brand, set_name, year, card_name, card_number, variant, canonical_image_url, metadata_json'
    )
    .eq('franchise_or_brand', 'Pokémon')
    .filter('metadata_json->>set_id', 'eq', setId)
    .range(0, 999)

  const existing = (rows ?? []) as CardSearchResult[]

  // Fetch set meta and trigger sync in parallel if needed
  const [setMeta] = await Promise.all([
    fetchSetMeta(setId),
    (async () => {
      if (existing.length < 10) {
        try {
          const apiCards = await fetchSetCardsFromApi(setId)
          if (apiCards.length > 0) {
            await syncPokemonCards(writeClient, apiCards)
          }
        } catch (err) {
          console.error(`[catalog/sets/${setId}] Sync error:`, err)
        }
      }
    })(),
  ])

  // Re-query if we triggered a sync
  if (existing.length < 10) {
    const { data: refreshed } = await readClient
      .from('card_catalog_items')
      .select(
        'catalog_id, category, franchise_or_brand, set_name, year, card_name, card_number, variant, canonical_image_url, metadata_json'
      )
      .eq('franchise_or_brand', 'Pokémon')
      .filter('metadata_json->>set_id', 'eq', setId)
      .range(0, 999)

    const cards = (refreshed ?? []) as CardSearchResult[]
    const body: SetApiResponse = { cards, setId, total: cards.length, setMeta }
    return Response.json(body)
  }

  const body: SetApiResponse = { cards: existing, setId, total: existing.length, setMeta }
  return Response.json(body)
}
