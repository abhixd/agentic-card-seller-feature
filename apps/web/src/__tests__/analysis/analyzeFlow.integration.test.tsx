import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mock next/navigation — the card page uses useParams + useSearchParams +
// useRouter; jsdom implements none of them.
// ---------------------------------------------------------------------------
const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }))

vi.mock('next/navigation', () => ({
  useParams:       vi.fn().mockReturnValue({ catalogId: 'test-catalog-id' }),
  useRouter:       vi.fn().mockReturnValue({ push: mockPush, replace: vi.fn() }),
  useSearchParams: vi.fn().mockReturnValue(new URLSearchParams()),
  notFound:        vi.fn(),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_CARD = {
  catalog_id:         'test-catalog-id',
  card_name:          'Charizard',
  franchise_or_brand: 'Pokemon',
  set_name:           'Base Set',
  year:               1999,
  card_number:        '4/102',
  variant:            null,
  category:           'tcg',
  canonical_image_url: null,
  metadata_json:      {},
  created_at:         '2024-01-01',
}

function makeFetch(cardRes: object) {
  return vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/catalog/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ card: cardRes }),
      }
    }
    // All other data fetches (intelligence, price history, grading) 404 —
    // each component handles its own error/empty state.
    return { ok: false, status: 404, json: async () => ({}) }
  })
}

import CardDetailPage from '@/app/(app)/analyze/[catalogId]/page'

beforeEach(() => {
  vi.clearAllMocks()
  mockPush.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Rendering
//
// NOTE (v2 redesign): the card page is now the decision-first hero layout
// (CardDecisionHero + PriceIntelligenceHub + GradingAdvisor). The old
// AnalysisForm UI (fee assumptions, condition form, analyze button) is no
// longer rendered on this page, so the 14 tests that exercised it were
// removed — the sell/grade/hold analysis flow lives in Portfolio → Sell
// Intelligence now.
// ---------------------------------------------------------------------------

describe('CardDetailPage — basic rendering', () => {
  it('shows loading skeleton initially', () => {
    vi.stubGlobal('fetch', makeFetch(MOCK_CARD))
    render(<CardDetailPage />)
    // Before fetch resolves, page shows loading skeleton (animated pulse divs)
    expect(document.querySelector('.animate-pulse')).toBeTruthy()
  })

  it('renders card details after load', async () => {
    vi.stubGlobal('fetch', makeFetch(MOCK_CARD))
    render(<CardDetailPage />)
    await waitFor(() => screen.getByRole('heading', { name: 'Charizard' }))
    expect(screen.getByRole('heading', { name: 'Charizard' })).toBeInTheDocument()
    expect(screen.getAllByText(/Base Set/).length).toBeGreaterThan(0)
  })
})
