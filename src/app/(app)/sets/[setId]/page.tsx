import Link from 'next/link'
import Image from 'next/image'
import type { CardSearchResult } from '@/types/catalog'

interface SetPageProps {
  params: Promise<{ setId: string }>
}

async function fetchSetCards(setId: string): Promise<{
  cards: CardSearchResult[]
  total: number
}> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
    const res = await fetch(`${baseUrl}/api/catalog/sets/${setId}`, {
      next: { revalidate: 3600 },
    })
    if (!res.ok) return { cards: [], total: 0 }
    return await res.json()
  } catch {
    return { cards: [], total: 0 }
  }
}

function getSetName(cards: CardSearchResult[]): string {
  return cards[0]?.set_name ?? 'Unknown Set'
}

function getBestPrice(card: CardSearchResult): number | null {
  const tcg = card.metadata_json?.tcgplayer as Record<string, unknown> | null
  if (!tcg?.prices) return null
  const prices = tcg.prices as Record<string, { market?: number; mid?: number }>
  const bands = ['holofoil', '1stEditionHolofoil', '1stEditionNormal', 'normal', 'reverseHolofoil']
  for (const band of bands) {
    const p = prices[band]
    if (p?.market) return p.market
    if (p?.mid) return p.mid
  }
  return null
}

export default async function SetDetailPage({ params }: SetPageProps) {
  const { setId } = await params
  const { cards, total } = await fetchSetCards(setId)
  const setName = getSetName(cards)

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Back link */}
      <Link
        href="/sets"
        className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mb-6"
      >
        ← Back to Sets
      </Link>

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{setName}</h1>
        <p className="text-muted-foreground mt-1">{total} cards</p>
      </div>

      {/* Cards grid */}
      {cards.length === 0 ? (
        <div className="text-center text-muted-foreground py-16">
          No cards found for this set.
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {cards.map((card) => {
            const price = getBestPrice(card)
            return (
              <Link
                key={card.catalog_id}
                href={`/analyze/${card.catalog_id}?q=${encodeURIComponent(setId)}`}
                className="group flex flex-col gap-1.5 rounded-lg border bg-card p-2 hover:border-primary/50 hover:shadow-md transition-all duration-150 hover:-translate-y-0.5"
              >
                {/* Card image */}
                <div className="aspect-[2.5/3.5] relative bg-muted/30 rounded-md overflow-hidden">
                  {card.canonical_image_url ? (
                    <Image
                      src={card.canonical_image_url}
                      alt={card.card_name}
                      fill
                      className="object-cover"
                      unoptimized
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-2xl">🃏</div>
                  )}
                </div>

                {/* Card info */}
                <div>
                  <p className="text-xs font-medium leading-tight line-clamp-2 group-hover:text-primary transition-colors">
                    {card.card_name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    #{card.card_number}
                    {card.variant ? ` · ${card.variant}` : ''}
                  </p>
                  {price != null && (
                    <p className="text-xs font-semibold text-green-500 mt-0.5">
                      ${price.toFixed(2)}
                    </p>
                  )}
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
