/**
 * eBay Sell API + Analytics API wrappers.
 * All functions take a Bearer access token — call getValidToken() first.
 */

import { EBAY_API_BASE } from './auth'

// ── Types ──────────────────────────────────────────────────────────────────────

export type EbayCondition =
  | 'NEW'
  | 'LIKE_NEW'
  | 'EXCELLENT'
  | 'VERY_GOOD'
  | 'GOOD'
  | 'ACCEPTABLE'
  | 'FOR_PARTS_OR_NOT_WORKING'

export const CONDITION_LABELS: Record<EbayCondition, string> = {
  NEW:                    'New',
  LIKE_NEW:               'Like New',
  EXCELLENT:              'Excellent',
  VERY_GOOD:              'Very Good (Near Mint)',
  GOOD:                   'Good (Excellent-Mint)',
  ACCEPTABLE:             'Acceptable (Good)',
  FOR_PARTS_OR_NOT_WORKING: 'Poor / Damaged',
}

export interface SellerPolicy {
  id:   string
  name: string
}

export interface SellerPolicies {
  fulfillment: SellerPolicy[]
  payment:     SellerPolicy[]
  return:      SellerPolicy[]
}

export interface CardListingData {
  inventoryItemId: string
  title:           string
  description:     string
  imageUrls:       string[]
  aspects:         Record<string, string[]>
  categoryId:      string
  price:           number
  condition:       EbayCondition
  conditionDesc:   string
  fulfillmentPolicyId: string
  paymentPolicyId:     string
  returnPolicyId:      string
}

export interface PublishedListing {
  ebayItemId:  string
  ebayOfferId: string
  ebayUrl:     string
}

// ── eBay Category helpers ──────────────────────────────────────────────────────

/** Returns the best eBay category ID for a given franchise. */
export function getCategoryId(franchise: string): string {
  const f = franchise.toLowerCase()
  if (f.includes('pokemon') || f.includes('pokémon')) return '183454' // Pokémon Individual Cards
  if (f.includes('magic') || f.includes('mtg'))         return '19107' // Magic: The Gathering
  if (f.includes('yugioh') || f.includes('yu-gi-oh'))   return '60082' // Yu-Gi-Oh! Individual Cards
  if (f.includes('one piece'))                           return '261324'
  return '183050' // Non-Sport Trading Cards — Individual (fallback)
}

/** Builds a listing title from card metadata (max 80 chars — eBay limit). */
export function buildTitle(card: {
  card_name: string
  franchise_or_brand: string
  set_name?: string | null
  year?: number | null
  card_number?: string | null
  variant?: string | null
}): string {
  const parts = [
    card.year?.toString(),
    card.franchise_or_brand,
    card.card_name,
    card.set_name,
    card.card_number ? `#${card.card_number}` : null,
    card.variant,
  ].filter(Boolean).join(' ')
  return parts.slice(0, 80)
}

// ── Sell API ───────────────────────────────────────────────────────────────────

function sellHeaders(token: string): HeadersInit {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
    'Content-Language': 'en-US',
  }
}

