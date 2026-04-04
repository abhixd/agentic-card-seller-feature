'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import {
  ShoppingBag, Plus, Search, Loader2, Star, Flame, TrendingUp, TrendingDown,
  ChevronDown, X, SlidersHorizontal,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CatalogItem {
  catalog_id:          string
  card_name:           string
  set_name:            string
  card_number:         string | null
  canonical_image_url: string | null
  metadata_json:       Record<string, unknown>
}

interface Listing {
  id:              number
  seller_id:       string
  catalog_id:      string
  title:           string
  condition:       string
  grade:           string | null
  asking_price:    number
  ai_market_price: number | null
  price_delta_pct: number | null
  description:     string | null
  image_urls:      string[]
  accepts_trades:  boolean
  status:          string
  created_at:      string
  seller_username: string
  card_catalog_items: CatalogItem
}

interface WantlistItem {
  card_catalog_items: { catalog_id: string }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtUsd(n: number) {
  return n >= 1000 ? `$${(n / 1000).toFixed(2)}k` : `$${n.toFixed(2)}`
}

function dealScore(delta: number | null): number {
  if (delta === null) return 50
  return Math.max(0, Math.min(100, 50 - delta))
}

function conditionColor(condition: string): string {
  if (condition === 'NM')                return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25'
  if (condition === 'LP')                return 'bg-yellow-500/15 text-yellow-400 border-yellow-500/25'
  if (condition === 'MP')                return 'bg-orange-500/15 text-orange-400 border-orange-500/25'
  if (condition === 'HP' || condition === 'D') return 'bg-red-500/15 text-red-400 border-red-500/25'
  // Graded
  return 'bg-blue-500/15 text-blue-400 border-blue-500/25'
}

// ── Sort options ──────────────────────────────────────────────────────────────

const SORT_OPTIONS = [
  { value: 'newest',     label: 'Newest' },
  { value: 'price_asc',  label: 'Price: Low → High' },
  { value: 'price_desc', label: 'Price: High → Low' },
  { value: 'deal',       label: 'Best Deal' },
]

const CONDITION_CHIPS = ['All', 'NM', 'LP', 'MP', 'HP', 'Graded'] as const

// ── Listing Card ──────────────────────────────────────────────────────────────

function ListingCard({ listing, isWanted }: { listing: Listing; isWanted: boolean }) {
  const card    = listing.card_catalog_items
  const delta   = listing.price_delta_pct
  const score   = dealScore(delta)
  const isHot   = delta !== null && delta < -20
  const isDeal  = delta !== null && delta < -5
  const isHigh  = delta !== null && delta > 20
  const imgSrc  = listing.image_urls[0] ?? card.canonical_image_url

  return (
    <Link href={`/marketplace/${listing.id}`} className="card-lift block">
      <div className="rounded-2xl border border-white/8 bg-white/[0.025] overflow-hidden hover:border-white/15 transition-colors">
        {/* Card image */}
        <div className="relative aspect-[3/4] bg-white/[0.03] overflow-hidden">
          {imgSrc ? (
            <Image
              src={imgSrc}
              alt={card.card_name}
              fill
              className="object-contain p-2"
              unoptimized
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <div
                style={{
                  width: 60, height: 84, borderRadius: 8,
                  background: 'radial-gradient(circle at 30% 30%, #6366f1 0%, #4f46e5 40%, #2e1065 100%)',
                  border: '1px solid rgba(99,102,241,0.35)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <span style={{ fontSize: 24, fontWeight: 700, color: 'rgba(255,255,255,0.9)' }}>
                  {card.card_name.charAt(0)}
                </span>
              </div>
            </div>
          )}

          {/* HOT DEAL badge */}
          {isHot && (
            <div className="absolute top-2 left-2 flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[10px] font-bold">
              <Flame className="h-3 w-3" />
              HOT DEAL
            </div>
          )}

          {/* Wantlist badge */}
          {isWanted && (
            <div className="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-500/20 border border-rose-500/35 text-rose-300 text-[10px] font-semibold">
              <Star className="h-2.5 w-2.5 fill-current" />
              Wanted
            </div>
          )}
        </div>

        {/* Info */}
        <div className="p-3 space-y-2">
          <div>
            <p className="text-xs font-semibold text-white/85 truncate leading-tight">{card.card_name}</p>
            <p className="text-[10px] text-white/30 truncate">{card.set_name}</p>
          </div>

          {/* Condition badge */}
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-semibold ${conditionColor(listing.condition)}`}>
            {listing.grade ?? listing.condition}
          </span>

          {/* Price row */}
          <div className="flex items-end justify-between gap-2">
            <p className="text-base font-bold tabular-nums text-white/90">{fmtUsd(listing.asking_price)}</p>

            {/* Market delta */}
            {delta !== null && Math.abs(delta) > 5 && (
              <span className={`flex items-center gap-0.5 text-[10px] font-semibold tabular-nums shrink-0 ${
                isDeal ? 'text-emerald-400' : isHigh ? 'text-red-400' : 'text-yellow-400'
              }`}>
                {isDeal
                  ? <><TrendingDown className="h-3 w-3" />{Math.abs(delta).toFixed(0)}% DEAL</>
                  : <><TrendingUp className="h-3 w-3" />+{delta.toFixed(0)}% mkt</>
                }
              </span>
            )}
          </div>

          {/* Seller + trade */}
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-white/25 truncate">{listing.seller_username}</p>
            {listing.accepts_trades && (
              <span className="text-[9px] text-indigo-400/60 font-medium">Trades OK</span>
            )}
          </div>
        </div>
      </div>
    </Link>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MarketplacePage() {
  const [listings,     setListings]     = useState<Listing[]>([])
  const [total,        setTotal]        = useState(0)
  const [loading,      setLoading]      = useState(true)
  const [wantCatalogIds, setWantCatalogIds] = useState<Set<string>>(new Set())

  const [q,         setQ]         = useState('')
  const [condition, setCondition] = useState<string>('All')
  const [sort,      setSort]      = useState('newest')
  const [minPrice,  setMinPrice]  = useState('')
  const [maxPrice,  setMaxPrice]  = useState('')
  const [showFilters, setShowFilters] = useState(false)

  // Load wantlist catalog IDs for matching
  useEffect(() => {
    fetch('/api/wantlist')
      .then(r => r.json())
      .then(d => {
        const ids = new Set<string>(
          (d.items ?? []).map((i: WantlistItem) => i.card_catalog_items.catalog_id)
        )
        setWantCatalogIds(ids)
      })
      .catch(() => {})
  }, [])

  const fetchListings = useCallback(async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams({ sort })
      if (q)         p.set('q', q)
      if (condition !== 'All') p.set('condition', condition)
      if (minPrice)  p.set('minPrice', minPrice)
      if (maxPrice)  p.set('maxPrice', maxPrice)

      const res  = await fetch(`/api/marketplace/listings?${p}`)
      const data = await res.json()
      setListings(data.listings ?? [])
      setTotal(data.total ?? 0)
    } finally {
      setLoading(false)
    }
  }, [q, condition, sort, minPrice, maxPrice])

  useEffect(() => {
    const t = setTimeout(fetchListings, q ? 350 : 0)
    return () => clearTimeout(t)
  }, [fetchListings, q])

  const wantlistMatches = listings.filter(l => wantCatalogIds.has(l.catalog_id))

  return (
    <div className="max-w-4xl mx-auto space-y-5 pb-12">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <ShoppingBag className="h-5 w-5 text-indigo-400" />
            Marketplace
          </h1>
          <p className="text-xs text-white/30 mt-1">
            {total > 0 ? `${total} active listing${total !== 1 ? 's' : ''}` : 'Browse cards for sale'}
          </p>
        </div>
        <Link
          href="/marketplace/new"
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all btn-primary-glow"
          style={{ background: 'linear-gradient(135deg, #6366f1, #4338ca)' }}
        >
          <Plus className="h-4 w-4" />
          List a Card
        </Link>
      </div>

      {/* Wantlist match banner */}
      {wantlistMatches.length > 0 && (
        <div className="rounded-xl border border-rose-500/25 bg-rose-500/8 px-4 py-3 flex items-center gap-3">
          <Star className="h-4 w-4 text-rose-400 shrink-0 fill-current" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-rose-300">
              {wantlistMatches.length} card{wantlistMatches.length !== 1 ? 's' : ''} from your wantlist {wantlistMatches.length !== 1 ? 'are' : 'is'} available
            </p>
            <p className="text-[11px] text-rose-400/60 mt-0.5 truncate">
              {wantlistMatches.map(l => l.card_catalog_items.card_name).slice(0, 3).join(', ')}
              {wantlistMatches.length > 3 ? ` +${wantlistMatches.length - 3} more` : ''}
            </p>
          </div>
        </div>
      )}

      {/* Search + filter bar */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-white/25" />
            <input
              type="text"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search listings…"
              className="w-full rounded-xl border border-white/10 bg-white/[0.04] pl-8 pr-4 py-2.5 text-sm text-white/80 placeholder:text-white/25 focus:outline-none focus:border-white/20 transition-all"
            />
            {q && (
              <button onClick={() => setQ('')} className="absolute right-3 top-1/2 -translate-y-1/2">
                <X className="h-3.5 w-3.5 text-white/25 hover:text-white/60 transition-colors" />
              </button>
            )}
          </div>

          {/* Sort dropdown */}
          <div className="relative">
            <select
              value={sort}
              onChange={e => setSort(e.target.value)}
              className="appearance-none rounded-xl border border-white/10 bg-white/[0.04] pl-3 pr-8 py-2.5 text-sm text-white/70 focus:outline-none cursor-pointer"
            >
              {SORT_OPTIONS.map(o => (
                <option key={o.value} value={o.value} style={{ background: '#0d1117' }}>
                  {o.label}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-white/30 pointer-events-none" />
          </div>

          {/* Filters toggle */}
          <button
            onClick={() => setShowFilters(f => !f)}
            className={`flex items-center gap-1.5 px-3 py-2.5 rounded-xl border text-sm font-medium transition-colors ${
              showFilters
                ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
                : 'border-white/10 bg-white/[0.04] text-white/50 hover:text-white/70'
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Condition chips */}
        <div className="flex items-center gap-2 flex-wrap">
          {CONDITION_CHIPS.map(c => (
            <button
              key={c}
              onClick={() => setCondition(c)}
              className={`px-3 py-1 rounded-full text-xs font-semibold border transition-all ${
                condition === c
                  ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-300'
                  : 'border-white/10 bg-white/[0.03] text-white/40 hover:text-white/60'
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        {/* Price range filters */}
        {showFilters && (
          <div className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.02] p-3">
            <p className="text-xs text-white/30 font-medium shrink-0">Price range</p>
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 text-xs">$</span>
              <input
                type="number"
                min="0"
                value={minPrice}
                onChange={e => setMinPrice(e.target.value)}
                placeholder="Min"
                className="w-full rounded-lg border border-white/10 bg-white/[0.04] pl-6 pr-3 py-1.5 text-xs text-white/70 placeholder:text-white/25 focus:outline-none"
              />
            </div>
            <span className="text-white/20 text-xs">—</span>
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 text-xs">$</span>
              <input
                type="number"
                min="0"
                value={maxPrice}
                onChange={e => setMaxPrice(e.target.value)}
                placeholder="Max"
                className="w-full rounded-lg border border-white/10 bg-white/[0.04] pl-6 pr-3 py-1.5 text-xs text-white/70 placeholder:text-white/25 focus:outline-none"
              />
            </div>
            {(minPrice || maxPrice) && (
              <button
                onClick={() => { setMinPrice(''); setMaxPrice('') }}
                className="text-white/25 hover:text-white/60 transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Loading skeletons */}
      {loading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-white/5 bg-white/[0.02] animate-pulse">
              <div className="aspect-[3/4] bg-white/[0.03] rounded-t-2xl" />
              <div className="p-3 space-y-2">
                <div className="h-3 bg-white/5 rounded-full w-3/4" />
                <div className="h-2.5 bg-white/4 rounded-full w-1/2" />
                <div className="h-4 bg-white/5 rounded-full w-1/3" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && listings.length === 0 && (
        <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-12 text-center space-y-3">
          <ShoppingBag className="h-8 w-8 text-indigo-400/30 mx-auto" />
          <p className="text-sm font-medium text-white/40">No listings yet</p>
          <p className="text-xs text-white/20">Be the first to list a card for sale or trade.</p>
          <Link
            href="/marketplace/new"
            className="inline-flex items-center gap-2 mt-2 px-4 py-2 rounded-xl text-sm font-semibold text-white"
            style={{ background: 'linear-gradient(135deg, #6366f1, #4338ca)' }}
          >
            <Plus className="h-4 w-4" />
            List a Card
          </Link>
        </div>
      )}

      {/* Grid */}
      {!loading && listings.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {listings.map(listing => (
            <ListingCard
              key={listing.id}
              listing={listing}
              isWanted={wantCatalogIds.has(listing.catalog_id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
