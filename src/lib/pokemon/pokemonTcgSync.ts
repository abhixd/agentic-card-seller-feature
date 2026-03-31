// ---------------------------------------------------------------
// Syncs Pokemon TCG API results into card_catalog_items.
// Deduplication strategy (in priority order):
//   1. metadata_json.pokemon_tcg_id  (exact)
//   2. card_name + card_number_prefix (handles seeded cards like "4/102" vs "4")
// Existing rows are UPDATED with fresh prices on every sync.
// ---------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'
import type { PokemonTcgCard } from './pokemonTcgApi'
import type { CardSearchResult } from '@/types/catalog'

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

/** "4/102" → "4",  "H6/H32" → "H6",  "4" → "4" */
function numPrefix(n: string | null): string {
  if (!n) return ''
  return n.split('/')[0].trim().toLowerCase()
}

function toVariant(card: PokemonTcgCard): string | null {
  const rarity = card.rarity ?? ''
  const skip = ['common', 'uncommon', 'rare']
  if (!rarity || skip.includes(rarity.toLowerCase())) return null
  return rarity
}

function toYear(releaseDate: string): number | null {
  const year = parseInt(releaseDate.split('/')[0], 10)
  return isNaN(year) ? null : year
}

export function buildMetadata(card: PokemonTcgCard): Record<string, unknown> {
  return {
    pokemon_tcg_id:    card.id,
    set_id:            card.set.id,
    set_series:        card.set.series,
    set_total:         card.set.total,
    set_symbol_url:    card.set.images?.symbol ?? null,
    supertype:         card.supertype,
    subtypes:          card.subtypes ?? [],
    rarity:            card.rarity ?? null,
    hp:                card.hp ?? null,
    types:             card.types ?? [],
    level:             card.level ?? null,
    evolves_from:      card.evolvesFrom ?? null,
    artist:            card.artist ?? null,
    flavor_text:       card.flavorText ?? null,
    pokedex_numbers:   card.nationalPokedexNumbers ?? [],
    abilities:         card.abilities ?? [],
    attacks:           card.attacks ?? [],
    weaknesses:        card.weaknesses ?? [],
    resistances:       card.resistances ?? [],
    retreat_cost:      card.retreatCost ?? [],
    converted_retreat: card.convertedRetreatCost ?? null,
    image_small:       card.images?.small ?? null,
    image_large:       card.images?.large ?? null,
    tcgplayer:         card.tcgplayer  ?? null,
    cardmarket:        card.cardmarket ?? null,
    prices_updated_at: new Date().toISOString(),
  }
}

export function pokemonCardToRow(card: PokemonTcgCard): Record<string, unknown> {
  return {
    category:            'tcg',
    franchise_or_brand:  'Pokémon',
    set_name:            card.set.name,
    year:                toYear(card.set.releaseDate),
    card_name:           card.name,
    card_number:         card.number ?? null,
    variant:             toVariant(card),
    canonical_image_url: card.images?.small ?? null,
    metadata_json:       buildMetadata(card),
  }
}

// ---------------------------------------------------------------
// Upsert a batch of Pokemon TCG cards.
// Returns updated CardSearchResult[] for the full batch.
// ---------------------------------------------------------------

export async function syncPokemonCards(
  supabase: SupabaseClient,
  cards:    PokemonTcgCard[],
): Promise<CardSearchResult[]> {
  if (cards.length === 0) return []

  // 1. Load ALL existing Pokemon rows to build dedup maps
  const { data: existing } = await supabase
    .from('card_catalog_items')
    .select('catalog_id, card_name, card_number, metadata_json')
    .or('franchise_or_brand.eq.Pokémon,franchise_or_brand.eq.Pokemon')

  // Map 1: pokemon_tcg_id → catalog_id
  const byTcgId = new Map<string, string>()
  // Map 2: "name|numPrefix" → catalog_id  (handles seeded cards with "4/102" format)
  const byNameNum = new Map<string, string>()

  for (const row of (existing ?? []) as any[]) {
    if (row.metadata_json?.pokemon_tcg_id) {
      byTcgId.set(row.metadata_json.pokemon_tcg_id, row.catalog_id)
    }
    const key = `${(row.card_name ?? '').toLowerCase()}|${numPrefix(row.card_number)}`
    byNameNum.set(key, row.catalog_id)
  }

  function findExisting(card: PokemonTcgCard): string | null {
    // Priority 1: exact pokemon_tcg_id match
    if (byTcgId.has(card.id)) return byTcgId.get(card.id)!
    // Priority 2: name + number prefix (catches seeded cards)
    const key = `${card.name.toLowerCase()}|${card.number.toLowerCase()}`
    return byNameNum.get(key) ?? null
  }

  // 2. Split into updates vs inserts
  const toInsert: Record<string, unknown>[] = []
  const toUpdate: { catalogId: string; card: PokemonTcgCard }[] = []

  for (const card of cards) {
    const existingId = findExisting(card)
    if (existingId) {
      toUpdate.push({ catalogId: existingId, card })
    } else {
      toInsert.push(pokemonCardToRow(card))
    }
  }

  // 3. Insert new cards
  if (toInsert.length > 0) {
    await supabase.from('card_catalog_items').insert(toInsert)
  }

  // 4. Update existing cards with fresh metadata + prices
  for (const { catalogId, card } of toUpdate) {
    await supabase
      .from('card_catalog_items')
      .update({
        // Normalise franchise name and image while we're here
        franchise_or_brand:  'Pokémon',
        set_name:            card.set.name,
        year:                toYear(card.set.releaseDate),
        card_number:         card.number,   // normalise "4/102" → "4"
        variant:             toVariant(card),
        canonical_image_url: card.images?.small ?? null,
        metadata_json:       buildMetadata(card),
      })
      .eq('catalog_id', catalogId)
  }

  // 5. Re-fetch the updated rows for all cards in this batch so caller gets fresh data
  const tcgIds = cards.map((c) => c.id)
  const { data: refreshed } = await supabase
    .from('card_catalog_items')
    .select('catalog_id, category, franchise_or_brand, set_name, year, card_name, card_number, variant, canonical_image_url, metadata_json')
    .or('franchise_or_brand.eq.Pokémon,franchise_or_brand.eq.Pokemon')

  const refreshedRows = (refreshed ?? []) as any[]

  const result: CardSearchResult[] = []
  for (const tcgId of tcgIds) {
    const row = refreshedRows.find((r) => r.metadata_json?.pokemon_tcg_id === tcgId)
    if (row) {
      result.push({
        catalog_id:          row.catalog_id,
        category:            row.category,
        franchise_or_brand:  row.franchise_or_brand,
        set_name:            row.set_name,
        year:                row.year,
        card_name:           row.card_name,
        card_number:         row.card_number,
        variant:             row.variant,
        canonical_image_url: row.canonical_image_url,
        metadata_json:       row.metadata_json ?? null,
      })
    }
  }
  return result
}
