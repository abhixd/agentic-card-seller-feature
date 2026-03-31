'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useParams } from 'next/navigation'
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react'
import type { CardSearchResult } from '@/types/catalog'
import type { SalePoint } from '@/app/api/cards/sold-history/route'

// ── Types ──────────────────────────────────────────────────────────────────────

interface SetMeta {
  name: string
  series: string
  total: number
  logo?: string
  symbol?: string
  releaseDate?: string
}

interface CardGroup {
  key:          string
  primary:      CardSearchResult
  variants:     CardSearchResult[]
  isIllustRate: boolean
  displayNumber: number
}

// ── Sealed product definitions ────────────────────────────────────────────────

interface SealedProductDef {
  type: string
  packCount?: number
  icon: string
  gradient: string
}

const SEALED_PRODUCTS: SealedProductDef[] = [
  { type: 'Booster Box',           packCount: 36, icon: '📦', gradient: 'linear-gradient(135deg, #92400e 0%, #d97706 50%, #fbbf24 100%)' },
  { type: 'Elite Trainer Box',     packCount: 9,  icon: '🎁', gradient: 'linear-gradient(135deg, #4c1d95 0%, #7c3aed 50%, #a78bfa 100%)' },
  { type: 'Booster Bundle',        packCount: 6,  icon: '🗂️', gradient: 'linear-gradient(135deg, #1e3a5f 0%, #1d4ed8 50%, #60a5fa 100%)' },
  { type: 'Blister Pack',          packCount: 3,  icon: '🫧', gradient: 'linear-gradient(135deg, #064e3b 0%, #059669 50%, #34d399 100%)' },
  { type: 'Tin',                                  icon: '🥫', gradient: 'linear-gradient(135deg, #1e293b 0%, #475569 50%, #94a3b8 100%)' },
  { type: 'Collection Box',                       icon: '🗃️', gradient: 'linear-gradient(135deg, #7c2d12 0%, #ea580c 50%, #fb923c 100%)' },
  { type: 'Illustration Collection',              icon: '🎨', gradient: 'linear-gradient(135deg, #500724 0%, #be185d 50%, #f472b6 100%)' },
]

// ── Helpers ────────────────────────────────────────────────────────────────────

const IR_RARITIES = ['Illustration Rare', 'Special Illustration Rare', 'Hyper Rare', 'Shiny Ultra Rare', 'Shiny Rare']
function isIllustrationRare(rarity: string | null | undefined): boolean {
  return IR_RARITIES.some(r => rarity?.includes(r))
}

function parseCardNum(n: string | null | undefined): number {
  if (!n) return 9999
  const match = n.match(/^(\d+)/)
  return match ? parseInt(match[1], 10) : 9999
}

function getBestPrice(card: CardSearchResult): number | null {
  const tcg = card.metadata_json?.tcgplayer as Record<string, unknown> | null
  if (!tcg?.prices) return null
  const prices = tcg.prices as Record<string, { market?: number; mid?: number }>
  const bands = ['holofoil', '1stEditionHolofoil', 'reverseHolofoil', '1stEditionNormal', 'normal', 'doubleRare', 'ultraRare', 'illustrationRare', 'specialIllustrationRare', 'hyperRare']
  for (const b of bands) {
    const p = prices[b]
    if (p?.market) return p.market
    if (p?.mid)    return p.mid
  }
  const first = Object.values(prices)[0]
  return (first as any)?.market ?? (first as any)?.mid ?? null
}

function rarityShort(rarity: string | null | undefined): string {
  if (!rarity) return 'Common'
  const map: Record<string, string> = {
    'Common': 'C', 'Uncommon': 'UC', 'Rare': 'R',
    'Rare Holo': 'Holo', 'Rare Holo V': 'V', 'Rare Holo VMAX': 'VMAX',
    'Rare Holo VSTAR': 'VSTAR', 'Double Rare': '2R', 'Triple Star': '3R',
    'Illustration Rare': 'IR', 'Special Illustration Rare': 'SIR',
    'Hyper Rare': 'HR', 'Ultra Rare': 'UR', 'Secret Rare': 'SR',
    'Shiny Rare': 'SHR', 'Shiny Ultra Rare': 'STUR', 'Promo': 'Promo',
  }
  for (const [key, val] of Object.entries(map)) {
    if (rarity.includes(key)) return val
  }
  return rarity.slice(0, 4)
}

