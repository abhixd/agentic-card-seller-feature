import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runTool, TOOL_DEFINITIONS } from '@/lib/chat/tools'

// ---------------------------------------------------------------------------
// Mock Supabase builder
// ---------------------------------------------------------------------------

function makeSupabase(result: { data?: unknown; error?: { message: string } | null }) {
  const chain: any = {
    from:   () => chain,
    select: () => chain,
    eq:     () => chain,
    order:  () => chain,
    single: () => Promise.resolve({ data: result.data ?? null, error: result.error ?? null }),
    // List queries resolve from the chain itself
    then:   undefined,
  }
  // Allow awaiting the chain for list queries (no .single())
  chain[Symbol.toStringTag] = 'Promise'
  Object.defineProperty(chain, 'then', {
    get() {
      return (resolve: (v: unknown) => void) =>
        Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(resolve)
    },
  })
  return chain as any
}

// ---------------------------------------------------------------------------
// TOOL_DEFINITIONS shape
// ---------------------------------------------------------------------------

describe('TOOL_DEFINITIONS', () => {
  it('exports 4 tools', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(4)
  })

  it('all tools have type=function', () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(t.type).toBe('function')
    }
  })

  it('tool names are the expected set', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.function.name)
    expect(names).toContain('get_analysis')
    expect(names).toContain('list_inventory')
    expect(names).toContain('find_sell_now_candidates')
    expect(names).toContain('find_grading_candidates')
  })

  it('get_analysis requires analysisId', () => {
    const def = TOOL_DEFINITIONS.find((t) => t.function.name === 'get_analysis')!
    expect((def.function.parameters as any).required).toContain('analysisId')
  })
})

// ---------------------------------------------------------------------------
// runTool — unknown tool
// ---------------------------------------------------------------------------

describe('runTool — unknown tool', () => {
  it('returns error JSON for unknown tool name', async () => {
    const result = await runTool('nonexistent_tool', '{}', makeSupabase({}), 'user-1')
    const parsed = JSON.parse(result)
    expect(parsed.error).toContain('nonexistent_tool')
  })
})

// ---------------------------------------------------------------------------
// runTool — invalid JSON args
// ---------------------------------------------------------------------------

