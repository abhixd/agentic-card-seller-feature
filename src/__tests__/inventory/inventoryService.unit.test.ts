import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  saveToInventory,
  listInventory,
  getInventoryItem,
  updateInventoryItem,
} from '@/lib/inventory/inventoryService'
import type { InventoryItem } from '@/types/inventory'

// ---------------------------------------------------------------------------
// Shared mock Supabase builder
// ---------------------------------------------------------------------------

function mockSupabase(chainResult: { data: unknown; error: unknown }) {
  const chain: any = {
    insert:    vi.fn().mockReturnThis(),
    select:    vi.fn().mockReturnThis(),
    update:    vi.fn().mockReturnThis(),
    eq:        vi.fn().mockReturnThis(),
    order:     vi.fn().mockReturnThis(),
    single:    vi.fn().mockResolvedValue(chainResult),
    maybeSingle: vi.fn().mockResolvedValue(chainResult),
  }
  return {
    from: vi.fn().mockReturnValue(chain),
    _chain: chain,
  }
}

function mockSupabaseList(result: { data: unknown; error: unknown }) {
  // list queries don't end with .single(), they resolve from .order()
  const chain: any = {
    insert:    vi.fn().mockReturnThis(),
    select:    vi.fn().mockReturnThis(),
    update:    vi.fn().mockReturnThis(),
    eq:        vi.fn().mockReturnThis(),
    order:     vi.fn().mockResolvedValue(result),
    single:    vi.fn().mockResolvedValue(result),
  }
  return { from: vi.fn().mockReturnValue(chain), _chain: chain }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATALOG_ID  = '550e8400-e29b-41d4-a716-446655440001'
const ANALYSIS_ID = '550e8400-e29b-41d4-a716-446655440002'
const ITEM_ID     = '550e8400-e29b-41d4-a716-446655440003'
const USER_ID     = '550e8400-e29b-41d4-a716-446655440004'

const MOCK_ROW: InventoryItem = {
  item_id:          ITEM_ID,
  user_id:          USER_ID,
  catalog_id:       CATALOG_ID,
  analysis_id:      ANALYSIS_ID,
  status:           'owned',
  acquisition_cost: 25,
  notes:            null,
  created_at:       '2026-03-29T00:00:00Z',
  updated_at:       '2026-03-29T00:00:00Z',
}

// ---------------------------------------------------------------------------
// saveToInventory
// ---------------------------------------------------------------------------

describe('saveToInventory', () => {
  it('returns saved item on success', async () => {
    const supabase = mockSupabase({ data: MOCK_ROW, error: null })
    const { item, error } = await saveToInventory(supabase as any, USER_ID, {
      catalogId:       CATALOG_ID,
      analysisId:      ANALYSIS_ID,
      acquisitionCost: 25,
    })
    expect(error).toBeNull()
    expect(item?.item_id).toBe(ITEM_ID)
    expect(item?.status).toBe('owned')
  })

  it('sets status to owned by default', async () => {
    const supabase = mockSupabase({ data: MOCK_ROW, error: null })
    await saveToInventory(supabase as any, USER_ID, {
      catalogId:       CATALOG_ID,
      analysisId:      null,
      acquisitionCost: 0,
    })
    const insertCall = supabase._chain.insert.mock.calls[0][0]
    expect(insertCall.status).toBe('owned')
  })

  it('returns error when DB insert fails', async () => {
    const supabase = mockSupabase({ data: null, error: { message: 'DB error' } })
    const { item, error } = await saveToInventory(supabase as any, USER_ID, {
      catalogId:       CATALOG_ID,
      analysisId:      null,
      acquisitionCost: 0,
    })
    expect(item).toBeNull()
    expect(error).toBe('DB error')
  })

  it('stores null analysisId when not provided', async () => {
    const supabase = mockSupabase({ data: { ...MOCK_ROW, analysis_id: null }, error: null })
    await saveToInventory(supabase as any, USER_ID, {
      catalogId:       CATALOG_ID,
      analysisId:      null,
      acquisitionCost: 0,
    })
    const insertCall = supabase._chain.insert.mock.calls[0][0]
    expect(insertCall.analysis_id).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// listInventory
// ---------------------------------------------------------------------------

describe('listInventory', () => {
  const LIST_ROW = {
    item_id:          ITEM_ID,
    catalog_id:       CATALOG_ID,
    analysis_id:      ANALYSIS_ID,
    status:           'owned',
    acquisition_cost: 25,
    notes:            null,
    created_at:       '2026-03-29T00:00:00Z',
    updated_at:       '2026-03-29T00:00:00Z',
    card_catalog_items: {
      card_name: 'Charizard', franchise_or_brand: 'Pokemon',
      set_name: 'Base Set', year: 1999, card_number: '4/102', variant: null, category: 'tcg',
    },
    card_analyses: { recommendation_type: 'SELL_RAW', estimated_market_value: 120 },
  }

  it('returns enriched list items', async () => {
    const supabase = mockSupabaseList({ data: [LIST_ROW], error: null })
    const { items, error } = await listInventory(supabase as any, USER_ID)
    expect(error).toBeNull()
    expect(items).toHaveLength(1)
    expect(items[0].card.card_name).toBe('Charizard')
    expect(items[0].recommendation_type).toBe('SELL_RAW')
    expect(items[0].estimated_market_value).toBe(120)
  })

  it('returns empty array on empty result', async () => {
    const supabase = mockSupabaseList({ data: [], error: null })
    const { items, error } = await listInventory(supabase as any, USER_ID)
    expect(error).toBeNull()
    expect(items).toHaveLength(0)
  })

  it('returns error string on DB failure', async () => {
    const supabase = mockSupabaseList({ data: null, error: { message: 'Connection refused' } })
    const { items, error } = await listInventory(supabase as any, USER_ID)
    expect(items).toHaveLength(0)
    expect(error).toBe('Connection refused')
  })

  it('handles missing card_analyses gracefully (null recommendation)', async () => {
    const supabase = mockSupabaseList({
      data: [{ ...LIST_ROW, analysis_id: null, card_analyses: null }],
      error: null,
    })
    const { items } = await listInventory(supabase as any, USER_ID)
    expect(items[0].recommendation_type).toBeNull()
    expect(items[0].estimated_market_value).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getInventoryItem
// ---------------------------------------------------------------------------

describe('getInventoryItem', () => {
  const DETAIL_ROW = {
    item_id:          ITEM_ID,
    catalog_id:       CATALOG_ID,
    analysis_id:      ANALYSIS_ID,
    status:           'owned',
    acquisition_cost: 25,
    notes:            'Nice card',
    created_at:       '2026-03-29T00:00:00Z',
    updated_at:       '2026-03-29T00:00:00Z',
    card_catalog_items: {
      card_name: 'Charizard', franchise_or_brand: 'Pokemon',
      set_name: 'Base Set', year: 1999, card_number: '4/102', variant: null, category: 'tcg',
    },
    card_analyses: {
      recommendation_type: 'GRADE', estimated_market_value: 120, rationale_text: 'Grade it.',
    },
  }

  it('returns enriched detail item', async () => {
    const supabase = mockSupabase({ data: DETAIL_ROW, error: null })
    const { item, error } = await getInventoryItem(supabase as any, USER_ID, ITEM_ID)
    expect(error).toBeNull()
    expect(item?.item_id).toBe(ITEM_ID)
    expect(item?.card.card_name).toBe('Charizard')
    expect(item?.rationale_text).toBe('Grade it.')
    expect(item?.notes).toBe('Nice card')
  })

  it('returns error when item not found', async () => {
    const supabase = mockSupabase({ data: null, error: { message: 'Item not found' } })
    const { item, error } = await getInventoryItem(supabase as any, USER_ID, ITEM_ID)
    expect(item).toBeNull()
    expect(error).toBe('Item not found')
  })
})

// ---------------------------------------------------------------------------
// updateInventoryItem
// ---------------------------------------------------------------------------

describe('updateInventoryItem', () => {
  it('returns updated item on success', async () => {
    const updated = { ...MOCK_ROW, status: 'listed', notes: 'Listed on eBay' }
    const supabase = mockSupabase({ data: updated, error: null })
    const { item, error } = await updateInventoryItem(supabase as any, USER_ID, ITEM_ID, {
      status: 'listed',
      notes:  'Listed on eBay',
    })
    expect(error).toBeNull()
    expect(item?.status).toBe('listed')
  })

  it('returns error when no fields to update', async () => {
    const supabase = mockSupabase({ data: null, error: null })
    const { item, error } = await updateInventoryItem(supabase as any, USER_ID, ITEM_ID, {})
    expect(item).toBeNull()
    expect(error).toBe('No fields to update.')
  })

  it('maps acquisitionCost to snake_case acquisition_cost', async () => {
    const supabase = mockSupabase({ data: MOCK_ROW, error: null })
    await updateInventoryItem(supabase as any, USER_ID, ITEM_ID, { acquisitionCost: 50 })
    const updateCall = supabase._chain.update.mock.calls[0][0]
    expect(updateCall.acquisition_cost).toBe(50)
    expect(updateCall.acquisitionCost).toBeUndefined()
  })

  it('returns error when DB update fails', async () => {
    const supabase = mockSupabase({ data: null, error: { message: 'RLS violation' } })
    const { item, error } = await updateInventoryItem(supabase as any, USER_ID, ITEM_ID, {
      status: 'sold',
    })
    expect(item).toBeNull()
    expect(error).toBe('RLS violation')
  })
})