function rarityColor(rarity: string | null | undefined): string {
  if (!rarity) return 'text-white/30 border-white/10'
  if (rarity.includes('Special Illustration')) return 'text-violet-300 border-violet-400/40 bg-violet-400/10'
  if (rarity.includes('Illustration Rare'))    return 'text-pink-300 border-pink-400/40 bg-pink-400/10'
  if (rarity.includes('Hyper'))                return 'text-yellow-300 border-yellow-400/40 bg-yellow-400/10'
  if (rarity.includes('Secret'))               return 'text-amber-300 border-amber-400/40 bg-amber-400/10'
  if (rarity.includes('Ultra'))                return 'text-blue-300 border-blue-400/40 bg-blue-400/10'
  if (rarity.includes('VSTAR') || rarity.includes('VMAX') || rarity.includes('Holo V')) return 'text-sky-300 border-sky-400/40 bg-sky-400/10'
  if (rarity.includes('Holo'))                 return 'text-cyan-300 border-cyan-400/40 bg-cyan-400/10'
  if (rarity.includes('Double'))               return 'text-indigo-300 border-indigo-400/40 bg-indigo-400/10'
  if (rarity.includes('Rare'))                 return 'text-emerald-300 border-emerald-400/40 bg-emerald-400/10'
  return 'text-white/30 border-white/10 bg-white/5'
}

function groupCards(cards: CardSearchResult[]): CardGroup[] {
  const irCards: CardSearchResult[]  = []
  const stdCards: CardSearchResult[] = []
  for (const c of cards) {
    const rarity = c.metadata_json?.rarity as string | null
    if (isIllustrationRare(rarity)) irCards.push(c)
    else stdCards.push(c)
  }

  const groups = new Map<string, CardSearchResult[]>()
  for (const c of stdCards) {
    const key = c.card_name.toLowerCase().trim()
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(c)
  }

  const result: CardGroup[] = []

  for (const [, members] of groups) {
    const sorted = [...members].sort((a, b) => parseCardNum(a.card_number) - parseCardNum(b.card_number))
    result.push({
      key:           sorted[0].catalog_id,
      primary:       sorted[0],
      variants:      sorted.slice(1),
      isIllustRate:  false,
      displayNumber: parseCardNum(sorted[0].card_number),
    })
  }

  for (const c of irCards) {
    result.push({
      key:           c.catalog_id,
      primary:       c,
      variants:      [],
      isIllustRate:  true,
      displayNumber: parseCardNum(c.card_number),
    })
  }

  result.sort((a, b) => a.displayNumber - b.displayNumber)
  return result
}

// ── Card Tile ──────────────────────────────────────────────────────────────────

