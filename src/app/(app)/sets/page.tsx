import Image from 'next/image'
import type { PokemonTcgSet } from '@/lib/pokemon/pokemonTcgApi'
import SetsGrid from './SetsGrid'

const BASE_URL = 'https://api.pokemontcg.io/v2'

function getHeaders(): Record<string, string> {
  const apiKey = process.env.POKEMON_TCG_API_KEY
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['X-Api-Key'] = apiKey
  return headers
}

async function fetchSets(): Promise<PokemonTcgSet[]> {
  try {
    const res = await fetch(`${BASE_URL}/sets?pageSize=250`, {
      headers: getHeaders(),
      next: { revalidate: 86400 },
    })
    if (!res.ok) return []
    const json = await res.json()
    const sets = (json.data ?? []) as PokemonTcgSet[]
    sets.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate))
    return sets
  } catch {
    return []
  }
}

export default async function SetsPage() {
  const sets = await fetchSets()
  const totalCards = sets.reduce((sum, s) => sum + s.total, 0)

  return (
    <div className="min-h-screen">
      <SetsGrid sets={sets} totalCards={totalCards} />
    </div>
  )
}