describe('runTool — invalid args', () => {
  it('returns error when args are invalid JSON', async () => {
    const result = await runTool('get_analysis', 'not-json', makeSupabase({}), 'user-1')
    const parsed = JSON.parse(result)
    expect(parsed.error).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// runTool — get_analysis
// ---------------------------------------------------------------------------

describe('runTool — get_analysis', () => {
  it('returns error when analysisId missing', async () => {
    const result = await runTool('get_analysis', '{}', makeSupabase({}), 'user-1')
    const parsed = JSON.parse(result)
    expect(parsed.error).toContain('analysisId')
  })

  it('returns error when supabase returns null', async () => {
    const supabase = makeSupabase({ data: null, error: null })
    const result = await runTool(
      'get_analysis',
      JSON.stringify({ analysisId: '550e8400-e29b-41d4-a716-446655440001' }),
      supabase,
      'user-1',
    )
    const parsed = JSON.parse(result)
    expect(parsed.error).toContain('not found')
  })

  it('returns analysis data on success', async () => {
    const mockRow = {
      analysis_id:           '550e8400-e29b-41d4-a716-446655440001',
      recommendation_type:   'SELL_RAW',
      estimated_market_value: 120,
      comp_range_low:        100,
      comp_range_high:       140,
      confidence_score:      0.85,
      comp_count:            8,
      days_of_data:          30,
      net_proceeds:          99.80,
      rationale_text:        'Strong comps.',
      assumptions_json:      { platform: 'ebay', shippingCost: 4.5, acquisitionCost: 20, conditionScore: 16 },
      created_at:            '2026-03-29T00:00:00Z',
      card_catalog_items:    { card_name: 'Charizard', franchise_or_brand: 'Pokemon', set_name: 'Base Set', year: 1999 },
    }
    const supabase = makeSupabase({ data: mockRow })
    const result = await runTool(
      'get_analysis',
      JSON.stringify({ analysisId: '550e8400-e29b-41d4-a716-446655440001' }),
      supabase,
      'user-1',
    )
    const parsed = JSON.parse(result)
    expect(parsed.recommendation).toBe('SELL_RAW')
    expect(parsed.estimated_market_value).toBe(120)
    expect(parsed.condition_score).toBe(16)
    expect(parsed.card.card_name).toBe('Charizard')
  })
})

// ---------------------------------------------------------------------------
// runTool — list_inventory
// ---------------------------------------------------------------------------

describe('runTool — list_inventory', () => {
  it('returns count and items array on success', async () => {
    const mockData = [
      {
        item_id:          '550e8400-e29b-41d4-a716-446655440003',
        status:           'owned',
        acquisition_cost: 20,
        created_at:       '2026-03-29T00:00:00Z',
        card_catalog_items: { card_name: 'Charizard', franchise_or_brand: 'Pokemon', set_name: 'Base Set', year: 1999, card_number: null, variant: null, category: 'tcg' },
        card_analyses:    { recommendation_type: 'SELL_RAW', estimated_market_value: 120 },
      },
    ]
    const supabase = makeSupabase({ data: mockData })
    const result = await runTool('list_inventory', '{}', supabase, 'user-1')
    const parsed = JSON.parse(result)
    expect(parsed.count).toBe(1)
    expect(parsed.items[0].card_name).toBe('Charizard')
  })

  it('returns empty list when no items', async () => {
    const supabase = makeSupabase({ data: [] })
    const result = await runTool('list_inventory', '{}', supabase, 'user-1')
    const parsed = JSON.parse(result)
    expect(parsed.count).toBe(0)
    expect(parsed.items).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// runTool — find_sell_now_candidates
// ---------------------------------------------------------------------------

describe('runTool — find_sell_now_candidates', () => {
  it('only returns SELL_RAW items', async () => {
    const mockData = [
      {
        item_id: '550e8400-e29b-41d4-a716-446655440003',
        status: 'owned', acquisition_cost: 20,
        card_catalog_items: { card_name: 'Charizard', franchise_or_brand: 'Pokemon', set_name: 'Base Set', year: 1999 },
        card_analyses: { recommendation_type: 'SELL_RAW', estimated_market_value: 120, net_proceeds: 99 },
      },
      {
        item_id: '550e8400-e29b-41d4-a716-446655440004',
        status: 'owned', acquisition_cost: 50,
        card_catalog_items: { card_name: 'Pikachu', franchise_or_brand: 'Pokemon', set_name: 'Base Set', year: 1999 },
        card_analyses: { recommendation_type: 'GRADE', estimated_market_value: 200, net_proceeds: 170 },
      },
    ]
    const supabase = makeSupabase({ data: mockData })
    const result = await runTool('find_sell_now_candidates', '{}', supabase, 'user-1')
    const parsed = JSON.parse(result)
    expect(parsed.count).toBe(1)
    expect(parsed.candidates[0].card_name).toBe('Charizard')
  })

  it('sorts by estimated_market_value descending', async () => {
    const mockData = [
      {
        item_id: '550e8400-e29b-41d4-a716-446655440003',
        status: 'owned', acquisition_cost: 10,
        card_catalog_items: { card_name: 'Card A', franchise_or_brand: 'X', set_name: 'S1', year: 2000 },
        card_analyses: { recommendation_type: 'SELL_RAW', estimated_market_value: 50, net_proceeds: 40 },
      },
      {
        item_id: '550e8400-e29b-41d4-a716-446655440004',
        status: 'owned', acquisition_cost: 10,
        card_catalog_items: { card_name: 'Card B', franchise_or_brand: 'X', set_name: 'S1', year: 2000 },
        card_analyses: { recommendation_type: 'SELL_RAW', estimated_market_value: 200, net_proceeds: 170 },
      },
    ]
    const supabase = makeSupabase({ data: mockData })
    const result = await runTool('find_sell_now_candidates', '{}', supabase, 'user-1')
    const parsed = JSON.parse(result)
    expect(parsed.candidates[0].card_name).toBe('Card B')
    expect(parsed.candidates[1].card_name).toBe('Card A')
  })
})

// ---------------------------------------------------------------------------
// runTool — find_grading_candidates
// ---------------------------------------------------------------------------

describe('runTool — find_grading_candidates', () => {
  it('only returns GRADE items', async () => {
    const mockData = [
      {
        item_id: '550e8400-e29b-41d4-a716-446655440003',
        status: 'owned', acquisition_cost: 20,
        card_catalog_items: { card_name: 'Charizard', franchise_or_brand: 'Pokemon', set_name: 'Base Set', year: 1999 },
        card_analyses: { recommendation_type: 'SELL_RAW', estimated_market_value: 120, rationale_text: 'Sell raw.' },
      },
      {
        item_id: '550e8400-e29b-41d4-a716-446655440004',
        status: 'owned', acquisition_cost: 50,
        card_catalog_items: { card_name: 'Pikachu', franchise_or_brand: 'Pokemon', set_name: 'Base Set', year: 1999 },
        card_analyses: { recommendation_type: 'GRADE', estimated_market_value: 200, rationale_text: 'PSA 10 upside.' },
      },
    ]
    const supabase = makeSupabase({ data: mockData })
    const result = await runTool('find_grading_candidates', '{}', supabase, 'user-1')
    const parsed = JSON.parse(result)
    expect(parsed.count).toBe(1)
    expect(parsed.candidates[0].card_name).toBe('Pikachu')
    expect(parsed.candidates[0].rationale).toBe('PSA 10 upside.')
  })
})