function CardTile({ group }: { group: CardGroup }) {
  const [varIdx, setVarIdx] = useState(0)
  const allVariants = [group.primary, ...group.variants]
  const current     = allVariants[varIdx]
  const rarity      = current.metadata_json?.rarity as string | null
  const price       = getBestPrice(current)
  const hasMultiple = allVariants.length > 1

  return (
    <Link
      href={`/analyze/${current.catalog_id}?q=${encodeURIComponent(current.set_name ?? '')}`}
      className="group flex flex-col rounded-xl border border-white/8 bg-white/3 hover:border-white/20 hover:bg-white/6 transition-all duration-150 overflow-hidden"
      onClick={(e) => {
        const target = e.target as HTMLElement
        if (target.closest('[data-variant-btn]')) e.preventDefault()
      }}
    >
      <div className="relative aspect-[2.5/3.5] overflow-hidden bg-white/5">
        {current.canonical_image_url ? (
          <Image
            src={current.canonical_image_url}
            alt={current.card_name}
            fill
            className="object-cover group-hover:scale-105 transition-transform duration-300"
            unoptimized
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-3xl opacity-20">🃏</div>
        )}
        {rarity && (
          <div className={`absolute top-1.5 right-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-md border ${rarityColor(rarity)}`}>
            {rarityShort(rarity)}
          </div>
        )}
        {group.isIllustRate && (
          <div className="absolute inset-0 ring-1 ring-inset ring-violet-400/20 rounded-xl pointer-events-none" />
        )}
      </div>

      <div className="p-2 flex flex-col gap-1 flex-1">
        <div>
          <p className="text-[11px] font-semibold leading-tight text-white/85 line-clamp-2 group-hover:text-white transition-colors">
            {current.card_name}
          </p>
          <p className="text-[10px] text-white/35 mt-0.5">
            #{current.card_number ?? '—'}
          </p>
        </div>

        {price != null && (
          <p className="text-[12px] font-bold tabular-nums" style={{ color: '#34d399' }}>
            ${price.toFixed(2)}
          </p>
        )}

        {hasMultiple && (
          <div data-variant-btn className="flex items-center gap-1 mt-auto pt-1">
            <button
              data-variant-btn
              onClick={() => setVarIdx(i => Math.max(0, i - 1))}
              disabled={varIdx === 0}
              className="p-0.5 rounded hover:bg-white/10 disabled:opacity-20 transition-opacity"
            >
              <ChevronLeft className="h-3 w-3 text-white/50" />
            </button>
            <span className="text-[9px] text-white/30 flex-1 text-center">
              {varIdx + 1}/{allVariants.length}
            </span>
            <button
              data-variant-btn
              onClick={() => setVarIdx(i => Math.min(allVariants.length - 1, i + 1))}
              disabled={varIdx === allVariants.length - 1}
              className="p-0.5 rounded hover:bg-white/10 disabled:opacity-20 transition-opacity"
            >
              <ChevronRight className="h-3 w-3 text-white/50" />
            </button>
          </div>
        )}
      </div>
    </Link>
  )
}

// ── Sealed Product Card ────────────────────────────────────────────────────────

interface SealedPriceData {
  avgPrice: number | null
  soldCount: number
  keyword: string
}

