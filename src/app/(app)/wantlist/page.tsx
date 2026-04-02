'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import {
  Heart, Search, X, Loader2, Plus, Trash2,
  TrendingUp, TrendingDown, Minus, AlertCircle, ExternalLink,
} from 'lucide-react'
import { Sparkline } from '@/components/ui/Sparkline'

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractTcgPrice(meta: any): number | null {
  const prices = meta?.tcgplayer?.prices
  if (!prices) return null
  const BANDS = ['holofoil','1stEditionHolofoil','reverseHolofoil','normal','unlimitedHolofoil','1stEditionNormal']
  for (const band of BANDS) {
    const p = prices[band]
    if (p?.market && p.market > 0) return p.market
    if (p?.mid   && p.mid   > 0) return p.mid
  }
  for (const b of Object.values(prices) as any[]) {
    if (b?.market && b.market > 0) return b.market
  }
  return null
}

function extractSparklinePoints(meta: any): number[] {
  const pts: { date: string; price: number }[] = meta?.tcg_history?.points ?? []
  return pts.slice(-30).map(p => p.price)
}

function fmtUsd(n: number) {
  return n >= 1000 ? `$${(n / 1000).toFixed(2)}k` : `$${n.toFixed(2)}`
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface WantlistItem {
  id:           string
  target_price: number | null
  notes:        string | null
  created_at:   string
  card_catalog_items: {
    catalog_id:          string
    card_name:           string
    set_name:            string
    card_number:         string | null
    canonical_image_url: string | null
    metadata_json:       any
  }
}

// ── Search result type ────────────────────────────────────────────────────────

interface SearchResult {
  catalog_id:          string
  card_name:           string
  set_name:            string
  card_number:         string | null
  canonical_image_url: string | null
  metadata_json:       any
}

// ── Add Card Modal ────────────────────────────────────────────────────────────

function AddCardModal({ onAdd, onClose }: {
  onAdd: (catalogId: string, targetPrice: number | null) => Promise<void>
  onClose: () => void
}) {
  const [query,       setQuery]       = useState('')
  const [results,     setResults]     = useState<SearchResult[]>([])
  const [searching,   setSearching]   = useState(false)
  const [selected,    setSelected]    = useState<SearchResult | null>(null)
  const [targetPrice, setTargetPrice] = useState('')
  const [adding,      setAdding]      = useState(false)

  useEffect(() => {
    if (query.length < 2) { setResults([]); return }
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`/api/catalog/search?q=${encodeURIComponent(query)}&limit=8`)
        const data = await res.json()
        setResults(data.results ?? [])
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [query])

  const handleAdd = async () => {
    if (!selected) return
    setAdding(true)
    const tp = targetPrice ? parseFloat(targetPrice) : null
    await onAdd(selected.catalog_id, tp)
    setAdding(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative w-full max-w-md rounded-2xl border border-white/10 overflow-hidden"
        style={{ background: '#0d1117' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.07]">
          <div className="flex items-center gap-2">
            <Heart className="h-4 w-4 text-rose-400" />
            <span className="text-sm font-semibold text-white/80">Add to Wantlist</span>
          </div>
          <button onClick={onClose}>
            <X className="h-4 w-4 text-white/30 hover:text-white/70 transition-colors" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {/* Search */}
          {!selected ? (
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-white/25" />
                <input
                  autoFocus
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search for a card…"
                  className="w-full rounded-xl border border-white/10 bg-white/[0.04] pl-8 pr-4 py-2.5 text-sm text-white/80 placeholder:text-white/25 focus:outline-none focus:border-white/20 transition-all"
                />
                {searching && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-white/25" />
                )}
              </div>

              {results.length > 0 && (
                <div className="rounded-xl border border-white/8 overflow-hidden divide-y divide-white/[0.05]">
                  {results.map(r => {
                    const price = extractTcgPrice(r.metadata_json)
                    return (
                      <button
                        key={r.catalog_id}
                        onClick={() => setSelected(r)}
                        className="flex items-center gap-3 w-full px-3 py-2.5 hover:bg-white/[0.04] transition-colors text-left"
                      >
                        {r.canonical_image_url
                          ? <Image src={r.canonical_image_url} alt={r.card_name} width={20} height={28} className="rounded shrink-0" unoptimized />
                          : <div className="w-5 h-7 rounded bg-white/5 shrink-0" />
                        }
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-white/80 truncate">{r.card_name}</p>
                          <p className="text-[10px] text-white/30 truncate">{r.set_name}</p>
                        </div>
                        {price && (
                          <span className="text-xs font-mono tabular-nums text-white/40 shrink-0">{fmtUsd(price)}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {/* Selected card */}
              <div className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.03] p-3">
                {selected.canonical_image_url
                  ? <Image src={selected.canonical_image_url} alt={selected.card_name} width={28} height={38} className="rounded shrink-0" unoptimized />
                  : <div className="w-7 h-10 rounded bg-white/5 shrink-0" />
                }
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white/85 truncate">{selected.card_name}</p>
                  <p className="text-[10px] text-white/30 truncate">{selected.set_name}</p>
                </div>
                <button onClick={() => setSelected(null)}>
                  <X className="h-3.5 w-3.5 text-white/25 hover:text-white/60 transition-colors" />
                </button>
              </div>

              {/* Target price */}
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-widest text-white/25 font-semibold">
                  Target Price (optional)
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-white/30">$</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={targetPrice}
                    onChange={e => setTargetPrice(e.target.value)}
                    placeholder="0.00"
                    className="w-full rounded-xl border border-white/10 bg-white/[0.04] pl-7 pr-4 py-2.5 text-sm text-white/80 placeholder:text-white/25 focus:outline-none focus:border-white/20 transition-all"
                  />
                </div>
                <p className="text-[10px] text-white/20">
                  You'll be able to compare against market price at a glance.
                </p>
              </div>

              <button
                onClick={handleAdd}
                disabled={adding}
                className="flex items-center justify-center gap-2 w-full rounded-xl py-2.5 text-sm font-semibold text-white disabled:opacity-50 transition-all"
                style={{ background: 'linear-gradient(135deg, #f43f5e, #e11d48)' }}
              >
                {adding
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Adding…</>
                  : <><Heart className="h-4 w-4" /> Add to Wantlist</>
                }
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function WantlistPage() {
  const [items,    setItems]    = useState<WantlistItem[]>([])
  const [loading,  setLoading]  = useState(true)
  const [showAdd,  setShowAdd]  = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res  = await fetch('/api/wantlist')
      const data = await res.json()
      setItems(data.items ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleAdd = async (catalogId: string, targetPrice: number | null) => {
    await fetch('/api/wantlist', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ catalogId, targetPrice }),
    })
    setShowAdd(false)
    load()
  }

  const handleRemove = async (id: string) => {
    setRemoving(id)
    await fetch(`/api/wantlist/${id}`, { method: 'DELETE' })
    setItems(prev => prev.filter(i => i.id !== id))
    setRemoving(null)
  }

  return (
    <div className="max-w-3xl mx-auto space-y-5 pb-12">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Heart className="h-5 w-5 text-rose-400" />
            Wantlist
          </h1>
          <p className="text-xs text-muted-foreground/50 mt-1">
            Track cards you're hunting — monitor price vs your target
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all"
          style={{ background: 'linear-gradient(135deg, #f43f5e, #e11d48)' }}
        >
          <Plus className="h-4 w-4" />
          Add Card
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div className="space-y-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-16 rounded-xl bg-white/[0.03] animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && items.length === 0 && (
        <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-10 text-center space-y-3">
          <Heart className="h-8 w-8 text-rose-400/30 mx-auto" />
          <p className="text-sm font-medium text-white/40">Your wantlist is empty</p>
          <p className="text-xs text-white/20">
            Add cards you're hunting to track their price vs your target.
          </p>
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-2 mt-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all"
            style={{ background: 'linear-gradient(135deg, #f43f5e, #e11d48)' }}
          >
            <Plus className="h-4 w-4" />
            Add your first card
          </button>
        </div>
      )}

      {/* Items list */}
      {!loading && items.length > 0 && (
        <div className="space-y-2">
          {items.map(item => {
            const card        = item.card_catalog_items
            const currentPrice = extractTcgPrice(card.metadata_json)
            const sparkPoints  = extractSparklinePoints(card.metadata_json)
            const target       = item.target_price

            let statusColor = 'text-white/30'
            let statusLabel = 'Watching'
            let StatusIcon  = Minus

            if (target != null && currentPrice != null) {
              if (currentPrice <= target) {
                statusColor = 'text-emerald-400'
                statusLabel = 'At or below target'
                StatusIcon  = TrendingDown
              } else {
                const overpct = ((currentPrice - target) / target) * 100
                statusColor = 'text-red-400'
                statusLabel = `${overpct.toFixed(0)}% above target`
                StatusIcon  = TrendingUp
              }
            }

            return (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 hover:bg-white/[0.03] transition-colors"
              >
                {/* Image */}
                {card.canonical_image_url
                  ? <Image src={card.canonical_image_url} alt={card.card_name} width={28} height={38}
                      className="rounded shrink-0 opacity-80" unoptimized />
                  : <div className="w-7 h-10 rounded bg-white/5 shrink-0" />
                }

                {/* Identity */}
                <div className="flex-1 min-w-0">
                  <Link
                    href={`/analyze/${card.catalog_id}`}
                    className="text-sm font-semibold text-white/85 truncate hover:text-white transition-colors block"
                  >
                    {card.card_name}
                  </Link>
                  <p className="text-[10px] text-white/30 truncate">
                    {card.set_name}{card.card_number ? ` · #${card.card_number}` : ''}
                  </p>
                </div>

                {/* Sparkline */}
                {sparkPoints.length >= 2 && (
                  <div className="shrink-0 hidden sm:block">
                    <Sparkline points={sparkPoints} width={56} height={22} />
                  </div>
                )}

                {/* Price vs target */}
                <div className="text-right shrink-0 space-y-0.5">
                  <p className="text-sm font-bold tabular-nums text-white/85">
                    {currentPrice != null ? fmtUsd(currentPrice) : '—'}
                  </p>
                  {target != null && (
                    <p className="text-[10px] text-white/30 tabular-nums">
                      target {fmtUsd(target)}
                    </p>
                  )}
                </div>

                {/* Status */}
                <div className={`shrink-0 hidden sm:flex items-center gap-1 ${statusColor}`}>
                  <StatusIcon className="h-3.5 w-3.5" />
                  <span className="text-[10px] font-medium">{statusLabel}</span>
                </div>

                {/* Link + remove */}
                <div className="flex items-center gap-2 shrink-0">
                  <Link href={`/analyze/${card.catalog_id}`}
                    className="text-white/15 hover:text-white/50 transition-colors">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                  <button
                    onClick={() => handleRemove(item.id)}
                    disabled={removing === item.id}
                    className="text-white/15 hover:text-red-400/60 transition-colors disabled:opacity-50"
                  >
                    {removing === item.id
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Trash2 className="h-3.5 w-3.5" />
                    }
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Summary stats if items exist */}
      {!loading && items.length > 0 && (
        <div className="rounded-xl border border-white/8 bg-white/[0.02] p-4">
          <p className="text-[10px] uppercase tracking-widest text-white/25 font-semibold mb-3">Wantlist Summary</p>
          <div className="grid grid-cols-3 gap-3">
            {(() => {
              const withPrice = items.filter(i => extractTcgPrice(i.card_catalog_items.metadata_json) != null)
              const withTarget = items.filter(i => i.target_price != null)
              const atOrBelow = withTarget.filter(i => {
                const cp = extractTcgPrice(i.card_catalog_items.metadata_json)
                return cp != null && i.target_price != null && cp <= i.target_price
              })
              const totalCurrentValue = withPrice.reduce((s, i) => s + (extractTcgPrice(i.card_catalog_items.metadata_json) ?? 0), 0)
              return [
                { label: 'Cards watching',  value: items.length.toString(),      color: 'text-white/70' },
                { label: 'At/below target', value: atOrBelow.length.toString(),  color: 'text-emerald-400' },
                { label: 'Total mkt value', value: fmtUsd(totalCurrentValue),    color: 'text-indigo-300' },
              ]
            })().map(({ label, value, color }) => (
              <div key={label}>
                <p className="text-[9px] uppercase tracking-widest text-white/20 font-semibold mb-1">{label}</p>
                <p className={`text-base font-bold tabular-nums ${color}`}>{value}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add card modal */}
      {showAdd && (
        <AddCardModal
          onAdd={handleAdd}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  )
}
