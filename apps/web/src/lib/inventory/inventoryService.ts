import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  InventoryItem,
  InventoryListItem,
  InventoryDetail,
  SaveToInventoryRequest,
  UpdateInventoryRequest,
} from '@/types/inventory'

// ---------------------------------------------------------------
// Save a card to inventory
// ---------------------------------------------------------------
export async function saveToInventory(
  supabase: SupabaseClient,
  userId: string,
  req: SaveToInventoryRequest
): Promise<{ item: InventoryItem | null; error: string | null }> {
  const { data, error } = await supabase
    .from('inventory_items')
    .insert({
      user_id:          userId,
      catalog_id:       req.catalogId,
      analysis_id:      req.analysisId ?? null,
      status:           'owned',
      acquisition_cost: req.acquisitionCost,
      notes:            req.notes ?? null,
    })
    .select('*')
    .single()

  if (error || !data) {
    return { item: null, error: error?.message ?? 'Failed to save to inventory.' }
  }
  return { item: data as InventoryItem, error: null }
}

// ---------------------------------------------------------------
// List all inventory items for a user (newest first)
// ---------------------------------------------------------------
export async function listInventory(
  supabase: SupabaseClient,
  userId: string
): Promise<{ items: InventoryListItem[]; error: string | null }> {
  const { data, error } = await supabase
    .from('inventory_items')
    .select(`
      item_id,
      catalog_id,
      analysis_id,
      status,
      acquisition_cost,
      notes,
      created_at,
      updated_at,
      card_catalog_items (
        card_name,
        franchise_or_brand,
        set_name,
        year,
        card_number,
        variant,
        category
      ),
      card_analyses (
        recommendation_type,
        estimated_market_value
      )
    `)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) {
    return { items: [], error: error.message }
  }

  const items: InventoryListItem[] = (data ?? []).map((row: any) => ({
    item_id:               row.item_id,
    catalog_id:            row.catalog_id,
    analysis_id:           row.analysis_id,
    status:                row.status,
    acquisition_cost:      row.acquisition_cost,
    notes:                 row.notes,
    created_at:            row.created_at,
    updated_at:            row.updated_at,
    card:                  {
      card_name:          row.card_catalog_items?.card_name          ?? '',
      franchise_or_brand: row.card_catalog_items?.franchise_or_brand ?? '',
      set_name:           row.card_catalog_items?.set_name           ?? '',
      year:               row.card_catalog_items?.year               ?? null,
      card_number:        row.card_catalog_items?.card_number        ?? null,
      variant:            row.card_catalog_items?.variant            ?? null,
      category:           row.card_catalog_items?.category           ?? '',
    },
    recommendation_type:    row.card_analyses?.recommendation_type    ?? null,
    estimated_market_value: row.card_analyses?.estimated_market_value ?? null,
  }))

  return { items, error: null }
}

// ---------------------------------------------------------------
// Get a single inventory item by itemId (user-scoped)
// ---------------------------------------------------------------
export async function getInventoryItem(
  supabase: SupabaseClient,
  userId: string,
  itemId: string
): Promise<{ item: InventoryDetail | null; error: string | null }> {
  const { data, error } = await supabase
    .from('inventory_items')
    .select(`
      item_id,
      catalog_id,
      analysis_id,
      status,
      acquisition_cost,
      notes,
      created_at,
      updated_at,
      card_catalog_items (
        card_name,
        franchise_or_brand,
        set_name,
        year,
        card_number,
        variant,
        category
      ),
      card_analyses (
        recommendation_type,
        estimated_market_value,
        rationale_text
      )
    `)
    .eq('item_id', itemId)
    .eq('user_id', userId)
    .single()

  if (error || !data) {
    return { item: null, error: error?.message ?? 'Item not found.' }
  }

  const row = data as any
  const item: InventoryDetail = {
    item_id:               row.item_id,
    catalog_id:            row.catalog_id,
    analysis_id:           row.analysis_id,
    status:                row.status,
    acquisition_cost:      row.acquisition_cost,
    notes:                 row.notes,
    created_at:            row.created_at,
    updated_at:            row.updated_at,
    card: {
      card_name:          row.card_catalog_items?.card_name          ?? '',
      franchise_or_brand: row.card_catalog_items?.franchise_or_brand ?? '',
      set_name:           row.card_catalog_items?.set_name           ?? '',
      year:               row.card_catalog_items?.year               ?? null,
      card_number:        row.card_catalog_items?.card_number        ?? null,
      variant:            row.card_catalog_items?.variant            ?? null,
      category:           row.card_catalog_items?.category           ?? '',
    },
    recommendation_type:    row.card_analyses?.recommendation_type    ?? null,
    estimated_market_value: row.card_analyses?.estimated_market_value ?? null,
    rationale_text:         row.card_analyses?.rationale_text         ?? null,
  }

  return { item, error: null }
}

// ---------------------------------------------------------------
// Update status / notes / acquisition_cost
// ---------------------------------------------------------------
export async function updateInventoryItem(
  supabase: SupabaseClient,
  userId: string,
  itemId: string,
  updates: UpdateInventoryRequest
): Promise<{ item: InventoryItem | null; error: string | null }> {
  const patch: Record<string, unknown> = {}
  if (updates.status          !== undefined) patch.status           = updates.status
  if (updates.notes           !== undefined) patch.notes            = updates.notes
  if (updates.acquisitionCost !== undefined) patch.acquisition_cost = updates.acquisitionCost

  if (Object.keys(patch).length === 0) {
    return { item: null, error: 'No fields to update.' }
  }

  const { data, error } = await supabase
    .from('inventory_items')
    .update(patch)
    .eq('item_id', itemId)
    .eq('user_id', userId)
    .select('*')
    .single()

  if (error || !data) {
    return { item: null, error: error?.message ?? 'Update failed.' }
  }
  return { item: data as InventoryItem, error: null }
}
