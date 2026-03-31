import type { SupabaseClient } from '@supabase/supabase-js'
import type { CardSearchParams, CardSearchResult, CardCatalogItem } from '@/types/catalog'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const MIN_QUERY_LENGTH = 2

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
 * Matches against card_name, set_name, card_number, and franchise_or_brand.
 * Returns an empty array (not an error) when the query is too short.
 */
export async function searchCatalog(
  supabase: SupabaseClient,
  params: CardSearchParams
): Promise<SearchResult> {
  const q = params.q.trim()

  if (q.length < MIN_QUERY_LENGTH) {
    return { results: [], error: null }
  }

  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const pattern = `%${q}%`

  const { data, error } = await supabase
    .from('card_catalog_items')
    .select(
      'catalog_id, category, franchise_or_brand, set_name, year, card_name, card_number, variant, canonical_image_url, metadata_json'
    )
    .or(
      `card_name.ilike.${pattern},` +
      `set_name.ilike.${pattern},` +
      `card_number.ilike.${pattern},` +
      `franchise_or_brand.ilike.${pattern}`
    )
    .order('card_name', { ascending: true })
    .limit(limit)

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
