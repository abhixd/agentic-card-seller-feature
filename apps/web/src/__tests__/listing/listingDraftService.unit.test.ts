import { describe, it, expect } from 'vitest'
import {
  generateTitle,
  toNinetyNinePrice,
  generateDescription,
  buildListingDraft,
} from '@/lib/listing/listingDraftService'
import type { CardSummary } from '@/types/analysis'
import type { ListingDraftInput } from '@/types/listing'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_CARD: CardSummary = {
  card_name:          'Charizard',
  franchise_or_brand: 'Pokemon',
  set_name:           'Base Set',
  year:               1999,
  card_number:        '4/102',
  variant:            null,
  category:           'tcg',
}

const BASE_INPUT: ListingDraftInput = {
  card:                 BASE_CARD,
  conditionScore:       null,
  estimatedMarketValue: 120,
  compRangeLow:         100,
  compRangeHigh:        140,
  netProceeds:          99.80,
  notes:                null,
  platform:             'ebay',
}

// ---------------------------------------------------------------------------
// generateTitle
// ---------------------------------------------------------------------------

describe('generateTitle', () => {
  it('builds a title with all fields present', () => {
    const title = generateTitle(BASE_CARD)
    expect(title).toBe('1999 Pokemon Charizard Base Set #4/102 Raw')
  })

  it('includes variant when present', () => {
    const title = generateTitle({ ...BASE_CARD, variant: 'Holo' })
    expect(title).toContain('Holo')
  })

  it('omits year when null', () => {
    const title = generateTitle({ ...BASE_CARD, year: null })
    expect(title).not.toMatch(/^\d{4}/)
  })

  it('omits card_number when null', () => {
    const title = generateTitle({ ...BASE_CARD, card_number: null })
    expect(title).not.toContain('#')
  })

  it('always ends with "Raw"', () => {
    expect(generateTitle(BASE_CARD)).toMatch(/Raw$/)
  })

  it('stays within 80 characters for a normal card', () => {
    const title = generateTitle(BASE_CARD)
    expect(title.length).toBeLessThanOrEqual(80)
  })

  it('drops set_name when title exceeds 80 chars (first fallback)', () => {
    const longCard: CardSummary = {
      ...BASE_CARD,
      card_name: 'LeBron James Rookie Card Silver Refractor Special Edition',
      set_name:  'Topps Chrome Finest Collection Ultra Premium',
      franchise_or_brand: 'NBA',
      year: 2003,
    }
    const title = generateTitle(longCard)
    expect(title.length).toBeLessThanOrEqual(80)
  })

  it('hard-truncates with "..." when even fallback exceeds 80 chars', () => {
    const extremeCard: CardSummary = {
      ...BASE_CARD,
      card_name: 'Michael Jeffrey Jordan Supreme Ultra Holofoil Special Collector Edition',
      franchise_or_brand: 'National Basketball Association Upper Deck',
      set_name:  'Irrelevant',
    }
    const title = generateTitle(extremeCard)
    expect(title.length).toBeLessThanOrEqual(80)
  })
})

// ---------------------------------------------------------------------------
// toNinetyNinePrice
// ---------------------------------------------------------------------------

describe('toNinetyNinePrice', () => {
  it('converts 120 → 119.99', () => {
    expect(toNinetyNinePrice(120)).toBe(119.99)
  })

  it('converts 24.3 → 24.99 (ceil rounds up, then -0.01)', () => {
    expect(toNinetyNinePrice(24.3)).toBe(24.99)
  })

  it('converts 100 → 99.99', () => {
    expect(toNinetyNinePrice(100)).toBe(99.99)
  })

  it('converts 1.5 → 1.99', () => {
    expect(toNinetyNinePrice(1.5)).toBe(1.99)
  })

  it('never returns less than 0.99', () => {
    expect(toNinetyNinePrice(0.1)).toBe(0.99)
  })
})

// ---------------------------------------------------------------------------
// generateDescription
// ---------------------------------------------------------------------------

