'use client'

/**
 * Buy Price Calculator
 *
 * Mobile-first tool for card shows and shops.
 * Search a card → see TCGPlayer fair value → get max buy price
 * at your target margin after all fees.
 */

import { useState, useCallback, useEffect } from 'react'
import { Search, Loader2, X, TrendingUp, DollarSign, ShoppingCart, ChevronDown, ChevronUp, RotateCcw, ExternalLink } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import type { CardSearchResult } from '@/types/catalog'
import { calculateFees, type Platform } from '@/lib/engines/feeCalculator'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined) {
  if (n == null) return '—'
  return `$${n.toFixed(2)}`
}

function getBestPrice(meta: Record<string, any> | null): number | null {
  if (!meta?.tcgplayer?.prices) return null
  const prices = meta.tcgplayer.prices
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

function getImageUrl(card: CardSearchResult | null): string | null {
  if (!card) return null
  const meta = card.metadata_json as any
  return meta?.images?.small ?? meta?.images?.large ?? card.canonical_image_url ?? null
}

// ── Traffic light decision ────────────────────────────────────────────────────

type Decision = 'buy' | 'negotiate' | 'pass'

function getDecision(askPrice: number, maxBuyPrice: number): Decision {
  const ratio = askPrice / maxBuyPrice
  if (ratio <= 0.9)  return 'buy'
  if (ratio <= 1.05) return 'negotiate'
  return 'pass'
}

const DECISION_STYLE: Record<Decision, { bg: string; border: string; text: string; label: string; emoji: string }> = {
  buy:       { bg: 'bg-emerald-500/15', border: 'border-emerald-500/40', text: 'text-emerald-300', label: 'Good Buy',  emoji: '✅' },
  negotiate: { bg: 'bg-amber-500/15',   border: 'border-amber-500/40',   text: 'text-amber-300',   label: 'Negotiate', emoji: '🤝' },
  pass:      { bg: 'bg-red-500/15',     border: 'border-red-500/40',     text: 'text-red-300',     label: 'Pass',      emoji: '❌' },
}

// ── Card search ───────────────────────────────────────────────────────────────

function CardSearch({ onSelect }: { onSelect: (card: CardSearchResult) => void }) {
  const [query, setQuery]     = useState('')
  const [results, setResults] = useState<CardSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen]       = useState(false)

  const search = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); setOpen(false); return }
    setLoading(true)
    try {
      const res = await fetch(`/api/catalog/search?q=${encodeURIComponent(q)}`)
      const data = await res.json()
      setResults(data.results?.slice(0, 8) ?? [])
      setOpen(true)
    } catch { setResults([]) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => search(query), 300)
    return () => clearTimeout(t)
  }, [query, search])

  return (
    <div className="relative">
      <div className="relative">
        {loading
          ? <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/30 animate-spin" />
          : <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/30" />
        }
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search card name…"
          className="w-full rounded-xl border border-white/10 bg-white/[0.04] pl-10 pr-10 py-3 text-sm text-white placeholder:text-white/25 focus:outline-none focus:border-white/25 transition-colors"
        />
        {query && (
          <button onClick={() => { setQuery(''); setResults([]); setOpen(false) }}
            className="absolute right-3 top-1/2 -translate-y-1/2">
            <X className="h-3.5 w-3.5 text-white/30 hover:text-white/60" />
          </button>
        )}
      </div>

      {open && results.length > 0 && (
        <div className="absolute top-full mt-1 left-0 right-0 rounded-xl border border-white/10 bg-[#0f0a28] overflow-hidden z-50 shadow-2xl">
          {results.map(card => {
            const price = getBestPrice(card.metadata_json as any)
            const img   = getImageUrl(card)
            return (
              <button
                key={card.catalog_id}
                onClick={() => { onSelect(card); setQuery(''); setOpen(false) }}
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.05] border-b border-white/5 last:border-0 text-left transition-colors"
              >
                {img
                  ? <img src={img} alt={card.card_name} className="h-10 w-7 object-contain rounded shrink-0" />
                  : <div className="h-10 w-7 bg-white/5 rounded shrink-0" />
                }
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{card.card_name}</p>
                  <p className="text-[11px] text-white/40 truncate">{card.set_name}{card.card_number ? ` · #${card.card_number}` : ''}</p>
                </div>
                {price != null && (
                  <span className="text-xs font-semibold text-emerald-400 shrink-0">{fmt(price)}</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Main calculator ───────────────────────────────────────────────────────────

export default function BuyPriceCalculator() {
  const [card,         setCard]         = useState<CardSearchResult | null>(null)
  const [askPrice,     setAskPrice]     = useState('')
  const [platform,     setPlatform]     = useState<Platform>('ebay')
  const [shipping,     setShipping]     = useState('4.00')
  const [margin,       setMargin]       = useState('30')
  const [showBreakdown, setShowBreakdown] = useState(false)

  const meta      = (card?.metadata_json ?? {}) as Record<string, any>
  const fairValue = getBestPrice(meta)
  const imageUrl  = card ? getImageUrl(card) : null

  // ── Calculator logic ────────────────────────────────────────────────────────
  const sellPrice    = fairValue
  const ask          = parseFloat(askPrice) || 0
  const shippingNum  = parseFloat(shipping) || 4
  const marginPct    = Math.max(0, Math.min(100, parseFloat(margin) || 30)) / 100

  const fees = sellPrice != null
    ? calculateFees({ salePrice: sellPrice, platform, shippingCost: shippingNum })
    : null

  const netProceeds  = fees?.netProceeds ?? null
  const maxBuyPrice  = netProceeds != null ? netProceeds * (1 - marginPct) : null
  const expectedProfit = maxBuyPrice != null && ask > 0 ? netProceeds! - ask : null
  const decision     = maxBuyPrice != null && ask > 0 ? getDecision(ask, maxBuyPrice) : null

  const reset = () => {
    setCard(null)
    setAskPrice('')
  }

  return (
    <div className="max-w-lg mx-auto space-y-5 pb-10">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Buy Price Calculator</h1>
        <p className="text-sm text-white/40 mt-1">
          Find a card → set your margin → know instantly if it&apos;s worth buying.
        </p>
      </div>

      {/* Card selector */}
      {!card ? (
        <div className="space-y-3">
          <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">Find a card</p>
          <CardSearch onSelect={setCard} />
        </div>
      ) : (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
          {/* Card identity */}
          <div className="flex items-center gap-3 p-4">
            {imageUrl && (
              <div className="relative h-16 w-11 shrink-0 rounded-md overflow-hidden border border-white/10">
                <Image src={imageUrl} alt={card.card_name} fill className="object-contain" sizes="44px" unoptimized />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-white leading-tight">{card.card_name}</p>
              <p className="text-xs text-white/40 mt-0.5 truncate">
                {card.set_name}{card.card_number ? ` · #${card.card_number}` : ''}
              </p>
              {fairValue != null && (
                <p className="text-xs text-emerald-400 font-semibold mt-1">
                  TCGPlayer NM: {fmt(fairValue)}
                </p>
              )}
              {fairValue == null && (
                <p className="text-xs text-amber-400/70 mt-1">No TCGPlayer price data</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5 shrink-0">
              <Link href={`/analyze/${card.catalog_id}`}
                className="text-[10px] text-white/25 hover:text-white/60 flex items-center gap-1 transition-colors">
                Full analysis <ExternalLink className="h-2.5 w-2.5" />
              </Link>
              <button onClick={reset}
                className="text-[10px] text-white/25 hover:text-white/60 flex items-center gap-1 transition-colors">
                <RotateCcw className="h-2.5 w-2.5" /> Change
              </button>
            </div>
          </div>

          {fairValue != null && (
            <>
              <div className="border-t border-white/8 p-4 space-y-4">

                {/* Ask price */}
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">
                    What are they asking?
                  </p>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 text-sm">$</span>
                    <input
                      type="number"
                      min="0"
                      step="0.50"
                      value={askPrice}
                      onChange={e => setAskPrice(e.target.value)}
                      placeholder="0.00"
                      className="w-full rounded-xl border border-white/10 bg-white/[0.04] pl-7 pr-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/25 transition-colors"
                    />
                  </div>
                </div>

                {/* Platform + margin */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">Sell on</p>
                    <div className="grid grid-cols-2 gap-1">
                      {(['ebay', 'tcgplayer'] as Platform[]).map(p => (
                        <button key={p} onClick={() => setPlatform(p)}
                          className={[
                            'text-[11px] py-2 rounded-lg font-semibold transition-all border',
                            platform === p
                              ? 'bg-indigo-600/20 border-indigo-500/40 text-indigo-300'
                              : 'bg-white/[0.03] border-white/8 text-white/30 hover:text-white/60',
                          ].join(' ')}>
                          {p === 'ebay' ? 'eBay' : 'TCG'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">Target margin</p>
                    <div className="flex flex-wrap gap-1">
                      {['20', '30', '40', '50'].map(m => (
                        <button key={m} onClick={() => setMargin(m)}
                          className={[
                            'text-[11px] px-2 py-1.5 rounded-lg font-semibold transition-all border flex-1',
                            margin === m
                              ? 'bg-indigo-600/20 border-indigo-500/40 text-indigo-300'
                              : 'bg-white/[0.03] border-white/8 text-white/30 hover:text-white/60',
                          ].join(' ')}>
                          {m}%
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Shipping */}
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">Your shipping cost</p>
                  <div className="relative w-32">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 text-sm">$</span>
                    <input
                      type="number"
                      min="0"
                      step="0.50"
                      value={shipping}
                      onChange={e => setShipping(e.target.value)}
                      className="w-full rounded-xl border border-white/10 bg-white/[0.04] pl-7 pr-3 py-2 text-sm text-white focus:outline-none focus:border-white/25 transition-colors"
                    />
                  </div>
                </div>
              </div>

              {/* Results */}
              <div className="border-t border-white/8 p-4 space-y-3">

                {/* Max buy price — hero number */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">Max buy price</p>
                    <p className="text-3xl font-black text-white tabular-nums mt-0.5">
                      {fmt(maxBuyPrice)}
                    </p>
                    <p className="text-[11px] text-white/30 mt-0.5">
                      at {margin}% margin · {platform === 'ebay' ? 'eBay' : 'TCGPlayer'} fees
                    </p>
                  </div>

                  {/* Decision badge */}
                  {decision && (() => {
                    const d = DECISION_STYLE[decision]
                    return (
                      <div className={[
                        'rounded-2xl border px-4 py-3 text-center min-w-[90px]',
                        d.bg, d.border,
                      ].join(' ')}>
                        <p className="text-2xl">{d.emoji}</p>
                        <p className={['text-xs font-bold mt-1', d.text].join(' ')}>{d.label}</p>
                      </div>
                    )
                  })()}
                </div>

                {/* Ask vs max comparison */}
                {ask > 0 && maxBuyPrice != null && (
                  <div className="rounded-xl border border-white/8 bg-white/[0.02] p-3 space-y-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-white/40">Their ask</span>
                      <span className="text-white font-semibold tabular-nums">{fmt(ask)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-white/40">Your max</span>
                      <span className={[
                        'font-semibold tabular-nums',
                        ask <= maxBuyPrice ? 'text-emerald-400' : 'text-red-400',
                      ].join(' ')}>{fmt(maxBuyPrice)}</span>
                    </div>
                    <div className="flex justify-between text-xs border-t border-white/8 pt-2">
                      <span className="text-white/40">
                        {expectedProfit != null && expectedProfit >= 0 ? 'Expected profit' : 'Would lose'}
                      </span>
                      <span className={[
                        'font-bold tabular-nums',
                        expectedProfit != null && expectedProfit >= 0 ? 'text-emerald-400' : 'text-red-400',
                      ].join(' ')}>
                        {expectedProfit != null ? fmt(Math.abs(expectedProfit)) : '—'}
                      </span>
                    </div>
                  </div>
                )}

                {/* Fee breakdown toggle */}
                <button
                  onClick={() => setShowBreakdown(v => !v)}
                  className="flex items-center gap-1.5 text-[10px] text-white/25 hover:text-white/50 transition-colors"
                >
                  {showBreakdown ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  {showBreakdown ? 'Hide' : 'Show'} fee breakdown
                </button>

                {showBreakdown && fees && (
                  <div className="rounded-xl border border-white/8 bg-white/[0.02] overflow-hidden">
                    {fees.breakdown.map(({ label, amount }) => (
                      <div key={label} className="flex justify-between px-3 py-2 text-xs border-b border-white/5 last:border-0">
                        <span className="text-white/40">{label}</span>
                        <span className={[
                          'tabular-nums font-medium',
                          label === 'Net Proceeds' ? 'text-white font-bold' : amount < 0 ? 'text-red-400/70' : 'text-white/70',
                        ].join(' ')}>
                          {amount < 0 ? `-${fmt(Math.abs(amount))}` : fmt(amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <p className="text-[10px] text-white/20 leading-relaxed">
                  Based on TCGPlayer NM market price · {platform === 'ebay' ? '13.25% + $0.30 eBay fee' : '10.25% + $0.30 TCGPlayer fee'} · ${shippingNum.toFixed(2)} shipping
                </p>
              </div>
            </>
          )}
        </div>
      )}

      {/* Empty state */}
      {!card && (
        <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-8 text-center space-y-3">
          <ShoppingCart className="h-8 w-8 text-white/15 mx-auto" />
          <div>
            <p className="text-sm font-medium text-white/40">Search a card above</p>
            <p className="text-xs text-white/20 mt-1">
              Enter the asking price → instantly see if it&apos;s worth buying at your target margin
            </p>
          </div>
          <div className="flex flex-wrap gap-2 justify-center pt-2">
            {['Charizard Base Set', 'Pikachu 151', 'Umbreon VMAX'].map(ex => (
              <span key={ex} className="text-[10px] px-2.5 py-1 rounded-full border border-white/8 text-white/25">
                {ex}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