async function sellRequest(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${EBAY_API_BASE}${path}`, {
    method,
    headers: sellHeaders(token),
    body:    body ? JSON.stringify(body) : undefined,
    cache:   'no-store',
  })
}

/** Fetches the seller's fulfillment, payment and return policies. */
export async function getSellerPolicies(token: string): Promise<SellerPolicies> {
  const [fulfillRes, paymentRes, returnRes] = await Promise.all([
    sellRequest(token, 'GET', '/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US'),
    sellRequest(token, 'GET', '/sell/account/v1/payment_policy?marketplace_id=EBAY_US'),
    sellRequest(token, 'GET', '/sell/account/v1/return_policy?marketplace_id=EBAY_US'),
  ])

  const [fulfillJson, paymentJson, returnJson] = await Promise.all([
    fulfillRes.json(),
    paymentRes.json(),
    returnRes.json(),
  ])

  return {
    fulfillment: (fulfillJson.fulfillmentPolicies ?? []).map((p: { fulfillmentPolicyId: string; name: string }) => ({
      id: p.fulfillmentPolicyId, name: p.name,
    })),
    payment: (paymentJson.paymentPolicies ?? []).map((p: { paymentPolicyId: string; name: string }) => ({
      id: p.paymentPolicyId, name: p.name,
    })),
    return: (returnJson.returnPolicies ?? []).map((p: { returnPolicyId: string; name: string }) => ({
      id: p.returnPolicyId, name: p.name,
    })),
  }
}

/**
 * Full listing pipeline: createInventoryItem → createOffer → publishOffer.
 * Returns the live eBay listing details.
 */
export async function publishListing(
  token: string,
  data:  CardListingData,
): Promise<PublishedListing> {
  const sku = data.inventoryItemId

  // 1. Create / replace inventory item
  const invRes = await sellRequest(
    token,
    'PUT',
    `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    {
      availability: {
        shipToLocationAvailability: { quantity: 1 },
      },
      condition:            data.condition,
      conditionDescription: data.conditionDesc,
      product: {
        title:       data.title,
        description: data.description,
        imageUrls:   data.imageUrls,
        aspects:     data.aspects,
      },
    },
  )

  if (!invRes.ok && invRes.status !== 204) {
    const body = await invRes.text()
    throw new Error(`eBay createInventoryItem failed (${invRes.status}): ${body}`)
  }

  // 2. Create offer
  const offerRes = await sellRequest(token, 'POST', '/sell/inventory/v1/offer', {
    sku,
    marketplaceId:       'EBAY_US',
    format:              'FIXED_PRICE',
    availableQuantity:   1,
    categoryId:          data.categoryId,
    listingDescription:  data.description,
    pricingSummary: {
      price: { currency: 'USD', value: data.price.toFixed(2) },
    },
    listingPolicies: {
      fulfillmentPolicyId: data.fulfillmentPolicyId,
      paymentPolicyId:     data.paymentPolicyId,
      returnPolicyId:      data.returnPolicyId,
    },
  })

  if (!offerRes.ok) {
    const body = await offerRes.text()
    throw new Error(`eBay createOffer failed (${offerRes.status}): ${body}`)
  }

  const { offerId } = await offerRes.json()

  // 3. Publish offer → live listing
  const publishRes = await sellRequest(
    token,
    'POST',
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
  )

  if (!publishRes.ok) {
    const body = await publishRes.text()
    throw new Error(`eBay publishOffer failed (${publishRes.status}): ${body}`)
  }

  const { listingId } = await publishRes.json()
  const sandbox = process.env.EBAY_SANDBOX === 'true'
  const ebayUrl = sandbox
    ? `https://www.sandbox.ebay.com/itm/${listingId}`
    : `https://www.ebay.com/itm/${listingId}`

  return { ebayItemId: listingId, ebayOfferId: offerId, ebayUrl }
}

// ── Analytics API ──────────────────────────────────────────────────────────────

export interface ListingAnalytics {
  ebayItemId:   string
  impressions:  number
  views:        number
  transactions: number
}

/** Fetches traffic analytics for a list of eBay item IDs (last 30 days). */
export async function getTrafficReport(
  token:      string,
  ebayItemIds: string[],
): Promise<ListingAnalytics[]> {
  if (ebayItemIds.length === 0) return []

  const endDate   = new Date()
  const startDate = new Date(endDate.getTime() - 30 * 86_400_000)
  const fmt       = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '')

  const idList = ebayItemIds.join('|')
  const params = new URLSearchParams({
    dimension: 'LISTING',
    metric:    'LISTING_IMPRESSION_TOTAL,LISTING_VIEWS_TOTAL,TRANSACTION',
    filter:    `listing_ids:{${idList}},date_range:[${fmt(startDate)}..${fmt(endDate)}]`,
  })

  const res = await sellRequest(
    token,
    'GET',
    `/sell/analytics/v1/traffic_report?${params.toString()}`,
  )

  if (!res.ok) {
    console.error('[eBay analytics] HTTP', res.status, await res.text())
    return []
  }

  const json = await res.json()
  const records: ListingAnalytics[] = []

  for (const record of json.records ?? []) {
    const dimVal = record.dimensionValues?.find(
      (d: { dimensionKey: string }) => d.dimensionKey === 'LISTING',
    )
    if (!dimVal) continue

    const metric = (name: string): number => {
      const m = record.metricValues?.find(
        (mv: { name: string }) => mv.name === name,
      )
      return m?.applicable ? parseInt(m.value ?? '0', 10) : 0
    }

    records.push({
      ebayItemId:   dimVal.value,
      impressions:  metric('LISTING_IMPRESSION_TOTAL'),
      views:        metric('LISTING_VIEWS_TOTAL'),
      transactions: metric('TRANSACTION'),
    })
  }

  return records
}
