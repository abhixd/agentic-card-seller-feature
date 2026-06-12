import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------

const { mockSaveToInventory, mockListInventory, mockGetInventoryItem, mockUpdateInventoryItem, mockGetUser } =
  vi.hoisted(() => ({
    mockSaveToInventory:      vi.fn(),
    mockListInventory:        vi.fn(),
    mockGetInventoryItem:     vi.fn(),
    mockUpdateInventoryItem:  vi.fn(),
    mockGetUser:              vi.fn(),
  }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({ auth: { getUser: mockGetUser } }),
}))

vi.mock('@/lib/inventory/inventoryService', () => ({
  saveToInventory:     mockSaveToInventory,
  listInventory:       mockListInventory,
  getInventoryItem:    mockGetInventoryItem,
  updateInventoryItem: mockUpdateInventoryItem,
}))

import { POST, GET } from '@/app/api/inventory/route'
import { GET as GET_ITEM, PATCH } from '@/app/api/inventory/[itemId]/route'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATALOG_ID = '550e8400-e29b-41d4-a716-446655440001'
const ANALYSIS_ID = '550e8400-e29b-41d4-a716-446655440002'
const ITEM_ID    = '550e8400-e29b-41d4-a716-446655440003'

const MOCK_ITEM = {
  item_id:          ITEM_ID,
  user_id:          'user-123',
  catalog_id:       CATALOG_ID,
  analysis_id:      ANALYSIS_ID,
  status:           'owned',
  acquisition_cost: 25,
  notes:            null,
  created_at:       '2026-03-29T00:00:00Z',
  updated_at:       '2026-03-29T00:00:00Z',
}

const MOCK_DETAIL = {
  ...MOCK_ITEM,
  card: { card_name: 'Charizard', franchise_or_brand: 'Pokemon', set_name: 'Base Set',
    year: 1999, card_number: '4/102', variant: null, category: 'tcg' },
  recommendation_type:    'SELL_RAW',
  estimated_market_value: 120,
  rationale_text:         'Sell raw.',
}

function makeRequest(body: unknown, method = 'POST') {
  return new NextRequest('http://localhost/api/inventory', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } } })
})

// ---------------------------------------------------------------------------
// POST /api/inventory
// ---------------------------------------------------------------------------

describe('POST /api/inventory', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makeRequest({ catalogId: CATALOG_ID, acquisitionCost: 0 }))
    expect(res.status).toBe(401)
  })

  it('returns 400 for missing catalogId', async () => {
    const res = await POST(makeRequest({ acquisitionCost: 0 }))
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid catalogId (not UUID)', async () => {
    const res = await POST(makeRequest({ catalogId: 'bad', acquisitionCost: 0 }))
    expect(res.status).toBe(400)
  })

  it('returns 201 with saved item on success', async () => {
    mockSaveToInventory.mockResolvedValue({ item: MOCK_ITEM, error: null })
    const res = await POST(makeRequest({ catalogId: CATALOG_ID, analysisId: ANALYSIS_ID, acquisitionCost: 25 }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.item_id).toBe(ITEM_ID)
    expect(body.status).toBe('owned')
  })

  it('passes catalogId and analysisId to service', async () => {
    mockSaveToInventory.mockResolvedValue({ item: MOCK_ITEM, error: null })
    await POST(makeRequest({ catalogId: CATALOG_ID, analysisId: ANALYSIS_ID, acquisitionCost: 25 }))
    expect(mockSaveToInventory).toHaveBeenCalledWith(
      expect.anything(), 'user-123',
      expect.objectContaining({ catalogId: CATALOG_ID, analysisId: ANALYSIS_ID, acquisitionCost: 25 })
    )
  })

  it('returns 500 when service fails', async () => {
    mockSaveToInventory.mockResolvedValue({ item: null, error: 'DB constraint violation' })
    const res = await POST(makeRequest({ catalogId: CATALOG_ID, acquisitionCost: 0 }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('DB constraint violation')
  })
})

// ---------------------------------------------------------------------------
// GET /api/inventory
// ---------------------------------------------------------------------------

describe('GET /api/inventory', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns list of items', async () => {
    mockListInventory.mockResolvedValue({ items: [MOCK_DETAIL], error: null })
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(1)
    expect(body.count).toBe(1)
  })

  it('returns empty list when no items', async () => {
    mockListInventory.mockResolvedValue({ items: [], error: null })
    const res = await GET()
    const body = await res.json()
    expect(body.items).toHaveLength(0)
    expect(body.count).toBe(0)
  })

  it('returns 500 on service error', async () => {
    mockListInventory.mockResolvedValue({ items: [], error: 'DB error' })
    const res = await GET()
    expect(res.status).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// GET /api/inventory/[itemId]
// ---------------------------------------------------------------------------

describe('GET /api/inventory/[itemId]', () => {
  const params = Promise.resolve({ itemId: ITEM_ID })

  it('returns 401 when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await GET_ITEM(new NextRequest('http://localhost'), { params })
    expect(res.status).toBe(401)
  })

  it('returns item detail on success', async () => {
    mockGetInventoryItem.mockResolvedValue({ item: MOCK_DETAIL, error: null })
    const res = await GET_ITEM(new NextRequest('http://localhost'), { params })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.item_id).toBe(ITEM_ID)
    expect(body.card.card_name).toBe('Charizard')
  })

  it('returns 404 when item not found', async () => {
    mockGetInventoryItem.mockResolvedValue({ item: null, error: 'Not found' })
    const res = await GET_ITEM(new NextRequest('http://localhost'), { params })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/inventory/[itemId]
// ---------------------------------------------------------------------------

describe('PATCH /api/inventory/[itemId]', () => {
  const params = Promise.resolve({ itemId: ITEM_ID })

  function makePatch(body: unknown) {
    return new NextRequest('http://localhost', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:   JSON.stringify(body),
    })
  }

  it('returns 401 when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await PATCH(makePatch({ status: 'sold' }), { params })
    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid status value', async () => {
    const res = await PATCH(makePatch({ status: 'invalid_status' }), { params })
    expect(res.status).toBe(400)
  })

  it('returns updated item on success', async () => {
    const updated = { ...MOCK_ITEM, status: 'sold' }
    mockUpdateInventoryItem.mockResolvedValue({ item: updated, error: null })
    const res = await PATCH(makePatch({ status: 'sold' }), { params })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('sold')
  })

  it('passes all update fields to service', async () => {
    mockUpdateInventoryItem.mockResolvedValue({ item: MOCK_ITEM, error: null })
    await PATCH(makePatch({ status: 'listed', notes: 'On eBay', acquisitionCost: 30 }), { params })
    expect(mockUpdateInventoryItem).toHaveBeenCalledWith(
      expect.anything(), 'user-123', ITEM_ID,
      expect.objectContaining({ status: 'listed', notes: 'On eBay', acquisitionCost: 30 })
    )
  })

  it('returns 500 when update fails', async () => {
    mockUpdateInventoryItem.mockResolvedValue({ item: null, error: 'Update failed' })
    const res = await PATCH(makePatch({ status: 'sold' }), { params })
    expect(res.status).toBe(500)
  })
})
