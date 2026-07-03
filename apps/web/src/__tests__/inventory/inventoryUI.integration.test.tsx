import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { InventoryListItem, InventoryDetail } from '@/types/inventory'

// ---------------------------------------------------------------------------
// Mock next/navigation
// ---------------------------------------------------------------------------

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }))

vi.mock('next/navigation', () => ({
  useParams:  vi.fn().mockReturnValue({ itemId: '550e8400-e29b-41d4-a716-446655440003' }),
  useRouter:  vi.fn().mockReturnValue({ push: mockPush }),
  notFound:   vi.fn(),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ITEM_ID    = '550e8400-e29b-41d4-a716-446655440003'
const CATALOG_ID = '550e8400-e29b-41d4-a716-446655440001'
const ANALYSIS_ID = '550e8400-e29b-41d4-a716-446655440002'

const MOCK_LIST_ITEM: InventoryListItem = {
  item_id:               ITEM_ID,
  catalog_id:            CATALOG_ID,
  analysis_id:           ANALYSIS_ID,
  status:                'owned',
  acquisition_cost:      25,
  notes:                 null,
  created_at:            '2026-03-29T00:00:00Z',
  updated_at:            '2026-03-29T00:00:00Z',
  card: {
    card_name:          'Charizard',
    franchise_or_brand: 'Pokemon',
    set_name:           'Base Set',
    year:               1999,
    card_number:        '4/102',
    variant:            null,
    category:           'tcg',
  },
  recommendation_type:    'SELL_RAW',
  estimated_market_value: 120,
}

const MOCK_DETAIL: InventoryDetail = {
  item_id:               ITEM_ID,
  catalog_id:            CATALOG_ID,
  analysis_id:           ANALYSIS_ID,
  status:                'owned',
  acquisition_cost:      25,
  notes:                 'Nice card',
  created_at:            '2026-03-29T00:00:00Z',
  updated_at:            '2026-03-29T00:00:00Z',
  card: {
    card_name:          'Charizard',
    franchise_or_brand: 'Pokemon',
    set_name:           'Base Set',
    year:               1999,
    card_number:        '4/102',
    variant:            null,
    category:           'tcg',
  },
  recommendation_type:    'SELL_RAW',
  estimated_market_value: 120,
  rationale_text:         'Sell raw is the best action.',
}

afterEach(() => vi.unstubAllGlobals())
beforeEach(() => { vi.clearAllMocks(); mockPush.mockReset() })

// ---------------------------------------------------------------------------
// Inventory List Page
// ---------------------------------------------------------------------------

import InventoryPage from '@/app/(app)/inventory/page'

describe('InventoryPage — list', () => {
  it('shows loading skeleton initially', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(<InventoryPage />)
    expect(screen.getByTestId('inventory-loading')).toBeInTheDocument()
  })

  it('shows empty state when no items', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ items: [], count: 0 }),
    })))
    render(<InventoryPage />)
    await waitFor(() => screen.getByTestId('inventory-empty'))
    expect(screen.getByTestId('inventory-empty')).toBeInTheDocument()
    expect(screen.getByText(/your collection starts here/i)).toBeInTheDocument()
  })

  it('renders inventory items after load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ items: [MOCK_LIST_ITEM], count: 1 }),
    })))
    render(<InventoryPage />)
    await waitFor(() => screen.getByTestId('inventory-list'))
    const items = screen.getAllByTestId('inventory-item')
    expect(items).toHaveLength(1)
    // scope to the list — the hero stats banner also mentions the top card
    expect(within(screen.getByTestId('inventory-list')).getByText('Charizard')).toBeInTheDocument()
  })

  it('shows estimated market value in list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ items: [MOCK_LIST_ITEM], count: 1 }),
    })))
    render(<InventoryPage />)
    await waitFor(() => screen.getByTestId('inventory-list'))
    expect(within(screen.getByTestId('inventory-list')).getByText('$120.00')).toBeInTheDocument()
  })

  it('shows error state when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    render(<InventoryPage />)
    await waitFor(() => screen.getByTestId('inventory-error'))
    expect(screen.getByTestId('inventory-error')).toBeInTheDocument()
  })

  it('renders Owned status badge', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ items: [MOCK_LIST_ITEM], count: 1 }),
    })))
    render(<InventoryPage />)
    await waitFor(() => screen.getByTestId('inventory-list'))
    expect(within(screen.getByTestId('inventory-list')).getByText('Owned')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Inventory Detail Page
// ---------------------------------------------------------------------------

import InventoryDetailPage from '@/app/(app)/inventory/[itemId]/page'

describe('InventoryDetailPage — detail', () => {
  function makeFetch(detailRes: InventoryDetail | null, patchRes?: unknown, patchFails = false) {
    return vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'PATCH') {
        if (patchFails) return { ok: false, json: async () => ({ error: 'Update failed' }) }
        return { ok: true, json: async () => patchRes ?? detailRes }
      }
      if (!detailRes) return { ok: false, json: async () => ({ error: 'Not found' }) }
      return { ok: true, json: async () => detailRes }
    })
  }

  it('shows loading skeleton initially', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(<InventoryDetailPage />)
    expect(screen.getByTestId('detail-loading')).toBeInTheDocument()
  })

  it('shows error state when item not found', async () => {
    vi.stubGlobal('fetch', makeFetch(null))
    render(<InventoryDetailPage />)
    await waitFor(() => screen.getByTestId('detail-error'))
    expect(screen.getByTestId('detail-error')).toBeInTheDocument()
  })

  it('renders card name and analysis summary after load', async () => {
    vi.stubGlobal('fetch', makeFetch(MOCK_DETAIL))
    render(<InventoryDetailPage />)
    await waitFor(() => screen.getByTestId('inventory-detail'))
    expect(screen.getByRole('heading', { name: 'Charizard' })).toBeInTheDocument()
    expect(screen.getByText('Sell Raw')).toBeInTheDocument()
    expect(screen.getByText(/120\.00/)).toBeInTheDocument()
  })

  it('renders rationale text', async () => {
    vi.stubGlobal('fetch', makeFetch(MOCK_DETAIL))
    render(<InventoryDetailPage />)
    await waitFor(() => screen.getByTestId('inventory-detail'))
    expect(screen.getByText(MOCK_DETAIL.rationale_text!)).toBeInTheDocument()
  })

  it('pre-fills notes and acquisition cost', async () => {
    vi.stubGlobal('fetch', makeFetch(MOCK_DETAIL))
    render(<InventoryDetailPage />)
    await waitFor(() => screen.getByTestId('notes-input'))
    expect(screen.getByTestId('notes-input')).toHaveValue('Nice card')
    expect(screen.getByTestId('acquisition-cost-input')).toHaveValue(25)
  })

  it('status selector shows current status as active', async () => {
    vi.stubGlobal('fetch', makeFetch(MOCK_DETAIL))
    render(<InventoryDetailPage />)
    await waitFor(() => screen.getByTestId('status-owned'))
    expect(screen.getByTestId('status-owned').className).toContain('bg-primary')
  })

  it('switches status when a different button is clicked', async () => {
    vi.stubGlobal('fetch', makeFetch(MOCK_DETAIL))
    render(<InventoryDetailPage />)
    await waitFor(() => screen.getByTestId('status-sold'))
    fireEvent.click(screen.getByTestId('status-sold'))
    expect(screen.getByTestId('status-sold').className).toContain('bg-primary')
    expect(screen.getByTestId('status-owned').className).not.toContain('bg-primary')
  })

  it('calls PATCH on save changes', async () => {
    const mockFetchFn = makeFetch(MOCK_DETAIL, { ...MOCK_DETAIL, status: 'listed' })
    vi.stubGlobal('fetch', mockFetchFn)
    render(<InventoryDetailPage />)
    await waitFor(() => screen.getByTestId('save-changes-button'))
    fireEvent.click(screen.getByTestId('status-listed'))
    fireEvent.click(screen.getByTestId('save-changes-button'))
    await waitFor(() => {
      const patchCall = mockFetchFn.mock.calls.find(([, opts]) => (opts as RequestInit)?.method === 'PATCH')
      expect(patchCall).toBeDefined()
      const body = JSON.parse((patchCall![1] as RequestInit).body as string)
      expect(body.status).toBe('listed')
    })
  })

  it('shows save error when PATCH fails', async () => {
    vi.stubGlobal('fetch', makeFetch(MOCK_DETAIL, null, true))
    render(<InventoryDetailPage />)
    await waitFor(() => screen.getByTestId('save-changes-button'))
    fireEvent.click(screen.getByTestId('save-changes-button'))
    await waitFor(() => screen.getByTestId('save-error'))
    expect(screen.getByTestId('save-error')).toHaveTextContent('Update failed')
  })

  it('shows link to view full analysis', async () => {
    vi.stubGlobal('fetch', makeFetch(MOCK_DETAIL))
    render(<InventoryDetailPage />)
    await waitFor(() => screen.getByTestId('view-analysis-link'))
    expect(screen.getByTestId('view-analysis-link')).toHaveAttribute(
      'href', `/analyze/result/${ANALYSIS_ID}`
    )
  })
})

