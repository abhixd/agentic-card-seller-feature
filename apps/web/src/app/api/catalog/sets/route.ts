import type { PokemonTcgSet } from '@/lib/pokemon/pokemonTcgApi'

const BASE_URL = 'https://api.pokemontcg.io/v2'

function getHeaders(): Record<string, string> {
  const apiKey = process.env.POKEMON_TCG_API_KEY
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['X-Api-Key'] = apiKey
  return headers
}

export async function GET() {
  try {
    const res = await fetch(`${BASE_URL}/sets?pageSize=250`, {
      headers: getHeaders(),
      next: { revalidate: 86400 },
    })
    if (!res.ok) {
      return Response.json({ error: 'Failed to fetch sets' }, { status: 502 })
    }
    const json = await res.json()
    const sets = (json.data ?? []) as PokemonTcgSet[]

    // Sort by releaseDate descending
    sets.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate))

    return Response.json({ sets })
  } catch (err) {
    console.error('[catalog/sets] Error:', err)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
