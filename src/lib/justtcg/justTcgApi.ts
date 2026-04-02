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
  priceHistory?:  Array<{ t: number; p: number }>  // API uses short field names
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

function pickBestVariant(variants: JustTcgVariant[], knownPrinting?: string | null): JustTcgVariant | null {
  // Map TCGPlayer band names to JustTCG printing keywords
  const PRINTING_MAP: Record<string, string[]> = {
    holofoil:             ['holo', 'foil'],
    '1stEditionHolofoil': ['1st', 'holo'],
    '1stEditionNormal':   ['1st'],
    reverseHolofoil:      ['reverse'],
    unlimitedHolofoil:    ['holo'],
    normal:               ['normal'],
  }

  const score = (v: JustTcgVariant) => {
    let s = CONDITION_RANK[v.condition] ?? 0
    if (v.language === 'English') s += 10

    // Bonus if printing matches the known TCGPlayer band
    if (knownPrinting) {
      const keywords = PRINTING_MAP[knownPrinting] ?? []
      const printingLower = v.printing?.toLowerCase() ?? ''
      if (keywords.some(kw => printingLower.includes(kw))) s += 20
    }

    return s
  }

  const withHistory = variants.filter((v) => (v.priceHistory?.length ?? 0) > 0)
  const pool = withHistory.length ? withHistory : variants
  if (!pool.length) return null
  return pool.sort((a, b) => score(b) - score(a))[0]
}

/**
 * Normalise a card name for fuzzy matching:
 * - lowercase
 * - replace hyphens/underscores with spaces
 * - collapse multiple spaces
 * This handles variants like "Charizard-EX" vs "Charizard EX",
 * "Pikachu V-UNION" vs "Pikachu V UNION", etc.
 */
function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Normalise a set name for fuzzy matching.
 * Strips common prefixes like "SWSH09:", "SV01:", parenthetical codes, etc.
 * "SWSH09: Brilliant Stars" → "brilliant stars"
 * "Scarlet & Violet (SV1)" → "scarlet violet sv1"
 */
function normaliseSetName(s: string | null | undefined): string {
  if (!s) return ''
  return s
    .replace(/^[A-Z0-9]+:\s*/, '')      // strip leading series codes like "SWSH09: "
    .replace(/\(.*?\)/g, ' ')           // remove parenthetical codes
    .toLowerCase()
    .replace(/[-_&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function findBestCard(
  cards: JustTcgCard[],
  cardName: string,
  cardNumber: string | null | undefined,
  setName?: string | null,
): JustTcgCard | null {
  if (!cards.length) return null

  const normTarget  = normaliseNum(cardNumber)
  const normName    = normaliseName(cardName)
  const normSet     = normaliseSetName(setName)

  // 1. Exact name + number + set — most specific, prevents wrong-set matches
  if (normTarget && normSet) {
    const exact = cards.find(
      (c) =>
        normaliseName(c.name) === normName &&
        normaliseNum(c.number) === normTarget &&
        normaliseSetName(c.set).includes(normSet.split(' ')[0])  // first keyword of set
    )
    if (exact) return exact
  }

  // 2. Exact normalised name + number
  if (normTarget) {
    const exact = cards.find(
      (c) => normaliseName(c.name) === normName && normaliseNum(c.number) === normTarget
    )
    if (exact) return exact
  }

  // 3. Exact name + set match (no number)
  if (normSet) {
    const byNameSet = cards.find(
      (c) =>
        normaliseName(c.name) === normName &&
        normaliseSetName(c.set).includes(normSet.split(' ')[0])
    )
    if (byNameSet) return byNameSet
  }

  // 4. Exact normalised name match (any number / set)
  const byName = cards.find((c) => normaliseName(c.name) === normName)
  if (byName) return byName

  // 5. Partial normalised name match
  const partial = cards.find((c) => {
    const cn = normaliseName(c.name)
    return cn.includes(normName) || normName.includes(cn)
  })
  if (partial) return partial

  // 6. Word-token subset match: all words in search name present in card name
  const queryTokens = normName.split(' ')
  const tokenMatch = cards.find((c) => {
    const cardTokens = normaliseName(c.name).split(' ')
    return queryTokens.every((t) => cardTokens.includes(t))
  })
  return tokenMatch ?? null
}

/**
 * Fetch the maximum available price history (180 days) from JustTCG.
 *
 * @param setName  Optional set name for disambiguation — passed as an extra
 *                 keyword in the search query and used to prefer the correct
 *                 card when multiple variants share the same name + number
 *                 (e.g. "Charizard VSTAR" exists in more than one set).
 */
export async function fetchJustTcgPriceHistory(
  cardName: string,
  cardNumber: string | null | undefined,
  setName: string | null | undefined,
  force = false,
  knownPrinting?: string | null,
): Promise<JustTcgFetchResult> {
  const apiKey = process.env.JUSTTCG_API_KEY
  if (!apiKey) return { points: [], keyword: cardName, apiError: false }

  const baseNum    = cardNumber ? cardNumber.split('/')[0] : null
  const setKeyword = setName ? normaliseSetName(setName).split(' ').slice(0, 2).join(' ') : null

  // Build primary query: name + number + set (maximally specific)
  const primaryQ = [cardName, baseNum, setKeyword].filter(Boolean).join(' ')
  // Fallback query: name + number only
  const fallbackQ = [cardName, baseNum].filter(Boolean).join(' ')

  const keyword = `${cardName}${cardNumber ? ` #${baseNum}` : ''}${setName ? ` (${setName})` : ''}`

  async function fetchCards(q: string): Promise<JustTcgCard[]> {
    const params = new URLSearchParams({
      q,
      include_price_history: 'true',
      priceHistoryDuration:  '180d',   // always fetch maximum available history
    })
    const res = await fetch(`https://api.justtcg.com/v1/cards?${params}`, {
      headers: { 'x-api-key': apiKey! },
      ...(force ? { cache: 'no-store' } : { next: { revalidate: 86_400 } }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    return json.data ?? []
  }

  try {
    // First attempt: specific query (name + number + set)
    let cards = await fetchCards(primaryQ)

    // If no match found with the specific query, retry without set name
    let match = findBestCard(cards, cardName, cardNumber, setName)
    if (!match && primaryQ !== fallbackQ) {
      cards = await fetchCards(fallbackQ)
      match = findBestCard(cards, cardName, cardNumber, setName)
    }

    if (!match) return { points: [], keyword, apiError: false }

    const variant = pickBestVariant(match.variants ?? [], knownPrinting)
    if (!variant || !variant.priceHistory?.length) return { points: [], keyword, apiError: false }

    const points: JustTcgPoint[] = variant.priceHistory
      .map((p: any) => ({
        date:  new Date((p.t ?? p.timestamp) * 1000).toISOString(),
        price: p.p ?? p.price,
      }))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

    return { points, keyword, apiError: false }
  } catch (err) {
    console.error('[JustTCG] Fetch error:', err instanceof Error ? err.message : String(err))
    return { points: [], keyword, apiError: true }
  }
}
