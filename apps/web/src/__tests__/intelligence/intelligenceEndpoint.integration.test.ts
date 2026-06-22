import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockGetUser, mockGetCatalogItem, mockFetchEbayComps } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockGetCatalogItem: vi.fn(),
  mockFetchEbayComps: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({ auth: { getUser: mockGetUser } }),
}))
vi.mock('@/lib/catalog/searchService', () => ({ getCatalogItem: mockGetCatalogItem }))
vi.mock('@/lib/ebay/findingApi', () => ({
  buildKeyword: () => 'Charizard ex Obsidian Flames',
  fetchEbayComps: mockFetchEbayComps,
}))

import { GET } from '@/app/api/cards/[catalogId]/intelligence/route'

function makeReq() {
  return new Request('http://localhost/api/cards/abc/intelligence')
}
function ctx(catalogId = 'abc') {
  return { params: Promise.resolve({ catalogId }) }
}

const CARD_WITH_PRICES = {
  catalog_id: 'abc',
  card_name: 'Charizard ex',
  set_name: 'Obsidian Flames',
  year: 2023,
  card_number: '125/197',
  variant: null,
  category: 'tcg' as const,
  franchise_or_brand: 'Pokemon',
  canonical_image_url: null,
  created_at: '2026-01-01T00:00:00Z',
  metadata_json: {
    tcgplayer: { prices: { holofoil: { low: 90, mid: 110, high: 160, market: 118 } } },
    cardmarket: { prices: { averageSellPrice: 116, trendPrice: 120, avg1: 119, avg7: 112, avg30: 104 } },
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  mockGetCatalogItem.mockResolvedValue({ card: CARD_WITH_PRICES, error: null })
  mockFetchEbayComps.mockResolvedValue({ comps: [] }) // eBay not wired in this test
})

describe('GET /api/cards/[catalogId]/intelligence', () => {
  it('401s when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await GET(makeReq(), ctx())
    expect(res.status).toBe(401)
  })

  it('404s when the card is not found', async () => {
    mockGetCatalogItem.mockResolvedValue({ card: null, error: 'Card not found.' })
    const res = await GET(makeReq(), ctx())
    expect(res.status).toBe(404)
  })

  it('fuses TCGplayer + CardMarket into a consensus and scores the card', async () => {
    const res = await GET(makeReq(), ctx())
    expect(res.status).toBe(200)
    const body = await res.json()

    // consensus formed from guide sources
    expect(body.consensus.raw.price).toBeGreaterThan(90)
    expect(body.consensus.raw.price).toBeLessThan(160)
    expect(body.dataSources).toEqual(expect.arrayContaining(['tcgplayer', 'cardmarket']))
    expect(body.consensus.raw.sources.length).toBeGreaterThanOrEqual(2)

    // scores present & in range with reasoning
    expect(body.scores.opportunity.score).toBeGreaterThanOrEqual(0)
    expect(body.scores.opportunity.score).toBeLessThanOrEqual(100)
    expect(body.scores.risk.score).toBeGreaterThanOrEqual(0)
    expect(['Undervalued', 'Fairly Valued', 'Overheated']).toContain(body.scores.valuation)
    expect(body.scores.opportunity.factors.length).toBeGreaterThan(0)
  })

  it('incorporates eBay sold comps when available (adds the ebay source)', async () => {
    mockFetchEbayComps.mockResolvedValue({
      comps: [
        { title: 'Charizard ex', soldPrice: 122, soldAt: new Date('2026-06-18'), sourceUrl: 'x' },
        { title: 'Charizard ex', soldPrice: 119, soldAt: new Date('2026-06-15'), sourceUrl: 'x' },
        { title: 'Charizard ex', soldPrice: 124, soldAt: new Date('2026-06-12'), sourceUrl: 'x' },
        { title: 'Charizard ex', soldPrice: 121, soldAt: new Date('2026-06-10'), sourceUrl: 'x' },
      ],
    })
    const res = await GET(makeReq(), ctx())
    const body = await res.json()
    expect(body.dataSources).toContain('ebay')
    expect(body.consensus.raw.sources.map((s: { source: string }) => s.source)).toContain('ebay')
  })

  it('degrades gracefully when the card has no price metadata', async () => {
    mockGetCatalogItem.mockResolvedValue({
      card: { ...CARD_WITH_PRICES, metadata_json: {} }, error: null,
    })
    const res = await GET(makeReq(), ctx())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.consensus.raw.price).toBe(0)
    expect(body.dataSources).toEqual([])
  })
})