// ---------------------------------------------------------------------------
// Save-to-inventory on result page
// ---------------------------------------------------------------------------

import AnalysisResultPage from '@/app/(app)/analyze/result/[analysisId]/page'

// Need useParams to return analysisId for result page
vi.mock('next/navigation', () => ({
  useParams:  vi.fn((key?: string) => {
    // For the result page we want analysisId, for detail page we want itemId
    return { analysisId: ANALYSIS_ID, itemId: ITEM_ID }
  }),
  useRouter:  vi.fn().mockReturnValue({ push: mockPush }),
  notFound:   vi.fn(),
}))

const MOCK_ANALYSIS = {
  analysis_id: ANALYSIS_ID,
  catalog_id:  CATALOG_ID,
  card: { card_name: 'Charizard', franchise_or_brand: 'Pokemon', set_name: 'Base Set',
    year: 1999, card_number: '4/102', variant: null, category: 'tcg' },
  comps: { rawEstimate: 120, compRangeLow: 100, compRangeHigh: 140, confidenceScore: 0.7,
    compCount: 8, daysOfData: 45, comps: [] },
  fees: { grossRevenue: 120, platformFee: 16.2, shippingCost: 4, acquisitionCost: 0,
    netProceeds: 99.8, roi: null, platform: 'eBay', breakdown: [] },
  grading_scenarios: [],
  recommendation: { type: 'SELL_RAW', rationale: 'Sell raw.' },
  condition_score: null,
  condition_ratings: null,
  assumptions: { platform: 'ebay', shippingCost: 4, acquisitionCost: 0, ebayKeyword: 'test',
    compCount: 8, daysOfData: 45, conditionScore: null, feeResult: {} },
  created_at: '2026-03-29T00:00:00Z',
}

