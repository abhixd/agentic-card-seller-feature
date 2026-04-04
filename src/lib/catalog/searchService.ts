import type { SupabaseClient } from '@supabase/supabase-js'
import type { CardSearchParams, CardSearchResult, CardCatalogItem } from '@/types/catalog'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 3000   // raised — popular names can have 400+ unique variants
const MIN_QUERY_LENGTH = 2

// We fetch a much larger batch from the DB than the caller requested,
// so deduplication (which happens in the API route) has enough rows to
// work with and can still return up to DEFAULT_LIMIT unique results.
const DB_FETCH_MULTIPLIER = 5

export interface SearchResult {
  results: CardSearchResult[]
  error: string | null
}

export interface DetailResult {
  card: CardCatalogItem | null
  error: string | null
}

/**
 * Search the card catalog by free text.
 *
 * Multi-token support: "Charizard 151" is split into ["Charizard", "151"].
 * Each token must match at least one of the searchable columns, and ALL
 * tokens must match — i.e. token conditions are AND-ed together.
 * This means "Charizard 151" finds Charizard cards from the "Pokémon 151" set.
 *
 * Returns an empty array (not an error) when the query is too short.
 *
 * Fetches DB_FETCH_MULTIPLIER × the requested limit so the caller can
 * deduplicate and still return up to `limit` unique results.
 */
export async function searchCatalog(
  supabase: SupabaseClient,
  params: CardSearchParams
): Promise<SearchResult> {
  const q = params.q.trim()

  if (q.length < MIN_QUERY_LENGTH) {
    return { results: [], error: null }
  }

  const requestedLimit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  // dbLimitOverride lets the caller (e.g. the search route) pass a minimum floor
  // based on how many cards the API is known to have (from catalog_sync_log.api_total).
  // Without an override, fall back to the multiplier heuristic, capped at 4000.
  const dbLimit = params.dbLimitOverride
    ? Math.max(requestedLimit * DB_FETCH_MULTIPLIER, params.dbLimitOverride)
    : Math.min(requestedLimit * DB_FETCH_MULTIPLIER, 4000)

  // Split into tokens; each must match at least one searchable field
  const tokens = q.split(/\s+/).filter(Boolean)

  let query = supabase
    .from('card_catalog_items')
    .select(
      'catalog_id, category, franchise_or_brand, set_name, year, card_name, card_number, variant, canonical_image_url, metadata_json'
    )

  // AND all tokens: each .or() call narrows the result set further
  for (const token of tokens) {
    const pat = `%${token}%`
    query = query.or(
      `card_name.ilike.${pat},` +
      `set_name.ilike.${pat},` +
      `card_number.ilike.${pat},` +
      `franchise_or_brand.ilike.${pat}`
    )
  }

  const { data, error } = await query
    .order('card_name', { ascending: true })
    .limit(dbLimit)

  if (error) {
    return { results: [], error: error.message }
  }

  return { results: (data ?? []) as CardSearchResult[], error: null }
}

/**
 * Fetch a single card by its catalog ID.
 */
export async function getCatalogItem(
  supabase: SupabaseClient,
  catalogId: string
): Promise<DetailResult> {
  if (!catalogId) {
    return { card: null, error: 'Missing catalog ID.' }
  }

  const { data, error } = await supabase
    .from('card_catalog_items')
    .select('*')
    .eq('catalog_id', catalogId)
    .single()

  if (error) {
    return { card: null, error: error.message }
  }

  return { card: data as CardCatalogItem, error: null }
}
