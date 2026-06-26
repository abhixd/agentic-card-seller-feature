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
    // CardMarket (EUR) is intentionally ignored — currency mismatch with USD.
    cardmarket: { prices: { averageSellPrice: 116, trendPrice: 120, avg1: 119, avg7: 112, avg30: 104 } },
    tcg_history: { points: [
      { date: '2026-04-23', price: 110 },
      { date: '2026-05-23', price: 115 },
      { date: '2026-06-22', price: 118 },
    ] },
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

  it('builds a USD consensus from TCGplayer only (CardMarket EUR ignored) and scores the card', async () => {
    const res = await GET(makeReq(), ctx())
    expect(res.status).toBe(200)
    const body = await res.json()

    // consensus formed from the USD TCGplayer band — CardMarket (EUR) excluded
    expect(body.consensus.raw.price).toBeGreaterThan(90)
    expect(body.consensus.raw.price).toBeLessThan(160)
    expect(body.dataSources).toContain('tcgplayer')
    expect(body.dataSources).not.toContain('cardmarket')

    // scores present & in range; valuation is Unknown without an independent
    // (eBay-sold) signal to compare TCGplayer's market price against
    expect(body.scores.opportunity.score).toBeGreaterThanOrEqual(0)
    expect(body.scores.opportunity.score).toBeLessThanOrEqual(100)
    expect(['Undervalued', 'Fairly Valued', 'Overheated', 'Unknown']).toContain(body.scores.valuation)
    expect(body.scores.valuation).toBe('Unknown')
  })

  it('incorporates eBay sold comps when available (adds ebay + enables fair-value)', async () => {
    mockFetchEbayComps.mockResolvedValue({
      comps: [
        { title: 'Charizard ex', soldPrice: 102, soldAt: new Date('2026-06-18'), sourceUrl: 'x' },
        { title: 'Charizard ex', soldPrice: 99, soldAt: new Date('2026-06-15'), sourceUrl: 'x' },
        { title: 'Charizard ex', soldPrice: 104, soldAt: new Date('2026-06-12'), sourceUrl: 'x' },
        { title: 'Charizard ex', soldPrice: 101, soldAt: new Date('2026-06-10'), sourceUrl: 'x' },
      ],
    })
    const res = await GET(makeReq(), ctx())
    const body = await res.json()
    expect(body.dataSources).toContain('ebay')
    expect(body.consensus.raw.sources.map((s: { source: string }) => s.source)).toContain('ebay')
    // now that an independent sold signal exists, valuation is claimable
    expect(body.scores.valuation).not.toBe('Unknown')
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
