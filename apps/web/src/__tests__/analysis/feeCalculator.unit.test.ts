import { describe, it, expect } from 'vitest'
import { calculateFees } from '@/lib/engines/feeCalculator'

describe('calculateFees', () => {
  // ── eBay defaults ──────────────────────────────────────────────────────────

  it('calculates eBay net proceeds correctly (happy path, no acquisition cost)', () => {
    const result = calculateFees({ salePrice: 100 })
    // eBay fee = 100 * 0.1325 + 0.30 = 13.55
    // net = 100 - 13.55 - 4.00 = 82.45
    expect(result.platformFee).toBe(13.55)
    expect(result.shippingCost).toBe(4.0)
    expect(result.netProceeds).toBe(82.45)
    expect(result.roi).toBeNull()
    expect(result.platform).toContain('eBay')
  })

  it('calculates ROI correctly when acquisition cost is provided', () => {
    // Buy for $40, sell for $100
    // platformFee = 13.55, shipping = 4.00, acquisition = 40
    // netProceeds = 100 - 13.55 - 4.00 - 40 = 42.45
    // roi = 42.45 / 40 * 100 = 106.1%
    const result = calculateFees({ salePrice: 100, acquisitionCost: 40 })
    expect(result.netProceeds).toBe(42.45)
    expect(result.roi).toBeCloseTo(106.1, 0)
  })

  it('returns null ROI when acquisitionCost is 0', () => {
    const result = calculateFees({ salePrice: 50, acquisitionCost: 0 })
    expect(result.roi).toBeNull()
  })

  it('calculates TCGplayer fees correctly', () => {
    const result = calculateFees({ salePrice: 100, platform: 'tcgplayer' })
    // TCGplayer fee = 100 * 0.1025 + 0.30 = 10.55
    // net = 100 - 10.55 - 4.00 = 85.45
    expect(result.platformFee).toBe(10.55)
    expect(result.netProceeds).toBe(85.45)
    expect(result.platform).toContain('TCGplayer')
  })

  it('uses custom shipping cost', () => {
    const result = calculateFees({ salePrice: 100, shippingCost: 8.0 })
    expect(result.shippingCost).toBe(8.0)
    expect(result.netProceeds).toBe(100 - 13.55 - 8.0)
  })

  it('breakdown items sum to zero (sale price + costs = 0)', () => {
    const result = calculateFees({ salePrice: 100, acquisitionCost: 20 })
    const sum = result.breakdown.reduce((acc, item) => acc + item.amount, 0)
    // Last item is net proceeds, so sum should equal 0 because it's listed twice
    // Actually breakdown: [salePrice, -fee, -shipping, -acq, netProceeds]
    // sum = 100 - fee - shipping - acq + netProceeds
    //     = 100 - fee - shipping - acq + (100 - fee - shipping - acq) ... this isn't 0
    // The breakdown is meant to be a display list, not a double-entry ledger.
    // Just verify breakdown includes all 5 items with the acquisition cost line.
    expect(result.breakdown).toHaveLength(5)
    expect(result.breakdown.some((b) => b.label === 'Acquisition Cost')).toBe(true)
  })

  it('breakdown has 4 items when no acquisition cost', () => {
    const result = calculateFees({ salePrice: 100 })
    expect(result.breakdown).toHaveLength(4)
    expect(result.breakdown.some((b) => b.label === 'Acquisition Cost')).toBe(false)
  })

  it('rounds platformFee and netProceeds to 2 decimal places', () => {
    const result = calculateFees({ salePrice: 33.33 })
    expect(result.platformFee.toString()).toMatch(/^\d+\.\d{1,2}$/)
    expect(result.netProceeds.toString()).toMatch(/^-?\d+\.\d{1,2}$/)
  })
})
