import type { CardSummary } from './analysis'

export interface ListingDraft {
  itemId:         string | null
  analysisId:     string | null
  card:           CardSummary
  title:          string
  titleCharCount: number      // for showing eBay's 80-char limit
  description:    string
  suggestedPrice: number | null
  compRangeLow:   number | null
  compRangeHigh:  number | null
  netProceeds:    number | null
  platform:       'ebay' | 'tcgplayer'
  generatedAt:    string
}

export interface ListingDraftInput {
  card:                 CardSummary
  conditionScore:       number | null
  estimatedMarketValue: number | null
  compRangeLow:         number | null
  compRangeHigh:        number | null
  netProceeds:          number | null
  notes:                string | null
  platform:             'ebay' | 'tcgplayer'
}
