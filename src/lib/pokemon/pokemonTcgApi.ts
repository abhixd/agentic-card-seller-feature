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

export function getBestTcgPlayerPrice(card: PokemonTcgCard): number | null {
  const prices = card.tcgplayer?.prices
  if (!prices) return null
  // Priority: holofoil > 1st edition holofoil > normal > reverseHolofoil
  const band =
    prices.holofoil ??
    prices['1stEditionHolofoil'] ??
    prices['1stEditionNormal'] ??
    prices.normal ??
    prices.reverseHolofoil ??
    prices.unlimitedHolofoil ??
    null
  return band?.market ?? band?.mid ?? null
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

export async function searchPokemonCards(query: string): Promise<PokemonTcgCard[]> {
  if (!query || query.trim().length < 2) return []

  const params = new URLSearchParams({
    q:        buildQuery(query),
    pageSize: String(PAGE_SIZE),
    page:     '1',
    orderBy:  '-set.releaseDate',  // newest sets first
  })

  try {
    const res = await fetch(`${BASE_URL}/cards?${params}`, {
      headers: getHeaders(),
      cache:   'no-store',
    })
    if (!res.ok) {
      console.error('[PokemonTCG] HTTP', res.status, await res.text().catch(() => ''))
      return []
    }
    const json = await res.json()
    return (json.data ?? []) as PokemonTcgCard[]
  } catch (err) {
    console.error('[PokemonTCG] Fetch error:', err)
    return []
  }
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
