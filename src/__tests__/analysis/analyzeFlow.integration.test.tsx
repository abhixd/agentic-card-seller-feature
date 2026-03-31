import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ---------------------------------------------------------------------------
// Mock next/navigation  — vi.hoisted required because mockPush is used in factory
// ---------------------------------------------------------------------------
const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }))

vi.mock('next/navigation', () => ({
  useParams:  vi.fn().mockReturnValue({ catalogId: 'test-catalog-id' }),
  useRouter:  vi.fn().mockReturnValue({ push: mockPush }),
  notFound:   vi.fn(),
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

const MOCK_ANALYSIS = {
  analysis_id: '550e8400-e29b-41d4-a716-446655440010',
  recommendation: { type: 'SELL_RAW', rationale: 'Sell raw.' },
}

function makeFetch(cardRes: object, analysisRes: object | null = null, analysisFails = false) {
  return vi.fn(async (url: string, options?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/api/catalog/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ card: cardRes }),
      }
    }
    if (typeof url === 'string' && url.includes('/api/analysis') && options?.method === 'POST') {
      if (analysisFails) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: 'eBay API unavailable' }),
        }
      }
      return {
        ok: true,
        status: 201,
        json: async () => analysisRes,
      }
    }
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

  it('renders fee assumptions section with defaults', async () => {
    vi.stubGlobal('fetch', makeFetch(MOCK_CARD))
    render(<CardDetailPage />)
    await waitFor(() => screen.getByTestId('fee-assumptions'))

    expect(screen.getByTestId('fee-assumptions')).toBeInTheDocument()
    expect(screen.getByTestId('platform-ebay')).toBeInTheDocument()
    expect(screen.getByTestId('platform-tcgplayer')).toBeInTheDocument()
    expect(screen.getByTestId('shipping-cost-input')).toHaveValue(4)
    expect(screen.getByTestId('acquisition-cost-input')).toHaveValue(0)
  })

  it('renders the analyze button', async () => {
    vi.stubGlobal('fetch', makeFetch(MOCK_CARD))
    render(<CardDetailPage />)
    await waitFor(() => screen.getByTestId('analyze-button'))
    expect(screen.getByTestId('analyze-button')).toBeEnabled()
  })

  it('condition form is hidden by default', async () => {
    vi.stubGlobal('fetch', makeFetch(MOCK_CARD))
    render(<CardDetailPage />)
    await waitFor(() => screen.getByTestId('condition-toggle'))
    expect(screen.queryByTestId('condition-form')).not.toBeInTheDocument()
  })

  it('shows condition form when toggle is clicked', async () => {
    vi.stubGlobal('fetch', makeFetch(MOCK_CARD))
    render(<CardDetailPage />)
    await waitFor(() => screen.getByTestId('condition-toggle'))
    fireEvent.click(screen.getByTestId('condition-toggle'))
    expect(screen.getByTestId('condition-form')).toBeInTheDocument()
  })

  it('hides condition form again when toggle is clicked twice', async () => {
    vi.stubGlobal('fetch', makeFetch(MOCK_CARD))
    render(<CardDetailPage />)
    await waitFor(() => screen.getByTestId('condition-toggle'))
    fireEvent.click(screen.getByTestId('condition-toggle'))
    expect(screen.getByTestId('condition-form')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('condition-toggle'))
    expect(screen.queryByTestId('condition-form')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Fee assumptions interaction
// ---------------------------------------------------------------------------

describe('CardDetailPage — fee assumptions', () => {
  it('platform toggle switches between eBay and TCGplayer', async () => {
    vi.stubGlobal('fetch', makeFetch(MOCK_CARD))
    render(<CardDetailPage />)
    await waitFor(() => screen.getByTestId('platform-tcgplayer'))
    fireEvent.click(screen.getByTestId('platform-tcgplayer'))
    // TCGplayer button should now have the active style (contains bg-primary class)
    expect(screen.getByTestId('platform-tcgplayer').className).toContain('bg-primary')
  })

  it('shipping cost input accepts custom value', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', makeFetch(MOCK_CARD))
    render(<CardDetailPage />)
    await waitFor(() => screen.getByTestId('shipping-cost-input'))
    const input = screen.getByTestId('shipping-cost-input')
    await user.clear(input)
    await user.type(input, '6.50')
    expect(input).toHaveValue(6.5)
  })
})

// ---------------------------------------------------------------------------
// Run analysis happy path
// ---------------------------------------------------------------------------

describe('CardDetailPage — run analysis', () => {
  it('calls POST /api/analysis with catalogId and defaults on click', async () => {
    const mockFetchFn = makeFetch(MOCK_CARD, MOCK_ANALYSIS)
    vi.stubGlobal('fetch', mockFetchFn)
    render(<CardDetailPage />)
    await waitFor(() => screen.getByTestId('analyze-button'))
    fireEvent.click(screen.getByTestId('analyze-button'))
    await waitFor(() => expect(mockPush).toHaveBeenCalled())

    const postCall = mockFetchFn.mock.calls.find(
      ([, opts]) => (opts as RequestInit)?.method === 'POST'
    )
    expect(postCall).toBeDefined()
    const body = JSON.parse((postCall![1] as RequestInit).body as string)
    expect(body.catalogId).toBe('test-catalog-id')
    expect(body.platform).toBe('ebay')
    expect(body.shippingCost).toBe(4)
    expect(body.acquisitionCost).toBe(0)
  })

  it('navigates to result page on success', async () => {
    vi.stubGlobal('fetch', makeFetch(MOCK_CARD, MOCK_ANALYSIS))
    render(<CardDetailPage />)
    await waitFor(() => screen.getByTestId('analyze-button'))
    fireEvent.click(screen.getByTestId('analyze-button'))
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(`/analyze/result/${MOCK_ANALYSIS.analysis_id}`)
    )
  })

  it('includes conditionRatings in POST body when condition form is filled', async () => {
    const mockFetchFn = makeFetch(MOCK_CARD, MOCK_ANALYSIS)
    vi.stubGlobal('fetch', mockFetchFn)
    render(<CardDetailPage />)
    await waitFor(() => screen.getByTestId('condition-toggle'))

    // Open condition form (defaults to all 3s)
    fireEvent.click(screen.getByTestId('condition-toggle'))
    await waitFor(() => screen.getByTestId('condition-form'))

    // Click rating 5 for corners
    fireEvent.click(screen.getByTestId('rating-corners_rating-5'))

    // Analyze
    fireEvent.click(screen.getByTestId('analyze-button'))
    await waitFor(() => expect(mockPush).toHaveBeenCalled())

    const postCall = mockFetchFn.mock.calls.find(
      ([, opts]) => (opts as RequestInit)?.method === 'POST'
    )
    const body = JSON.parse((postCall![1] as RequestInit).body as string)
    expect(body.conditionRatings).toMatchObject({
      corners_rating:   5,
      edges_rating:     3,
      surface_rating:   3,
      centering_rating: 3,
    })
  })

  it('posts null conditionRatings when condition form is not opened', async () => {
    const mockFetchFn = makeFetch(MOCK_CARD, MOCK_ANALYSIS)
    vi.stubGlobal('fetch', mockFetchFn)
    render(<CardDetailPage />)
    await waitFor(() => screen.getByTestId('analyze-button'))
    fireEvent.click(screen.getByTestId('analyze-button'))
    await waitFor(() => expect(mockPush).toHaveBeenCalled())

    const postCall = mockFetchFn.mock.calls.find(
      ([, opts]) => (opts as RequestInit)?.method === 'POST'
    )
    const body = JSON.parse((postCall![1] as RequestInit).body as string)
    expect(body.conditionRatings).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Loading and error states
// ---------------------------------------------------------------------------

describe('CardDetailPage — loading / error states', () => {
  it('disables analyze button and shows spinner while analyzing', async () => {
    // Use a fetch that stalls the POST response
    let resolvePost!: (v: unknown) => void
    const stallingFetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/catalog/')) {
        return { ok: true, status: 200, json: async () => ({ card: MOCK_CARD }) }
      }
      if (options?.method === 'POST') {
        await new Promise((res) => { resolvePost = res })
        return { ok: true, status: 201, json: async () => MOCK_ANALYSIS }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    })

    vi.stubGlobal('fetch', stallingFetch)
    render(<CardDetailPage />)
    await waitFor(() => screen.getByTestId('analyze-button'))

    fireEvent.click(screen.getByTestId('analyze-button'))

    await waitFor(() => expect(screen.getByTestId('analyze-button')).toBeDisabled())
    expect(screen.getByText('Running analysis…')).toBeInTheDocument()

    // Resolve to clean up
    resolvePost(undefined)
  })

  it('shows error alert when analysis POST fails', async () => {
    vi.stubGlobal('fetch', makeFetch(MOCK_CARD, null, true))
    render(<CardDetailPage />)
    await waitFor(() => screen.getByTestId('analyze-button'))
    fireEvent.click(screen.getByTestId('analyze-button'))
    await waitFor(() => screen.getByTestId('analysis-error'))
    expect(screen.getByTestId('analysis-error')).toHaveTextContent('eBay API unavailable')
  })

  it('re-enables analyze button after error', async () => {
    vi.stubGlobal('fetch', makeFetch(MOCK_CARD, null, true))
    render(<CardDetailPage />)
    await waitFor(() => screen.getByTestId('analyze-button'))
    fireEvent.click(screen.getByTestId('analyze-button'))
    await waitFor(() => screen.getByTestId('analysis-error'))
    expect(screen.getByTestId('analyze-button')).toBeEnabled()
  })
})
