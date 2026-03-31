import Image from 'next/image'
import Link from 'next/link'
import type { PokemonTcgSet } from '@/lib/pokemon/pokemonTcgApi'

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

function groupBySeries(sets: PokemonTcgSet[]): Map<string, PokemonTcgSet[]> {
  // Build map: series → sets
  const map = new Map<string, PokemonTcgSet[]>()
  for (const set of sets) {
    const arr = map.get(set.series) ?? []
    arr.push(set)
    map.set(set.series, arr)
  }
  // Sort series by max releaseDate descending
  const sorted = new Map(
    [...map.entries()].sort(([, a], [, b]) => {
      const maxA = a.reduce((m, s) => (s.releaseDate > m ? s.releaseDate : m), '')
      const maxB = b.reduce((m, s) => (s.releaseDate > m ? s.releaseDate : m), '')
      return maxB.localeCompare(maxA)
    })
  )
  return sorted
}

function releaseYear(date: string): string {
  return date.split('/')[0] ?? date
}

export default async function SetsPage() {
  const sets = await fetchSets()
  const grouped = groupBySeries(sets)
  const totalCards = sets.reduce((sum, s) => sum + s.total, 0)

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Browse by Set</h1>
        <p className="text-muted-foreground mt-1">
          {sets.length} sets · {totalCards.toLocaleString()}+ cards
        </p>
      </div>

      {/* Series groups */}
      {[...grouped.entries()].map(([series, seriesSets]) => (
        <section key={series} className="mb-10">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4 border-b pb-2">
            {series}
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {seriesSets.map((set) => (
              <Link
                key={set.id}
                href={`/sets/${set.id}`}
                className="group flex flex-col gap-2 rounded-lg border bg-card p-3 hover:border-primary/50 hover:shadow-md transition-all duration-150 hover:-translate-y-0.5"
              >
                {/* Set logo / symbol */}
                <div className="flex items-center justify-center h-14 bg-muted/30 rounded-md overflow-hidden">
                  {(set.images?.logo || set.images?.symbol) ? (
                    <Image
                      src={set.images.logo ?? set.images.symbol}
                      alt={set.name}
                      width={120}
                      height={48}
                      className="object-contain max-h-12"
                      unoptimized
                    />
                  ) : (
                    <span className="text-2xl">🃏</span>
                  )}
                </div>

                {/* Set info */}
                <div>
                  <p className="text-xs font-medium leading-tight line-clamp-2 group-hover:text-primary transition-colors">
                    {set.name}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {releaseYear(set.releaseDate)} · {set.printedTotal} cards
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ))}

      {sets.length === 0 && (
        <div className="text-center text-muted-foreground py-16">
          Unable to load sets. Please try again later.
        </div>
      )}
    </div>
  )
}
