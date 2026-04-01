// JustTCG API — https://justtcg.com/docs
// Provides daily TCGPlayer market price history (up to 180 days).
// No graded card support — raw/NM market price only.

export interface JustTcgPoint {
  date:  string   // ISO string (converted from Unix timestamp)
  price: number
}

export interface JustTcgFetchResult {
  points:   JustTcgPoint[]
  keyword:  string
  apiError: boolean
}

interface JustTcgVariant {
  id:             string
  condition:      string   // 'NM' | 'LP' | 'MP' | 'HP' | 'DMG' | 'S'
  printing:       string   // 'Normal' | 'Foil'
  language:       string   // 'English' | 'Japanese' | ...
  price:          number
  priceHistory?:  Array<{ timestamp: number; price: number }>
}

interface JustTcgCard {
  id:       string
  name:     string
  set:      string
  number:   string
  variants: JustTcgVariant[]
}

// Normalise a card number for comparison: "006/165" → "6", "025" → "25"
function normaliseNum(n: string | null | undefined): string {
  if (!n) return ''
  return String(parseInt(n.split('/')[0], 10))
}

const CONDITION_RANK: Record<string, number> = {
  'NM': 5, 'Near Mint': 5,
  'LP': 4, 'Lightly Played': 4,
  'MP': 3, 'Moderately Played': 3,
  'HP': 2, 'Heavily Played': 2,
  'DMG': 1, 'Damaged': 1,
}

function pickBestVariant(variants: JustTcgVariant[]): JustTcgVariant | null {
  // Priority: best condition English → best condition any language → first with history
  // Printing (Normal / Holofoil / Reverse Holofoil) is NOT filtered — include all
  const score = (v: JustTcgVariant) => {
    let s = CONDITION_RANK[v.condition] ?? 0
    if (v.language === 'English') s += 10  // strong preference for English
    return s
  }
  const withHistory = variants.filter((v) => (v.priceHistory?.length ?? 0) > 0)
  const pool = withHistory.length ? withHistory : variants
  if (!pool.length) return null
  return pool.sort((a, b) => score(b) - score(a))[0]
}

function findBestCard(cards: JustTcgCard[], cardName: string, cardNumber: string | null | undefined): JustTcgCard | null {
  if (!cards.length) return null

  const normTarget = normaliseNum(cardNumber)
  const nameLower  = cardName.toLowerCase()

  // Exact name + number match first
  if (normTarget) {
    const exact = cards.find(
      (c) => c.name.toLowerCase() === nameLower && normaliseNum(c.number) === normTarget
    )
    if (exact) return exact
  }

  // Exact name match (any number)
  const byName = cards.find((c) => c.name.toLowerCase() === nameLower)
  if (byName) return byName

  // Partial name match
  return cards.find((c) => c.name.toLowerCase().includes(nameLower)) ?? cards[0]
}

export async function fetchJustTcgPriceHistory(
  cardName: string,
  cardNumber: string | null | undefined,
  duration: '7d' | '30d' | '90d' | '180d' = '90d',
  force = false,
): Promise<JustTcgFetchResult> {
  const apiKey = process.env.JUSTTCG_API_KEY
  if (!apiKey) return { points: [], keyword: cardName, apiError: false }

  // Include card number in query to narrow results (e.g. "Charizard ex 125")
  const baseNum = cardNumber ? cardNumber.split('/')[0] : null
  const q = baseNum ? `${cardName} ${baseNum}` : cardName

  const params = new URLSearchParams({
    q,
    include_price_history: 'true',
    priceHistoryDuration:  duration,
  })

  const keyword = `${cardName}${cardNumber ? ` #${cardNumber.split('/')[0]}` : ''}`

  try {
    const res = await fetch(`https://api.justtcg.com/v1/cards?${params}`, {
      headers: { 'x-api-key': apiKey },
      ...(force ? { cache: 'no-store' } : { next: { revalidate: 86_400 } }),
    })

    if (res.status === 429) {
      console.warn('[JustTCG] Rate limit hit')
      return { points: [], keyword, apiError: true }
    }

    if (!res.ok) {
      console.error('[JustTCG] HTTP', res.status)
      return { points: [], keyword, apiError: true }
    }

    const json = await res.json()
    const cards: JustTcgCard[] = json.data ?? []

    const match   = findBestCard(cards, cardName, cardNumber)
    if (!match) return { points: [], keyword, apiError: false }

    const variant = pickBestVariant(match.variants ?? [])
    if (!variant || !variant.priceHistory?.length) return { points: [], keyword, apiError: false }

    const points: JustTcgPoint[] = variant.priceHistory
      .map((p) => ({
        date:  new Date(p.timestamp * 1000).toISOString(),
        price: p.price,
      }))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

    return { points, keyword, apiError: false }
  } catch (err) {
    console.error('[JustTCG] Fetch error:', err)
    return { points: [], keyword, apiError: true }
  }
}
