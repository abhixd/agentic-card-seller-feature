import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ListingDraft } from '@/types/listing'

// ---------------------------------------------------------------------------
// Mock next/navigation
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({
  useParams:  vi.fn().mockReturnValue({ itemId: '550e8400-e29b-41d4-a716-446655440003' }),
  useRouter:  vi.fn().mockReturnValue({ push: vi.fn() }),
}))

// ---------------------------------------------------------------------------
// Mock navigator.clipboard
// ---------------------------------------------------------------------------

const mockWriteText = vi.fn().mockResolvedValue(undefined)
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: mockWriteText },
  writable: true,
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ITEM_ID = '550e8400-e29b-41d4-a716-446655440003'

const MOCK_DRAFT: ListingDraft = {
  itemId:         ITEM_ID,
  analysisId:     '550e8400-e29b-41d4-a716-446655440002',
  card: {
    card_name:          'Charizard',
    franchise_or_brand: 'Pokemon',
    set_name:           'Base Set',
    year:               1999,
    card_number:        '4/102',
    variant:            null,
    category:           'tcg',
  },
  title:          '1999 Pokemon Charizard Base Set #4/102 Raw',
  titleCharCount: 43,
  description:    'CARD DETAILS\n------------\nCard Name: Charizard\nCondition: Raw / Ungraded\n\nSHIPPING\n--------\nShips within 1 business day.',
  suggestedPrice: 119.99,
  compRangeLow:   100,
  compRangeHigh:  140,
  netProceeds:    99.80,
  platform:       'ebay',
  generatedAt:    '2026-03-29T00:00:00.000Z',
}

afterEach(() => vi.unstubAllGlobals())
beforeEach(() => vi.clearAllMocks())

import ListingDraftPage from '@/app/(app)/inventory/[itemId]/listing/page'

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

describe('ListingDraftPage — loading', () => {
  it('shows loading skeleton initially', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(<ListingDraftPage />)
    expect(screen.getByTestId('draft-loading')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

describe('ListingDraftPage — error', () => {
  it('shows error when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: 'Item not found.' }),
    })))
    render(<ListingDraftPage />)
    await waitFor(() => screen.getByTestId('draft-error'))
    expect(screen.getByTestId('draft-error')).toHaveTextContent('Item not found.')
  })
})

// ---------------------------------------------------------------------------
// Happy path — full draft rendering
// ---------------------------------------------------------------------------

describe('ListingDraftPage — draft display', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => MOCK_DRAFT,
    })))
  })

  it('renders the listing draft container', async () => {
    render(<ListingDraftPage />)
    await waitFor(() => screen.getByTestId('listing-draft'))
    expect(screen.getByTestId('listing-draft')).toBeInTheDocument()
  })

  it('renders the suggested price', async () => {
    render(<ListingDraftPage />)
    await waitFor(() => screen.getByTestId('suggested-price'))
    expect(screen.getByTestId('suggested-price')).toHaveTextContent('$119.99')
  })

  it('renders the listing title', async () => {
    render(<ListingDraftPage />)
    await waitFor(() => screen.getByTestId('listing-title'))
    expect(screen.getByTestId('listing-title')).toHaveTextContent(
      '1999 Pokemon Charizard Base Set #4/102 Raw'
    )
  })

  it('renders the description content', async () => {
    render(<ListingDraftPage />)
    await waitFor(() => screen.getByTestId('listing-description'))
    expect(screen.getByTestId('listing-description')).toHaveTextContent('CARD DETAILS')
    expect(screen.getByTestId('listing-description')).toHaveTextContent('Charizard')
  })

  it('shows character count badge for title', async () => {
    render(<ListingDraftPage />)
    await waitFor(() => screen.getByTestId('title-char-count'))
    expect(screen.getByTestId('title-char-count')).toHaveTextContent('43 / 80')
  })

  it('shows comp range', async () => {
    render(<ListingDraftPage />)
    await waitFor(() => screen.getByTestId('listing-draft'))
    expect(screen.getByText(/\$100\.00/)).toBeInTheDocument()
    expect(screen.getByText(/\$140\.00/)).toBeInTheDocument()
  })

  it('shows net proceeds', async () => {
    render(<ListingDraftPage />)
    await waitFor(() => screen.getByTestId('listing-draft'))
    expect(screen.getByText(/\$99\.80/)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Copy buttons
// ---------------------------------------------------------------------------

describe('ListingDraftPage — copy buttons', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => MOCK_DRAFT,
    })))
  })

  it('copy title button calls navigator.clipboard.writeText', async () => {
    render(<ListingDraftPage />)
    await waitFor(() => screen.getByTestId('copy-title-button'))
    fireEvent.click(screen.getByTestId('copy-title-button'))
    expect(mockWriteText).toHaveBeenCalledWith(MOCK_DRAFT.title)
  })

  it('copy description button calls navigator.clipboard.writeText', async () => {
    render(<ListingDraftPage />)
    await waitFor(() => screen.getByTestId('copy-description-button'))
    fireEvent.click(screen.getByTestId('copy-description-button'))
    expect(mockWriteText).toHaveBeenCalledWith(MOCK_DRAFT.description)
  })

  it('copy all button calls navigator.clipboard.writeText with full text', async () => {
    render(<ListingDraftPage />)
    await waitFor(() => screen.getByTestId('copy-all-button'))
    fireEvent.click(screen.getByTestId('copy-all-button'))
    expect(mockWriteText).toHaveBeenCalledTimes(1)
    const copiedText = mockWriteText.mock.calls[0][0] as string
    expect(copiedText).toContain(MOCK_DRAFT.title)
    expect(copiedText).toContain(MOCK_DRAFT.description)
    expect(copiedText).toContain('119.99')
  })
})

// ---------------------------------------------------------------------------
// Inventory detail page — listing draft link
// ---------------------------------------------------------------------------

import InventoryDetailPage from '@/app/(app)/inventory/[itemId]/page'

const MOCK_DETAIL = {
  item_id:               ITEM_ID,
  catalog_id:            '550e8400-e29b-41d4-a716-446655440001',
  analysis_id:           '550e8400-e29b-41d4-a716-446655440002',
  status:                'owned',
  acquisition_cost:      25,
  notes:                 null,
  created_at:            '2026-03-29T00:00:00Z',
  updated_at:            '2026-03-29T00:00:00Z',
  card: { card_name: 'Charizard', franchise_or_brand: 'Pokemon', set_name: 'Base Set',
    year: 1999, card_number: '4/102', variant: null, category: 'tcg' },
  recommendation_type:    'SELL_RAW',
  estimated_market_value: 120,
  rationale_text:         'Sell raw.',
}

describe('InventoryDetailPage — listing draft link', () => {
  it('shows create listing draft link after item loads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => MOCK_DETAIL })))
    render(<InventoryDetailPage />)
    await waitFor(() => screen.getByTestId('create-listing-link'))
    expect(screen.getByTestId('create-listing-link')).toHaveAttribute(
      'href', `/inventory/${ITEM_ID}/listing`
    )
  })
})