describe('generateDescription', () => {
  it('includes card name and set', () => {
    const desc = generateDescription(BASE_INPUT)
    expect(desc).toContain('Charizard')
    expect(desc).toContain('Base Set')
  })

  it('includes year and card number', () => {
    const desc = generateDescription(BASE_INPUT)
    expect(desc).toContain('1999')
    expect(desc).toContain('#4/102')
  })

  it('includes estimated market value', () => {
    const desc = generateDescription(BASE_INPUT)
    expect(desc).toContain('$120.00')
  })

  it('includes comp range', () => {
    const desc = generateDescription(BASE_INPUT)
    expect(desc).toContain('$100.00')
    expect(desc).toContain('$140.00')
  })

  it('includes condition score when provided', () => {
    const desc = generateDescription({ ...BASE_INPUT, conditionScore: 18 })
    expect(desc).toContain('18/20')
  })

  it('omits condition score when null', () => {
    const desc = generateDescription({ ...BASE_INPUT, conditionScore: null })
    expect(desc).not.toContain('/20')
  })

  it('includes seller notes when provided', () => {
    const desc = generateDescription({ ...BASE_INPUT, notes: 'Minor surface wear on back.' })
    expect(desc).toContain('Minor surface wear on back.')
    expect(desc).toContain('SELLER NOTES')
  })

  it('omits seller notes section when notes is null', () => {
    const desc = generateDescription({ ...BASE_INPUT, notes: null })
    expect(desc).not.toContain('SELLER NOTES')
  })

  it('includes variant when present', () => {
    const desc = generateDescription({
      ...BASE_INPUT,
      card: { ...BASE_CARD, variant: '1st Edition' },
    })
    expect(desc).toContain('1st Edition')
  })

  it('includes shipping instructions', () => {
    const desc = generateDescription(BASE_INPUT)
    expect(desc).toContain('Ships within 1 business day')
    expect(desc).toContain('top loader')
  })

  it('always contains Raw / Ungraded', () => {
    const desc = generateDescription(BASE_INPUT)
    expect(desc).toContain('Raw / Ungraded')
  })
})

// ---------------------------------------------------------------------------
// buildListingDraft
// ---------------------------------------------------------------------------

describe('buildListingDraft', () => {
  it('returns a complete draft with all fields', () => {
    const draft = buildListingDraft(BASE_INPUT, 'item-1', 'analysis-1')
    expect(draft.title).toBeTruthy()
    expect(draft.description).toBeTruthy()
    expect(draft.suggestedPrice).not.toBeNull()
    expect(draft.itemId).toBe('item-1')
    expect(draft.analysisId).toBe('analysis-1')
    expect(draft.platform).toBe('ebay')
  })

  it('sets suggestedPrice from toNinetyNinePrice(estimatedMarketValue)', () => {
    const draft = buildListingDraft({ ...BASE_INPUT, estimatedMarketValue: 120 })
    expect(draft.suggestedPrice).toBe(119.99)
  })

  it('sets suggestedPrice to null when estimatedMarketValue is null', () => {
    const draft = buildListingDraft({ ...BASE_INPUT, estimatedMarketValue: null })
    expect(draft.suggestedPrice).toBeNull()
  })

  it('sets titleCharCount correctly', () => {
    const draft = buildListingDraft(BASE_INPUT)
    expect(draft.titleCharCount).toBe(draft.title.length)
  })

  it('sets generatedAt to an ISO timestamp', () => {
    const draft = buildListingDraft(BASE_INPUT)
    expect(() => new Date(draft.generatedAt)).not.toThrow()
    expect(draft.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('carries through compRangeLow/High and netProceeds', () => {
    const draft = buildListingDraft(BASE_INPUT)
    expect(draft.compRangeLow).toBe(100)
    expect(draft.compRangeHigh).toBe(140)
    expect(draft.netProceeds).toBe(99.80)
  })
})
