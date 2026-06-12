import { describe, it, expect, vi, beforeEach } from 'vitest'
import { searchCatalog, getCatalogItem } from '@/lib/catalog/searchService'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CardCatalogItem, CardSearchResult } from '@/types/catalog'

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const CHARIZARD: CardSearchResult = {
  catalog_id: 'uuid-charizard',
  category: 'tcg',
  franchise_or_brand: 'Pokemon',
  set_name: 'Base Set',
  year: 1999,
  card_name: 'Charizard',
  card_number: '4/102',
  variant: null,
  canonical_image_url: null,
}

const JORDAN: CardSearchResult = {
  catalog_id: 'uuid-jordan',
  category: 'sports',
  franchise_or_brand: 'NBA',
  set_name: 'Fleer',
  year: 1986,
  card_name: 'Michael Jordan',
  card_number: '57',
  variant: 'Rookie',
  canonical_image_url: null,
}

const CHARIZARD_FULL: CardCatalogItem = {
  ...CHARIZARD,
  metadata_json: { seed: 'true', rarity: 'Holo Rare' },
  created_at: '2024-01-01T00:00:00Z',
}

// ---------------------------------------------------------------------------
// Supabase mock builder
// ---------------------------------------------------------------------------

function makeQueryChain(returnData: unknown[], returnError: unknown = null) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: returnData, error: returnError }),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: returnData[0] ?? null, error: returnError }),
  }
  return chain
}

function makeSupabase(chain: ReturnType<typeof makeQueryChain>): SupabaseClient {
  return {
    from: vi.fn().mockReturnValue(chain),
  } as unknown as SupabaseClient
}

// ---------------------------------------------------------------------------
// searchCatalog — unit tests
// ---------------------------------------------------------------------------

describe('searchCatalog', () => {
  it('returns empty array without calling Supabase when query is too short (< 2 chars)', async () => {
    const chain = makeQueryChain([])
    const supabase = makeSupabase(chain)

    const result = await searchCatalog(supabase, { q: 'a' })

    expect(result.results).toEqual([])
    expect(result.error).toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns empty array without error for empty query', async () => {
    const chain = makeQueryChain([])
    const supabase = makeSupabase(chain)

    const result = await searchCatalog(supabase, { q: '' })

    expect(result.results).toEqual([])
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns matching results for a valid query (happy path)', async () => {
    const chain = makeQueryChain([CHARIZARD, JORDAN])
    const supabase = makeSupabase(chain)

    const result = await searchCatalog(supabase, { q: 'charizard' })

    expect(result.error).toBeNull()
    expect(result.results).toHaveLength(2)
    expect(result.results[0].card_name).toBe('Charizard')
  })

  it('passes the correct ILIKE pattern to the or() filter', async () => {
    const chain = makeQueryChain([CHARIZARD])
    const supabase = makeSupabase(chain)

    await searchCatalog(supabase, { q: 'charizard' })

    expect(chain.or).toHaveBeenCalledWith(
      expect.stringContaining('%charizard%')
    )
  })

  it('caps results at MAX_LIMIT (50) even if caller requests more', async () => {
    const chain = makeQueryChain([])
    const supabase = makeSupabase(chain)

    await searchCatalog(supabase, { q: 'pokemon', limit: 999 })

    expect(chain.limit).toHaveBeenCalledWith(50)
  })

  it('returns empty results and surfaces error when Supabase fails', async () => {
    const chain = makeQueryChain([], { message: 'connection timeout' })
    const supabase = makeSupabase(chain)

    const result = await searchCatalog(supabase, { q: 'charizard' })

    expect(result.results).toEqual([])
    expect(result.error).toBe('connection timeout')
  })
})

// ---------------------------------------------------------------------------
// getCatalogItem — unit tests
// ---------------------------------------------------------------------------

describe('getCatalogItem', () => {
  it('returns the card for a valid catalog ID (happy path)', async () => {
    const chain = makeQueryChain([CHARIZARD_FULL])
    const supabase = makeSupabase(chain)

    const result = await getCatalogItem(supabase, 'uuid-charizard')

    expect(result.error).toBeNull()
    expect(result.card?.card_name).toBe('Charizard')
    expect(result.card?.catalog_id).toBe('uuid-charizard')
  })

  it('returns error for an empty catalog ID without calling Supabase', async () => {
    const chain = makeQueryChain([])
    const supabase = makeSupabase(chain)

    const result = await getCatalogItem(supabase, '')

    expect(result.card).toBeNull()
    expect(result.error).toBe('Missing catalog ID.')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns null card and surfaces error when Supabase fails', async () => {
    const chain = makeQueryChain([], { message: 'row not found' })
    const supabase = makeSupabase(chain)

    const result = await getCatalogItem(supabase, 'nonexistent-id')

    expect(result.card).toBeNull()
    expect(result.error).toBe('row not found')
  })
})
