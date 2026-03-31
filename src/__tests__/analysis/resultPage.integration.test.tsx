import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { FullAnalysisResponse } from '@/types/analysis'

// ---------------------------------------------------------------------------
// Mock next/navigation
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({
  useParams: vi.fn().mockReturnValue({ analysisId: '550e8400-e29b-41d4-a716-446655440010' }),
  useRouter: vi.fn().mockReturnValue({ push: vi.fn() }),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_ANALYSIS: FullAnalysisResponse = {
  analysis_id: '550e8400-e29b-41d4-a716-446655440010',
  catalog_id:  '550e8400-e29b-41d4-a716-446655440001',
  card: {
    card_name:          'Charizard',
    franchise_or_brand: 'Pokemon',
    set_name:           'Base Set',
    year:               1999,
    card_number:        '4/102',
    variant:            null,
    category:           'tcg',
  },
  comps: {
    rawEstimate:     120.00,
    compRangeLow:    100.00,
    compRangeHigh:   140.00,
    confidenceScore: 0.7,
    compCount:       8,
    daysOfData:      45,
    comps:           [],
  },
  fees: {
    grossRevenue:    120,
    platformFee:     16.20,
    shippingCost:    4.00,
    acquisitionCost: 0,
    netProceeds:     99.80,
    roi:             null,
    platform:        'eBay',
    breakdown:       [],
  },
  grading_scenarios: [
    {
      gradeLabel:         'PSA 10',
      gradedValue:        540.00,
      gradingFee:         50,
      shippingToGrader:   15,
      netUpsideVsRawSell: 287.12,
      roiPercent:         287.4,
      recommendation:     'strong',
      tierLabel:          'Best Case — PSA Standard (~45 days)',
    },
    {
      gradeLabel:         'PSA 9',
      gradedValue:        240.00,
      gradingFee:         50,
      shippingToGrader:   15,
      netUpsideVsRawSell: 37.12,
      roiPercent:         37.2,
      recommendation:     'marginal',
      tierLabel:          'Base Case — PSA Standard (~45 days)',
    },
  ],
  recommendation: {
    type:      'GRADE',
    rationale: 'Strong condition and ~$287 net upside after grading fees.',
  },
  condition_score:   18,
  condition_ratings: {
    corners_rating:   5,
    edges_rating:     4,
    surface_rating:   5,
    centering_rating: 4,
  },
  assumptions: {
    platform:        'ebay',
    shippingCost:    4,
    acquisitionCost: 0,
    ebayKeyword:     'Charizard Base Set 4/102',
    compCount:       8,
    daysOfData:      45,
    conditionScore:  18,
    feeResult:       {} as any,
  },
  created_at: '2026-03-29T00:00:00.000Z',
}

function makeAnalysisFetch(res: FullAnalysisResponse | null, fails = false) {
  return vi.fn(async () => {
    if (fails) {
      return { ok: false, status: 404, json: async () => ({ error: 'Analysis not found' }) }
    }
    return { ok: true, status: 200, json: async () => res }
  })
}

import AnalysisResultPage from '@/app/(app)/analyze/result/[analysisId]/page'

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

describe('AnalysisResultPage — loading state', () => {
  it('shows loading skeleton initially', () => {
    // Stall fetch so loading state is visible
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(<AnalysisResultPage />)
    expect(screen.getByTestId('result-loading')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

describe('AnalysisResultPage — error state', () => {
  it('shows error message when fetch fails', async () => {
    vi.stubGlobal('fetch', makeAnalysisFetch(null, true))
    render(<AnalysisResultPage />)
    await waitFor(() => screen.getByTestId('result-error'))
    expect(screen.getByTestId('result-error')).toHaveTextContent('Analysis not found')
  })
})

// ---------------------------------------------------------------------------
// Happy path — full render
// ---------------------------------------------------------------------------

describe('AnalysisResultPage — full result display', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', makeAnalysisFetch(MOCK_ANALYSIS))
  })

  it('renders the card name and set', async () => {
    render(<AnalysisResultPage />)
    await waitFor(() => screen.getByTestId('analysis-result'))
    expect(screen.getByText('Charizard')).toBeInTheDocument()
    expect(screen.getByText(/Base Set/)).toBeInTheDocument()
  })

  it('renders the recommendation banner', async () => {
    render(<AnalysisResultPage />)
    await waitFor(() => screen.getByTestId('recommendation-banner'))
    expect(screen.getByTestId('recommendation-banner')).toBeInTheDocument()
    expect(screen.getByTestId('recommendation-type')).toHaveTextContent('Submit for Grading')
  })

  it('renders recommendation rationale', async () => {
    render(<AnalysisResultPage />)
    await waitFor(() => screen.getByTestId('recommendation-rationale'))
    expect(screen.getByTestId('recommendation-rationale')).toHaveTextContent(
      MOCK_ANALYSIS.recommendation.rationale
    )
  })

  it('renders the comps section with estimate', async () => {
    render(<AnalysisResultPage />)
    await waitFor(() => screen.getByTestId('comps-section'))
    expect(screen.getByTestId('comps-estimate')).toHaveTextContent('$120.00')
    expect(screen.getByTestId('comps-range')).toHaveTextContent('$100.00 – $140.00')
    expect(screen.getByTestId('comps-count')).toHaveTextContent('8 comps')
  })

  it('renders the fees breakdown with net proceeds', async () => {
    render(<AnalysisResultPage />)
    await waitFor(() => screen.getByTestId('fees-breakdown'))
    expect(screen.getByTestId('fee-net')).toHaveTextContent('$99.80')
  })

  it('renders grading scenarios for GRADE recommendation', async () => {
    render(<AnalysisResultPage />)
    await waitFor(() => screen.getByTestId('grading-scenarios'))
    expect(screen.getByTestId('grading-scenario-psa-10')).toBeInTheDocument()
    expect(screen.getByTestId('grading-scenario-psa-9')).toBeInTheDocument()
  })

  it('shows condition score when provided', async () => {
    render(<AnalysisResultPage />)
    await waitFor(() => screen.getByTestId('analysis-result'))
    expect(screen.getByText('18 / 20')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// SELL_RAW — grading scenarios hidden
// ---------------------------------------------------------------------------

describe('AnalysisResultPage — SELL_RAW recommendation', () => {
  it('does not render grading scenarios when recommendation is SELL_RAW', async () => {
    const sellRawAnalysis: FullAnalysisResponse = {
      ...MOCK_ANALYSIS,
      recommendation: { type: 'SELL_RAW', rationale: 'Sell raw is the best action.' },
      grading_scenarios: [],
    }
    vi.stubGlobal('fetch', makeAnalysisFetch(sellRawAnalysis))
    render(<AnalysisResultPage />)
    await waitFor(() => screen.getByTestId('recommendation-banner'))
    expect(screen.queryByTestId('grading-scenarios')).not.toBeInTheDocument()
    expect(screen.getByTestId('recommendation-type')).toHaveTextContent('Sell Raw')
  })
})

// ---------------------------------------------------------------------------
// INSUFFICIENT_CONFIDENCE — minimal display
// ---------------------------------------------------------------------------

describe('AnalysisResultPage — INSUFFICIENT_CONFIDENCE recommendation', () => {
  it('renders insufficient confidence banner without grading scenarios', async () => {
    const noDataAnalysis: FullAnalysisResponse = {
      ...MOCK_ANALYSIS,
      recommendation: {
        type:      'INSUFFICIENT_CONFIDENCE',
        rationale: 'Only 1 recent sale found.',
      },
      comps: { ...MOCK_ANALYSIS.comps, compCount: 1, confidenceScore: 0.1 },
      grading_scenarios: [],
    }
    vi.stubGlobal('fetch', makeAnalysisFetch(noDataAnalysis))
    render(<AnalysisResultPage />)
    await waitFor(() => screen.getByTestId('recommendation-banner'))
    expect(screen.getByTestId('recommendation-type')).toHaveTextContent('Insufficient Data')
    expect(screen.queryByTestId('grading-scenarios')).not.toBeInTheDocument()
  })
})
