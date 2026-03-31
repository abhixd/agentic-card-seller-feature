import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { CardSearchResult } from '@/types/catalog'

// ---------------------------------------------------------------------------
// Mock Supabase server client + search service
// vi.hoisted ensures variables are available when vi.mock factory is hoisted
// ---------------------------------------------------------------------------

const { mockSearchCatalog, mockGetCatalogItem, mockSearchPokemonCards, mockSyncPokemonCards } = vi.hoisted(() => ({
  mockSearchCatalog:       vi.fn(),
  mockGetCatalogItem:      vi.fn(),
  mockSearchPokemonCards:  vi.fn().mockResolvedValue([]),
  mockSyncPokemonCards:    vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/lib/catalog/searchService', () => ({
  searchCatalog: mockSearchCatalog,
  getCatalogItem: mockGetCatalogItem,
}))

vi.mock('@/lib/pokemon/pokemonTcgApi', () => ({
  searchPokemonCards: mockSearchPokemonCards,
}))

vi.mock('@/lib/pokemon/pokemonTcgSync', () => ({
  syncPokemonCards: mockSyncPokemonCards,
}))

import { GET as searchRoute } from '@/app/api/catalog/search/route'
import { GET as detailRoute } from '@/app/api/catalog/[catalogId]/route'

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const MOCK_RESULTS: CardSearchResult[] = [
  {
    catalog_id: 'uuid-1',
    category: 'tcg',
    franchise_or_brand: 'Pokemon',
    set_name: 'Base Set',
    year: 1999,
    card_name: 'Charizard',
    card_number: '4/102',
    variant: null,
    canonical_image_url: null,
  },
]

beforeEach(() => vi.clearAllMocks())

// ---------------------------------------------------------------------------
// GET /api/catalog/search
// ---------------------------------------------------------------------------

describe('GET /api/catalog/search', () => {
  it('returns results and count for a valid query', async () => {
    mockSearchCatalog.mockResolvedValue({ results: MOCK_RESULTS, error: null })

    const req = new NextRequest('http://localhost/api/catalog/search?q=charizard')
    const res = await searchRoute(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.results).toHaveLength(1)
    expect(body.count).toBe(1)
    expect(body.query).toBe('charizard')
  })

  it('returns empty results for a short query (service returns [])', async () => {
    mockSearchCatalog.mockResolvedValue({ results: [], error: null })

    const req = new NextRequest('http://localhost/api/catalog/search?q=a')
    const res = await searchRoute(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.results).toEqual([])
    expect(body.count).toBe(0)
  })

  it('returns 500 when the service returns an error', async () => {
    mockSearchCatalog.mockResolvedValue({ results: [], error: 'DB error' })

    const req = new NextRequest('http://localhost/api/catalog/search?q=charizard')
    const res = await searchRoute(req)

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('DB error')
  })

  it('passes limit param through to the service', async () => {
    mockSearchCatalog.mockResolvedValue({ results: [], error: null })

    const req = new NextRequest('http://localhost/api/catalog/search?q=pokemon&limit=5')
    await searchRoute(req)

    expect(mockSearchCatalog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ q: 'pokemon', limit: 5 })
    )
  })
})

// ---------------------------------------------------------------------------
// GET /api/catalog/[catalogId]
// ---------------------------------------------------------------------------

describe('GET /api/catalog/[catalogId]', () => {
  it('returns the card for a valid catalog ID', async () => {
    const card = { ...MOCK_RESULTS[0], metadata_json: {}, created_at: '2024-01-01' }
    mockGetCatalogItem.mockResolvedValue({ card, error: null })

    const req = new NextRequest('http://localhost/api/catalog/uuid-1')
    const res = await detailRoute(req, { params: Promise.resolve({ catalogId: 'uuid-1' }) })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.card.catalog_id).toBe('uuid-1')
    expect(body.card.card_name).toBe('Charizard')
  })

  it('returns 404 when the card is not found', async () => {
    mockGetCatalogItem.mockResolvedValue({ card: null, error: 'row not found' })

    const req = new NextRequest('http://localhost/api/catalog/bad-id')
    const res = await detailRoute(req, { params: Promise.resolve({ catalogId: 'bad-id' }) })

    expect(res.status).toBe(404)
  })
})
