import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { FullAnalysisResponse } from '@/types/analysis'

// ---------------------------------------------------------------------------
// Hoist mock variables before vi.mock factories run
// ---------------------------------------------------------------------------

const { mockRunAnalysis, mockGetUser } = vi.hoisted(() => ({
  mockRunAnalysis: vi.fn(),
  mockGetUser:     vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock('@/lib/analysis/analysisService', () => ({
  runAnalysis: mockRunAnalysis,
}))

import { POST } from '@/app/api/analysis/route'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATALOG_ID  = '550e8400-e29b-41d4-a716-446655440001'
const ANALYSIS_ID = '550e8400-e29b-41d4-a716-446655440002'

const MOCK_ANALYSIS: FullAnalysisResponse = {
  analysis_id: ANALYSIS_ID,
  catalog_id:  CATALOG_ID,
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
    rawEstimate:     120,
    compRangeLow:    100,
    compRangeHigh:   140,
    confidenceScore: 0.7,
    compCount:       8,
    daysOfData:      45,
    comps:           [],
  },
  fees: {
    grossRevenue:    120,
    platformFee:     16.2,
    shippingCost:    4.0,
    acquisitionCost: 0,
    netProceeds:     99.8,
    roi:             null,
    platform:        'eBay',
    breakdown:       [],
  },
  grading_scenarios: [],
  recommendation:    { type: 'SELL_RAW', rationale: 'Sell raw is the best action.' },
  condition_score:   null,
  condition_ratings: null,
  assumptions: {
    platform:        'ebay',
    shippingCost:    4.0,
    acquisitionCost: 0,
    ebayKeyword:     'Charizard Base Set 4/102',
    compCount:       8,
    daysOfData:      45,
    conditionScore:  null,
    feeResult:       {} as any,
  },
  created_at: '2026-03-29T00:00:00.000Z',
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/analysis', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: authenticated
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } } })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/analysis', () => {
  describe('authentication', () => {
    it('returns 401 when not authenticated', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } })
      const res = await POST(makeRequest({ catalogId: CATALOG_ID }))
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Unauthorized')
    })
  })

  describe('request validation', () => {
    it('returns 400 for invalid JSON body', async () => {
      const req = new NextRequest('http://localhost/api/analysis', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    'not-json',
      })
      const res = await POST(req)
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('Invalid JSON body')
    })

    it('returns 400 when catalogId is missing', async () => {
      const res = await POST(makeRequest({}))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('Invalid request')
    })

    it('returns 400 when catalogId is not a valid UUID', async () => {
      const res = await POST(makeRequest({ catalogId: 'not-a-uuid' }))
      expect(res.status).toBe(400)
    })
  })

  describe('happy path', () => {
    it('returns 201 with the full analysis response', async () => {
      mockRunAnalysis.mockResolvedValue({ analysis: MOCK_ANALYSIS, error: null })

      const res = await POST(makeRequest({ catalogId: CATALOG_ID }))
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.analysis_id).toBe(ANALYSIS_ID)
      expect(body.catalog_id).toBe(CATALOG_ID)
      expect(body.recommendation.type).toBe('SELL_RAW')
    })

    it('passes defaults (ebay platform, $4 shipping, $0 acquisition) to runAnalysis', async () => {
      mockRunAnalysis.mockResolvedValue({ analysis: MOCK_ANALYSIS, error: null })

      await POST(makeRequest({ catalogId: CATALOG_ID }))

      expect(mockRunAnalysis).toHaveBeenCalledWith(
        expect.anything(),
        'user-123',
        expect.objectContaining({
          catalogId:       CATALOG_ID,
          platform:        'ebay',
          shippingCost:    4.0,
          acquisitionCost: 0,
        })
      )
    })

    it('passes custom options to runAnalysis when provided', async () => {
      mockRunAnalysis.mockResolvedValue({ analysis: MOCK_ANALYSIS, error: null })

      await POST(makeRequest({
        catalogId:       CATALOG_ID,
        platform:        'tcgplayer',
        shippingCost:    6.0,
        acquisitionCost: 25,
      }))

      expect(mockRunAnalysis).toHaveBeenCalledWith(
        expect.anything(),
        'user-123',
        expect.objectContaining({
          platform:        'tcgplayer',
          shippingCost:    6.0,
          acquisitionCost: 25,
        })
      )
    })
  })

  describe('sparse / low-confidence data path', () => {
    it('returns INSUFFICIENT_CONFIDENCE recommendation when comps are sparse', async () => {
      const sparseAnalysis: FullAnalysisResponse = {
        ...MOCK_ANALYSIS,
        recommendation:    { type: 'INSUFFICIENT_CONFIDENCE', rationale: 'Only 1 recent sale found.' },
        comps: { ...MOCK_ANALYSIS.comps, compCount: 1, confidenceScore: 0.1 },
      }
      mockRunAnalysis.mockResolvedValue({ analysis: sparseAnalysis, error: null })

      const res = await POST(makeRequest({ catalogId: CATALOG_ID }))
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.recommendation.type).toBe('INSUFFICIENT_CONFIDENCE')
    })
  })

  describe('service error handling', () => {
    it('returns 500 when runAnalysis returns an error', async () => {
      mockRunAnalysis.mockResolvedValue({ analysis: null, error: 'Card not found in catalog.' })

      const res = await POST(makeRequest({ catalogId: CATALOG_ID }))
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error).toBe('Card not found in catalog.')
    })

    it('returns 500 with fallback message when analysis is null and no error string', async () => {
      mockRunAnalysis.mockResolvedValue({ analysis: null, error: null })

      const res = await POST(makeRequest({ catalogId: CATALOG_ID }))
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error).toBe('Analysis failed')
    })
  })
})
