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
}

/** API response shape for the card detail endpoint. */
export interface CatalogDetailResponse {
  card: CardCatalogItem
}
