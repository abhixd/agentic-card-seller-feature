// ---------------------------------------------------------------
// Catalog types — card identity and search contracts
// ---------------------------------------------------------------

/** A canonical card in the catalog database. */
export interface CardCatalogItem {
  catalog_id: string
  category: 'sports' | 'tcg' | 'other'
  franchise_or_brand: string
  set_name: string
  year: number | null
  card_name: string
  card_number: string | null
  variant: string | null
  canonical_image_url: string | null
  metadata_json: Record<string, unknown>
  created_at: string
}

/** Input parameters for the catalog search service. */
export interface CardSearchParams {
  /** Free-text query — matched against card_name, set_name, card_number, franchise_or_brand */
  q: string
  limit?: number
  /**
   * Optional floor for the raw DB fetch size.
   * Pass catalog_sync_log.api_total + buffer so the DB query always returns
   * at least as many rows as the API is known to have — preventing popular
   * names (Pikachu: ~450 variants) from being silently cut off by the
   * default DB_FETCH_MULTIPLIER heuristic.
   */
  dbLimitOverride?: number
}

/** Typed search result row (subset of CardCatalogItem for list display). */
export interface CardSearchResult {
  catalog_id:          string
  category:            string
  franchise_or_brand:  string
  set_name:            string
  year:                number | null
  card_name:           string
  card_number:         string | null
  variant:             string | null
  canonical_image_url: string | null
  metadata_json:       Record<string, any> | null
}

/** API response shape for the search endpoint. */
export interface CatalogSearchResponse {
  results: CardSearchResult[]
  query: string
  count: number
  /** True when a background catalog sync was kicked off — client may re-fetch after a delay to get fresh results. */
  syncing?: boolean
}

/** API response shape for the card detail endpoint. */
export interface CatalogDetailResponse {
  card: CardCatalogItem
}