function SealedProductCard({ product, setName, setLogo }: { product: SealedProductDef; setName: string; setLogo?: string }) {
  const [data,    setData]    = useState<SealedPriceData | null>(null)
  const [loading, setLoading] = useState(true)

  const keyword = `${setName} ${product.type} pokemon`

  useEffect(() => {
    setLoading(true)
    setData(null)
    fetch(`/api/cards/sold-history?keyword=${encodeURIComponent(keyword)}&lang=en`)
      .then(r => r.json())
      .then((json: { points?: SalePoint[]; total?: number }) => {
        const points = (json.points ?? []) as SalePoint[]
        const recent = points.slice(-5)
        const avg = recent.length > 0
          ? recent.reduce((sum, p) => sum + p.price, 0) / recent.length
          : null
        setData({ avgPrice: avg, soldCount: points.length, keyword })
        setLoading(false)
      })
      .catch(() => {
        setData({ avgPrice: null, soldCount: 0, keyword })
        setLoading(false)
      })
  }, [keyword])

  const ebayUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(keyword)}&LH_Complete=1&LH_Sold=1`

  return (
    <div
      className="rounded-xl border border-white/8 overflow-hidden transition-all duration-200 hover:border-white/15"
      style={{
        background: 'linear-gradient(145deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))',
        backdropFilter: 'blur(12px)',
      }}
    >
      {/* Visual product art header */}
      <div
        className="relative h-32 w-full overflow-hidden flex flex-col items-center justify-center gap-1"
        style={{ background: product.gradient }}
      >
        {/* Diagonal stripe overlay */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-10"
          style={{
            backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.6) 0px, rgba(255,255,255,0.6) 1px, transparent 1px, transparent 12px)',
          }}
        />

        {/* Pack count badge — top right */}
        {product.packCount != null && (
          <div
            className="absolute top-2 right-2 text-[9px] font-bold px-1.5 py-0.5 rounded-full"
            style={{ background: 'rgba(0,0,0,0.4)', color: 'rgba(255,255,255,0.85)', border: '1px solid rgba(255,255,255,0.2)' }}
          >
            {product.packCount} packs
          </div>
        )}

        {/* Set logo */}
        {setLogo ? (
          <div className="relative z-10 flex items-center justify-center" style={{ width: '40%', maxHeight: '48px' }}>
            <Image
              src={setLogo}
              alt={setName}
              width={120}
              height={48}
              className="object-contain drop-shadow-lg"
              style={{ filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.5)) brightness(1.1)' }}
              unoptimized
            />
          </div>
        ) : (
          <span className="relative z-10 text-3xl drop-shadow-lg">{product.icon}</span>
        )}

        {/* Product type label */}
        <p
          className="relative z-10 text-[10px] font-black uppercase tracking-widest"
          style={{ color: 'rgba(255,255,255,0.75)', textShadow: '0 1px 4px rgba(0,0,0,0.6)' }}
        >
          {product.type}
        </p>
      </div>

      {/* Product info row */}
      <div className="px-4 pt-3 pb-1 flex items-center justify-between">
        <p className="text-xs font-semibold text-white/70">{product.type}</p>
        {product.packCount != null && (
          <p className="text-[10px] text-white/35">{product.packCount} packs</p>
        )}
      </div>

      {/* eBay price section */}
      <div
        className="mx-4 mb-4 rounded-lg p-3"
        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
      >
        <p className="text-[10px] font-semibold uppercase tracking-wider text-white/30 mb-2">eBay Sold (90d)</p>

        {loading ? (
          <div className="space-y-1.5">
            <div className="h-5 w-24 rounded bg-white/8 animate-pulse" />
            <div className="h-3 w-16 rounded bg-white/5 animate-pulse" />
          </div>
        ) : (
          <div className="flex items-end justify-between gap-2">
            <div>
              {data?.avgPrice != null ? (
                <>
                  <p className="text-xl font-black tabular-nums" style={{ color: '#34d399' }}>
                    ${data.avgPrice.toFixed(2)}
                  </p>
                  <p className="text-[10px] text-white/30 mt-0.5">
                    avg of last 5 · {data.soldCount} sold
                  </p>
                </>
              ) : (
                <p className="text-sm text-white/25">No recent sales</p>
              )}
            </div>

            <a
              href={ebayUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-shrink-0 text-[10px] font-semibold px-2.5 py-1.5 rounded-lg transition-all duration-150 hover:opacity-90"
              style={{
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: 'rgba(255,255,255,0.6)',
              }}
            >
              View on eBay ↗
            </a>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Sealed Panel ───────────────────────────────────────────────────────────────

function SealedPanel({ setName, setLogo }: { setName: string; setLogo?: string }) {
  return (
    <div>
      <div className="mb-5">
        <p className="text-sm text-white/40">
          eBay completed sale prices for <span className="text-white/70 font-medium">{setName}</span> sealed products.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {SEALED_PRODUCTS.map(p => (
          <SealedProductCard key={p.type} product={p} setName={setName} setLogo={setLogo} />
        ))}
      </div>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

type ViewMode = 'cards' | 'sealed'

export default function SetDetailPage() {
  const params = useParams()
  const setId  = params.setId as string

  const [cards,    setCards]    = useState<CardSearchResult[]>([])
  const [setMeta,  setSetMeta]  = useState<SetMeta | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [filter,   setFilter]   = useState<string>('All')
  const [viewMode, setViewMode] = useState<ViewMode>('cards')

  useEffect(() => {
    if (!setId) return
    setLoading(true)
    fetch(`/api/catalog/sets/${setId}`)
      .then(r => r.json())
      .then(data => {
        setCards(data.cards ?? [])
        if (data.setMeta) setSetMeta(data.setMeta)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [setId])

  const rarities = useMemo(() => {
    const seen = new Set<string>()
    for (const c of cards) {
      const r = c.metadata_json?.rarity as string | null
      if (r) seen.add(r)
    }
    const ORDER = ['Common','Uncommon','Rare','Rare Holo','Double Rare','Ultra Rare','Illustration Rare','Special Illustration Rare','Hyper Rare','Secret Rare','Promo']
    return ['All', ...[...seen].sort((a, b) => {
      const ai = ORDER.findIndex(o => a.includes(o))
      const bi = ORDER.findIndex(o => b.includes(o))
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    })]
  }, [cards])

  const filteredCards = useMemo(() => {
    if (filter === 'All') return cards
    return cards.filter(c => {
      const r = c.metadata_json?.rarity as string | null
      return r === filter
    })
  }, [cards, filter])

  const groups = useMemo(() => groupCards(filteredCards), [filteredCards])

  const setName = setMeta?.name ?? cards[0]?.set_name ?? setId

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">

        {/* Back link */}
        <Link href="/sets" className="inline-flex items-center gap-1.5 text-sm text-white/40 hover:text-white/70 mb-6 transition-colors">
          <ArrowLeft className="h-4 w-4" />
          Browse Sets
        </Link>

        {/* Set header */}
        <div className="flex items-start gap-4 mb-8">
          {setMeta?.logo && (
            <div className="flex-shrink-0">
              <Image src={setMeta.logo} alt={setName} width={120} height={48} className="object-contain" unoptimized />
            </div>
          )}
          <div>
            <h1 className="text-2xl font-bold text-white">{setName}</h1>
            <div className="flex items-center gap-3 mt-1.5 text-sm text-white/40">
              {setMeta?.series && <span>{setMeta.series}</span>}
              {setMeta?.releaseDate && <><span className="text-white/20">·</span><span>{setMeta.releaseDate}</span></>}
              <span className="text-white/20">·</span>
              <span>{loading ? '…' : `${groups.length} cards`}</span>
              {viewMode === 'cards' && filter !== 'All' && (
                <><span className="text-white/20">·</span><span className="text-white/60">{filter}</span></>
              )}
            </div>
          </div>
        </div>

        {/* Filter chips + Sealed pill */}
        {!loading && (
          <div className="flex items-center gap-1.5 flex-wrap mb-6">
            {/* Rarity chips — only show when in card mode */}
            {viewMode === 'cards' && rarities.length > 1 && rarities.map(r => (
              <button
                key={r}
                onClick={() => setFilter(r)}
                className={[
                  'text-[11px] px-3 py-1.5 rounded-full font-medium transition-all border',
                  filter === r
                    ? r === 'All'
                      ? 'bg-white text-black border-white'
                      : `border-white/20 ${rarityColor(r).split(' ')[0]}`
                    : 'text-white/40 border-white/10 hover:text-white/70 hover:border-white/20',
                ].join(' ')}
                style={
                  filter === r && r !== 'All'
                    ? { backgroundColor: 'rgba(255,255,255,0.08)', borderColor: 'rgba(255,255,255,0.2)' }
                    : {}
                }
              >
                {r === 'All' ? `All (${cards.length})` : r}
              </button>
            ))}

            {/* Spacer when in sealed mode */}
            {viewMode === 'sealed' && <div className="flex-1" />}

            {/* Sealed pill button */}
            <button
              onClick={() => setViewMode(v => v === 'sealed' ? 'cards' : 'sealed')}
              className="ml-auto text-[11px] px-3 py-1.5 rounded-full font-medium transition-all border"
              style={
                viewMode === 'sealed'
                  ? {
                      background: 'rgba(251,191,36,0.15)',
                      borderColor: 'rgba(251,191,36,0.5)',
                      color: '#fbbf24',
                      boxShadow: '0 0 10px rgba(251,191,36,0.2)',
                    }
                  : {
                      background: 'transparent',
                      borderColor: 'rgba(255,255,255,0.12)',
                      color: 'rgba(255,255,255,0.45)',
                    }
              }
            >
              📦 Sealed
            </button>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {Array.from({ length: 18 }).map((_, i) => (
              <div key={i} className="aspect-[2.5/3.5] rounded-xl bg-white/5 animate-pulse" />
            ))}
          </div>
        )}

        {/* Sealed products panel */}
        {!loading && viewMode === 'sealed' && (
          <SealedPanel setName={setName} setLogo={setMeta?.logo} />
        )}

        {/* Cards grid */}
        {!loading && viewMode === 'cards' && groups.length === 0 && (
          <div className="text-center text-white/30 py-20">
            No cards found for this filter.
          </div>
        )}

        {!loading && viewMode === 'cards' && groups.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {groups.map(g => <CardTile key={g.key} group={g} />)}
          </div>
        )}
      </div>
    </div>
  )
}
