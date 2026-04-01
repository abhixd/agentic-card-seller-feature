import type { RawEbayComp } from './normalizeComps'

export type { RawEbayComp }

// ── Types ─────────────────────────────────────────────────────────────────────

interface EbayItem {
  title: string[]
  viewItemURL: string[]
  sellingStatus: Array<{ currentPrice: Array<{ __value__: string }> }>
  listingInfo: Array<{ endTime: string[] }>
}

interface EbayResponse {
  findCompletedItemsResponse?: Array<{
    ack: string[]
    searchResult?: Array<{ '@count': string; item?: EbayItem[] }>
    errorMessage?: Array<{ error: Array<{ message: string[] }> }>
  }>
}

export interface CardMeta {
  card_name: string
  franchise_or_brand?: string
  set_name?: string
  year?: number | null
  card_number?: string | null
  variant?: string | null
}

// ── Keyword building ───────────────────────────────────────────────────────────

/** Strip series prefix so eBay gets the short distinctive set name.
 *  "Scarlet & Violet: 151" → "151"
 *  "Sword & Shield: Vivid Voltage" → "Vivid Voltage"
 */
function getEbaySetTerm(setName: string): string {
  const stripped = setName
    .replace(
      /^(Scarlet\s*[&]\s*Violet|Sun\s*[&]\s*Moon|Sword\s*[&]\s*Shield|Black\s*[&]\s*White|HeartGold\s*SoulSilver|Diamond\s*[&]\s*Pearl|XY|EX)\s*[:\-]?\s*/i,
      '',
    )
    .trim()
  const result = stripped || setName
  return result
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Strip diacritics: "Pokémon" → "Pokemon" */
function normalizeTerm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Build an eBay search keyword from card metadata.
 * lang='en'  → English raw/graded search (default)
 * lang='jp'  → Japanese card search (prepends "Japanese", drops card number
 *              since JP numbering differs from EN)
 */
export function buildKeyword(card: CardMeta, lang: 'en' | 'jp' = 'en'): string {
  if (lang === 'jp') {
    return [
      'Japanese',
      'Pokemon',
      card.card_name,
      card.set_name ? getEbaySetTerm(card.set_name) : null,
      // Intentionally omit card_number — JP sets use different numbering
    ]
      .filter(Boolean)
      .join(' ')
      .trim()
      .slice(0, 100)
  }

  return [
    card.year != null && card.year <= 2010 ? card.year.toString() : null,
    card.franchise_or_brand ? normalizeTerm(card.franchise_or_brand) : null,
    card.card_name,
    card.set_name ? getEbaySetTerm(card.set_name) : null,
    card.card_number ? card.card_number.split('/')[0] : null,
  ]
    .filter(Boolean)
    .join(' ')
    .trim()
    .slice(0, 100)
}

// ── eBay Finding API ──────────────────────────────────────────────────────────

export interface EbayFetchResult {
  comps:    RawEbayComp[]
  apiError: boolean   // true = rate-limited or API failure; false = success (even if 0 results)
}

/**
 * Fetch completed eBay sales for the given keyword.
 * Pass force=true to bypass the Next.js fetch cache (e.g. manual refresh).
 * Returns { comps: [], apiError: true } on rate-limit / API errors.
 * Returns { comps: [], apiError: false } when eBay succeeds but found nothing.
 */
export async function fetchEbayComps(keyword: string, force = false): Promise<EbayFetchResult> {
  const appId   = process.env.EBAY_APP_ID
  const baseUrl = process.env.EBAY_FINDING_API_BASE_URL

  if (!appId || !baseUrl || appId.includes('SBX') || appId === 'YourEbayAppId-Sandbox') {
    console.warn('[eBay] Missing or sandbox EBAY_APP_ID — returning empty comps')
    return { comps: [], apiError: false }
  }

  const params = new URLSearchParams({
    'OPERATION-NAME':                 'findCompletedItems',
    'SERVICE-VERSION':                '1.0.0',
    'SECURITY-APPNAME':               appId,
    'RESPONSE-DATA-FORMAT':           'JSON',
    'keywords':                       keyword,
    'itemFilter(0).name':             'SoldItemsOnly',
    'itemFilter(0).value':            'true',
    'sortOrder':                      'EndTimeSoonest',
    'paginationInput.entriesPerPage': '100',
    'paginationInput.pageNumber':     '1',
  })

  try {
    const res = await fetch(`${baseUrl}?${params}`, {
      // force=true bypasses the Next.js cache so a manual refresh fetches live eBay data
      ...(force ? { cache: 'no-store' } : { next: { revalidate: 28_800 } }), // 8 hours
    })

    if (!res.ok) {
      console.error('[eBay] HTTP', res.status)
      return { comps: [], apiError: true }
    }

    const json: EbayResponse = await res.json()
    const root = json.findCompletedItemsResponse?.[0]

    if (!root) {
      // Top-level errorMessage (rate limit, auth error, etc.)
      const errMsg = (json as any).errorMessage?.[0]?.error?.[0]?.message?.[0]
      console.error('[eBay] No findCompletedItemsResponse. Error:', errMsg ?? 'unknown')
      return { comps: [], apiError: true }
    }

    if (root.ack?.[0] !== 'Success') {
      console.error('[eBay] API error:', root.errorMessage?.[0]?.error?.[0]?.message?.[0])
      return { comps: [], apiError: true }
    }

    const comps = (root.searchResult?.[0]?.item ?? [])
      .map((item) => {
        const priceStr  = item.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__']
        const soldPrice = priceStr ? parseFloat(priceStr) : null
        const endTime   = item.listingInfo?.[0]?.endTime?.[0]
        if (!soldPrice || soldPrice <= 0) return null
        return {
          title:     item.title?.[0] ?? '',
          soldPrice,
          soldAt:    endTime ? new Date(endTime) : null,
          sourceUrl: item.viewItemURL?.[0] ?? '',
        }
      })
      .filter((c): c is RawEbayComp => c !== null)

    return { comps, apiError: false }
  } catch (err) {
    console.error('[eBay] Fetch error:', err)
    return { comps: [], apiError: true }
  }
}
