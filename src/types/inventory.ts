import type { CardSummary, RecommendationType } from './analysis'

export type InventoryStatus = 'owned' | 'listed' | 'sent_to_grading' | 'sold'

// ---------------------------------------------------------------
// Core inventory item (as stored in DB)
// ---------------------------------------------------------------
export interface InventoryItem {
  item_id:          string
  user_id:          string
  catalog_id:       string
  analysis_id:      string | null
  status:           InventoryStatus
  acquisition_cost: number
  notes:            string | null
  created_at:       string
  updated_at:       string
}

// ---------------------------------------------------------------
// List view — enriched with card summary + latest recommendation
// ---------------------------------------------------------------
export interface InventoryListItem {
  item_id:               string
  catalog_id:            string
  analysis_id:           string | null
  status:                InventoryStatus
  acquisition_cost:      number
  notes:                 string | null
  created_at:            string
  updated_at:            string
  card:                  CardSummary
  recommendation_type:   RecommendationType | null   // from latest analysis
  estimated_market_value: number | null              // from latest analysis
}

// ---------------------------------------------------------------
// Detail view — full item + card summary
// ---------------------------------------------------------------
export interface InventoryDetail {
  item_id:               string
  catalog_id:            string
  analysis_id:           string | null
  status:                InventoryStatus
  acquisition_cost:      number
  notes:                 string | null
  created_at:            string
  updated_at:            string
  card:                  CardSummary
  recommendation_type:   RecommendationType | null
  estimated_market_value: number | null
  rationale_text:        string | null
}

// ---------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------
export interface SaveToInventoryRequest {
  catalogId:       string
  analysisId:      string | null
  acquisitionCost: number
  notes?:          string
}

export interface UpdateInventoryRequest {
  status?:          InventoryStatus
  notes?:           string | null
  acquisitionCost?: number
}