describe('AnalysisResultPage — save to inventory', () => {
  it('renders save-to-inventory button', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => MOCK_ANALYSIS })))
    render(<AnalysisResultPage />)
    await waitFor(() => screen.getByTestId('save-to-inventory-button'))
    expect(screen.getByTestId('save-to-inventory-button')).toBeInTheDocument()
  })

  it('calls POST /api/inventory and navigates to item detail', async () => {
    const mockFetchFn = vi.fn(async (url: string, options?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/analysis/')) {
        return { ok: true, json: async () => MOCK_ANALYSIS }
      }
      if (options?.method === 'POST' && typeof url === 'string' && url.includes('/api/inventory')) {
        return { ok: true, json: async () => ({ item_id: ITEM_ID }) }
      }
      return { ok: false, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', mockFetchFn)
    render(<AnalysisResultPage />)
    await waitFor(() => screen.getByTestId('save-to-inventory-button'))
    fireEvent.click(screen.getByTestId('save-to-inventory-button'))
    await waitFor(() => {
      const postCall = mockFetchFn.mock.calls.find(
        ([url, opts]) => typeof url === 'string' && url.includes('/api/inventory') && (opts as RequestInit)?.method === 'POST'
      )
      expect(postCall).toBeDefined()
    })
  })

  it('shows save error when POST fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/analysis/')) {
        return { ok: true, json: async () => MOCK_ANALYSIS }
      }
      return { ok: false, json: async () => ({ error: 'Already in inventory' }) }
    }))
    render(<AnalysisResultPage />)
    await waitFor(() => screen.getByTestId('save-to-inventory-button'))
    fireEvent.click(screen.getByTestId('save-to-inventory-button'))
    await waitFor(() => screen.getByTestId('save-error'))
    expect(screen.getByTestId('save-error')).toHaveTextContent('Already in inventory')
  })
})
