// ---------------------------------------------------------------
// Pokemon TCG API client (pokemontcg.io v2)
// Docs: https://docs.pokemontcg.io
// Set POKEMON_TCG_API_KEY in .env.local for higher rate limits.
// Without a key: 1,000 req/day. With key: unlimited.
// ---------------------------------------------------------------

const BASE_URL = 'https://api.pokemontcg.io/v2'
const PAGE_SIZE = 250

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface PokemonTcgSet {
  id:           string
  name:         string
  series:       string
  releaseDate:  string   // "YYYY/MM/DD"
  printedTotal: number
  total:        number
  images: {
    symbol: string
    logo:   string
  }
}

export interface TcgPlayerPriceBand {
  low:       number | null
  mid:       number | null
  high:      number | null
  market:    number | null
  directLow: number | null
}

export interface TcgPlayerData {
  url:       string
  updatedAt: string
  prices: {
    normal?:               TcgPlayerPriceBand
    holofoil?:             TcgPlayerPriceBand
    reverseHolofoil?:      TcgPlayerPriceBand
    '1stEditionHolofoil'?: TcgPlayerPriceBand
    '1stEditionNormal'?:   TcgPlayerPriceBand
    unlimitedHolofoil?:    TcgPlayerPriceBand
  }
}

export interface CardMarketData {
  url:       string
  updatedAt: string
  prices: {
    averageSellPrice: number | null
    lowPrice:         number | null
    trendPrice:       number | null
    lowPriceExPlus:   number | null
    avg1:             number | null
    avg7:             number | null
    avg30:            number | null
  }
}

export interface PokemonAbility {
  name: string
  text: string
  type: string
}

export interface PokemonAttack {
  name:                 string
  cost:                 string[]
  convertedEnergyCost:  number
  damage:               string
  text:                 string
}

export interface PokemonWeakness {
  type:  string
  value: string
}

export interface PokemonTcgCard {
  id:                      string
  name:                    string
  supertype:               string
  subtypes:                string[]
  level:                   string | null
  hp:                      string | null
  types:                   string[]
  evolvesFrom:             string | null
  abilities:               PokemonAbility[]
  attacks:                 PokemonAttack[]
  weaknesses:              PokemonWeakness[]
  resistances:             PokemonWeakness[]
  retreatCost:             string[]
  convertedRetreatCost:    number
  number:                  string
  artist:                  string | null
  rarity:                  string | null
  flavorText:              string | null
  nationalPokedexNumbers:  number[]
  set:                     PokemonTcgSet
  images: {
    small: string
    large: string
  }
  tcgplayer:   TcgPlayerData   | null
  cardmarket:  CardMarketData  | null
}

// ---------------------------------------------------------------
// Get the best single market price from TCGPlayer for display
// ---------------------------------------------------------------

/**
 * Returns the best single TCGPlayer price for a card.
 * Scans ALL price bands and returns the highest market price found,
 * falling back to highest mid price. This ensures holo / 1st-edition
 * variants are never hidden by a cheaper band (e.g. normal) that happens
 * to appear first, and stale mid values don't mask a real market price
 * on another band.
 */
export function getBestTcgPlayerPrice(card: PokemonTcgCard): number | null {
  const prices = card.tcgplayer?.prices
  if (!prices) return null

  let bestMarket: number | null = null
  let bestMid:    number | null = null

  for (const band of Object.values(prices) as any[]) {
    const m   = typeof band?.market === 'number' && band.market > 0 ? band.market : null
    const mid = typeof band?.mid    === 'number' && band.mid    > 0 ? band.mid    : null
    if (m   != null && (bestMarket == null || m   > bestMarket)) bestMarket = m
    if (mid != null && (bestMid    == null || mid > bestMid))    bestMid    = mid
  }

  return bestMarket ?? bestMid ?? null
}

// ---------------------------------------------------------------
// Build the Lucene query for pokemontcg.io
// ---------------------------------------------------------------

function buildQuery(q: string): string {
  const term = q.trim().replace(/"/g, '\\"')
  if (/^\d+$/.test(term)) {
    return `number:${term}`
  }
  return `name:"*${term}*"`
}

// ---------------------------------------------------------------
// Search cards
// ---------------------------------------------------------------

function getHeaders(): Record<string, string> {
  const apiKey = process.env.POKEMON_TCG_API_KEY
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['X-Api-Key'] = apiKey
  return headers
}

// Hard cap on total cards fetched per search to avoid runaway API calls.
// Raised to 3,000 to capture long-tail promos (sorted last by -set.releaseDate):
// Pikachu Illustrator, Black Star Promos, vintage Wizards cards, etc.
// With PAGE_SIZE=250 this is at most 12 API requests — fast enough via after().
const MAX_CARDS_PER_SEARCH = 3000

export interface PokemonSearchResult {
  cards:      PokemonTcgCard[]
  totalCount: number   // total matching cards reported by the API
}

export async function searchPokemonCards(query: string): Promise<PokemonSearchResult> {
  if (!query || query.trim().length < 2) return { cards: [], totalCount: 0 }

  const headers    = getHeaders()
  const builtQuery = buildQuery(query)
  const allCards:  PokemonTcgCard[] = []

  let page       = 1
  let apiTotal   = Infinity  // updated after first response
  let reportedTotal = 0

  while (allCards.length < Math.min(apiTotal, MAX_CARDS_PER_SEARCH)) {
    const params = new URLSearchParams({
      q:        builtQuery,
      pageSize: String(PAGE_SIZE),
      page:     String(page),
      orderBy:  '-set.releaseDate',  // newest sets first
    })

    try {
      const res = await fetch(`${BASE_URL}/cards?${params}`, {
        headers,
        // Always fetch fresh — the catalog_sync_log table controls how often
        // we actually call the API (staleness gate is there, not here).
        // Using a cached response here would defeat the purpose of re-syncing.
        cache: 'no-store',
      })
      if (!res.ok) {
        console.error('[PokemonTCG] HTTP', res.status, await res.text().catch(() => ''))
        break
      }
      const json = await res.json()

      // The API reports the total count in `totalCount`
      if (page === 1) {
        reportedTotal = json.totalCount ?? json.data?.length ?? 0
        apiTotal      = reportedTotal
      }

      const pageCards = (json.data ?? []) as PokemonTcgCard[]
      allCards.push(...pageCards)

      // Stop if this was the last page
      if (pageCards.length < PAGE_SIZE) break
      page++
    } catch (err) {
      console.error('[PokemonTCG] Fetch error (page', page, '):', err)
      break
    }
  }

  return { cards: allCards, totalCount: reportedTotal }
}

// ---------------------------------------------------------------
// Fetch a single card by its Pokemon TCG id (e.g. "base1-4")
// ---------------------------------------------------------------

export async function getPokemonCard(pokemonTcgId: string): Promise<PokemonTcgCard | null> {
  try {
    const res = await fetch(`${BASE_URL}/cards/${encodeURIComponent(pokemonTcgId)}`, {
      headers: getHeaders(),
      cache:   'no-store',
    })
    if (!res.ok) return null
    const json = await res.json()
    return (json.data ?? null) as PokemonTcgCard | null
  } catch {
    return null
  }
}
