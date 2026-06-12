import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------

const { mockGenerateDraftForItem, mockGetUser } = vi.hoisted(() => ({
  mockGenerateDraftForItem: vi.fn(),
  mockGetUser:              vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({ auth: { getUser: mockGetUser } }),
}))

vi.mock('@/lib/listing/listingDraftService', () => ({
  generateDraftForItem: mockGenerateDraftForItem,
  // re-export the pure functions as-is so unit tests aren't affected
  generateTitle:        vi.fn(),
  generateDescription:  vi.fn(),
  buildListingDraft:    vi.fn(),
  toNinetyNinePrice:    vi.fn(),
}))

import { GET } from '@/app/api/listing-draft/route'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ITEM_ID = '550e8400-e29b-41d4-a716-446655440003'

const MOCK_DRAFT = {
  itemId:         ITEM_ID,
  analysisId:     '550e8400-e29b-41d4-a716-446655440002',
  card:           { card_name: 'Charizard', franchise_or_brand: 'Pokemon', set_name: 'Base Set',
                    year: 1999, card_number: '4/102', variant: null, category: 'tcg' },
  title:          '1999 Pokemon Charizard Base Set #4/102 Raw',
  titleCharCount: 43,
  description:    'CARD DETAILS\n------------\nCard Name: Charizard',
  suggestedPrice: 119.99,
  compRangeLow:   100,
  compRangeHigh:  140,
  netProceeds:    99.80,
  platform:       'ebay',
  generatedAt:    '2026-03-29T00:00:00.000Z',
}

function makeRequest(itemId: string | null) {
  const url = itemId
    ? `http://localhost/api/listing-draft?itemId=${itemId}`
    : 'http://localhost/api/listing-draft'
  return new NextRequest(url)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } } })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/listing-draft', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await GET(makeRequest(ITEM_ID))
    expect(res.status).toBe(401)
  })

  it('returns 400 when itemId query param is missing', async () => {
    const res = await GET(makeRequest(null))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('itemId')
  })

  it('returns 200 with draft on success', async () => {
    mockGenerateDraftForItem.mockResolvedValue({ draft: MOCK_DRAFT, error: null })
    const res = await GET(makeRequest(ITEM_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.title).toBe(MOCK_DRAFT.title)
    expect(body.suggestedPrice).toBe(119.99)
  })

  it('returns 404 when item not found', async () => {
    mockGenerateDraftForItem.mockResolvedValue({ draft: null, error: 'Item not found.' })
    const res = await GET(makeRequest(ITEM_ID))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Item not found.')
  })

  it('passes itemId and userId to the service', async () => {
    mockGenerateDraftForItem.mockResolvedValue({ draft: MOCK_DRAFT, error: null })
    await GET(makeRequest(ITEM_ID))
    expect(mockGenerateDraftForItem).toHaveBeenCalledWith(
      expect.anything(), 'user-123', ITEM_ID
    )
  })
})
