'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Search, X, ArrowLeftRight, DollarSign, Pencil, Check,
  Loader2, AlertCircle, RotateCcw, Info,
} from 'lucide-react'
import Image from 'next/image'
import { cn } from '@/lib/utils'
import type { CardSearchResult } from '@/types/catalog'

// ── Price extraction ──────────────────────────────────────────────────────────

function extractTcgPrice(meta: Record<string, any> | null): number | null {
  if (!meta?.tcgplayer?.prices) return null
  const prices = meta.tcgplayer.prices as Record<string, { market?: number; mid?: number }>
  const PRIORITY = [
    'holofoil', '1stEditionHolofoil', 'reverseHolofoil',
    'normal', 'unlimitedHolofoil', '1stEditionNormal',
  ]
  for (const band of PRIORITY) {
    const p = prices[band]
    if (p?.market && p.market > 0) return p.market
    if (p?.mid && p.mid > 0) return p.mid
  }
  // Fallback: first available band
  for (const b of Object.values(prices)) {
    const p = b as any
    if (p?.market && p.market > 0) return p.market
    if (p?.mid && p.mid > 0) return p.mid
  }
  return null
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface TradeCard {
  id:          string
  card_name:   string
  set_name:    string
  card_number: string | null
  image_url:   string | null
  tcgPrice:    number | null   // auto-resolved from TCGPlayer metadata
  manualPrice: number | null   // user override (null = use tcgPrice)
}

type Side = 'mine' | 'theirs'

// ── Preset trade-in percentages ───────────────────────────────────────────────

const TRADE_PRESETS = [
  { label: '100%', value: 100, desc: 'Collector-to-collector' },
  { label: '80%',  value: 80,  desc: 'Standard store trade'   },
  { label: '70%',  value: 70,  desc: 'Value store trade'      },
  { label: '60%',  value: 60,  desc: 'Budget store trade'     },
]

// ── Card search panel component ───────────────────────────────────────────────

function CardSearchDropdown({
  side,
  onAdd,
  existingIds,
}: {
  side:        Side
  onAdd:       (card: TradeCard) => void
  existingIds: Set<string>
}) {
  const [query,    setQuery]    = useState('')
  const [results,  setResults]  = useState<CardSearchResult[]>([])
  const [loading,  setLoading]  = useState(false)
  const [open,     setOpen]     = useState(false)
  const timer     = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef  = useRef<HTMLInputElement>(null)
  const dropRef   = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const search = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setResults([]); setOpen(false); return }
    setLoading(true)
    try {
      const res  = await fetch(`/api/catalog/search?q=${encodeURIComponent(q)}&limit=20`)
      const data = await res.json()
      setResults(data.results ?? [])
      setOpen(true)
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  const handleChange = (val: string) => {
    setQuery(val)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => search(val), 300)
  }

  const handleSelect = (r: CardSearchResult) => {
    if (existingIds.has(r.catalog_id)) return
    const card: TradeCard = {
      id:          r.catalog_id,
      card_name:   r.card_name,
      set_name:    r.set_name,
      card_number: r.card_number,
      image_url:   r.canonical_image_url,
      tcgPrice:    extractTcgPrice(r.metadata_json),
      manualPrice: null,
    }
    onAdd(card)
    setQuery('')
    setResults([])
    setOpen(false)
    inputRef.current?.focus()
  }

  return (
    <div className="relative" ref={dropRef}>
      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 focus-within:border-white/20 transition-colors">
        {loading
          ? <Loader2 className="h-3.5 w-3.5 text-muted-foreground/40 animate-spin shrink-0" />
          : <Search className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />}
        <input
          ref={inputRef}
          value={query}
          onChange={e => handleChange(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="Search cards to add…"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/30 text-foreground min-w-0"
        />
        {query && (
          <button onClick={() => { setQuery(''); setResults([]); setOpen(false) }}>
            <X className="h-3.5 w-3.5 text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors" />
          </button>
        )}
      </div>

      {open && results.length > 0 && (
        <div className="absolute z-[200] w-full bottom-full mb-1.5 rounded-xl border border-white/10 bg-[#0d1117] shadow-2xl overflow-hidden max-h-72 overflow-y-auto">
          {results.map(r => {
            const price    = extractTcgPrice(r.metadata_json)
            const already  = existingIds.has(r.catalog_id)
            return (
              <button
                key={r.catalog_id}
                disabled={already}
                onClick={() => handleSelect(r)}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors border-b border-white/[0.04] last:border-0',
                  already
                    ? 'opacity-35 cursor-not-allowed'
                    : 'hover:bg-white/[0.05] cursor-pointer',
                )}
              >
                {r.canonical_image_url ? (
                  <Image
                    src={r.canonical_image_url}
                    alt={r.card_name}
                    width={28}
                    height={40}
                    className="rounded object-cover shrink-0"
                    unoptimized
                  />
                ) : (
                  <div className="w-7 h-10 rounded bg-white/5 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{r.card_name}</p>
                  <p className="text-[10px] text-muted-foreground/50 truncate">
                    {r.set_name}{r.card_number ? ` · #${r.card_number}` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {price != null ? (
                    <span className="text-sm font-bold tabular-nums text-foreground">
                      ${price.toFixed(2)}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground/30">no price</span>
                  )}
                  {already && (
                    <span className="block text-[9px] text-muted-foreground/30">added</span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {open && !loading && results.length === 0 && query.trim().length >= 2 && (
        <div className="absolute z-[200] w-full bottom-full mb-1.5 rounded-xl border border-white/10 bg-[#0d1117] shadow-xl px-4 py-3">
          <p className="text-xs text-muted-foreground/40">No cards found for &quot;{query}&quot;</p>
        </div>
      )}
    </div>
  )
}

// ── Price cell with inline editing ────────────────────────────────────────────

function PriceCell({
  card,
  onChange,
}: {
  card:     TradeCard
  onChange: (id: string, manual: number | null) => void
}) {
  const [editing, setEditing]  = useState(false)
  const [draft,   setDraft]    = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const displayPrice = card.manualPrice ?? card.tcgPrice
  const isOverridden = card.manualPrice != null

  const startEdit = () => {
    setDraft((displayPrice ?? '').toString())
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  const commit = () => {
    const n = parseFloat(draft)
    if (!isNaN(n) && n >= 0) {
      onChange(card.id, n)
    }
    setEditing(false)
  }

  const clear = () => {
    onChange(card.id, null)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground/40 text-sm">$</span>
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
          onBlur={commit}
          className="w-20 bg-white/8 rounded px-1.5 py-0.5 text-sm tabular-nums outline-none border border-white/15 text-foreground"
          type="number"
          step="0.01"
          min="0"
        />
        <button onClick={commit}><Check className="h-3 w-3 text-emerald-400" /></button>
        {isOverridden && (
          <button onClick={clear} title="Reset to TCGPlayer price">
            <RotateCcw className="h-3 w-3 text-muted-foreground/30 hover:text-amber-400 transition-colors" />
          </button>
        )}
      </div>
    )
  }

  return (
    <button
      onClick={startEdit}
      className="group flex items-center gap-1.5 text-right"
      title="Click to override price"
    >
      {displayPrice != null ? (
        <span className={cn(
          'text-sm font-bold tabular-nums',
          isOverridden ? 'text-amber-300' : 'text-foreground',
        )}>
          ${displayPrice.toFixed(2)}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground/30 italic">set price</span>
      )}
      <Pencil className="h-2.5 w-2.5 text-muted-foreground/20 group-hover:text-muted-foreground/50 transition-colors" />
    </button>
  )
}

// ── Card row ──────────────────────────────────────────────────────────────────

function CardRow({
  card,
  onRemove,
  onPriceChange,
}: {
  card:          TradeCard
  onRemove:      (id: string) => void
  onPriceChange: (id: string, manual: number | null) => void
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.025] border border-white/[0.05] hover:bg-white/[0.04] transition-colors group">
      {card.image_url ? (
        <Image
          src={card.image_url}
          alt={card.card_name}
          width={26}
          height={36}
          className="rounded object-cover shrink-0"
          unoptimized
        />
      ) : (
        <div className="w-[26px] h-9 rounded bg-white/5 shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate leading-tight">{card.card_name}</p>
        <p className="text-[10px] text-muted-foreground/40 truncate leading-tight">
          {card.set_name}{card.card_number ? ` · #${card.card_number}` : ''}
          {card.tcgPrice == null && (
            <span className="ml-1 text-amber-400/50">· no TCG price</span>
          )}
        </p>
      </div>
      <PriceCell card={card} onChange={onPriceChange} />
      <button
        onClick={() => onRemove(card.id)}
        className="opacity-0 group-hover:opacity-100 transition-opacity ml-1 shrink-0"
      >
        <X className="h-3.5 w-3.5 text-muted-foreground/30 hover:text-red-400 transition-colors" />
      </button>
    </div>
  )
}

// ── Trade panel ───────────────────────────────────────────────────────────────

function TradePanel({
  title,
  accent,
  cards,
  tradePct,
  isMine,
  onAdd,
  onRemove,
  onPriceChange,
  allIds,
}: {
  title:         string
  accent:        string
  cards:         TradeCard[]
  tradePct:      number
  isMine:        boolean
  onAdd:         (c: TradeCard) => void
  onRemove:      (id: string) => void
  onPriceChange: (id: string, manual: number | null) => void
  allIds:        Set<string>
}) {
  const total   = cards.reduce((s, c) => s + (c.manualPrice ?? c.tcgPrice ?? 0), 0)
  const credits = isMine ? total * (tradePct / 100) : total
  const unpricedCount = cards.filter(c => c.manualPrice == null && c.tcgPrice == null).length

  return (
    <div className="flex flex-col rounded-2xl border border-white/8 bg-white/[0.015] relative">
      {/* Panel header */}
      <div className={cn('px-4 py-3 border-b border-white/8 rounded-t-2xl', accent === 'indigo' ? 'bg-indigo-500/5' : 'bg-emerald-500/5')}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className={cn('w-2 h-2 rounded-full shrink-0', accent === 'indigo' ? 'bg-indigo-400' : 'bg-emerald-400')} />
            <span className={cn('text-xs font-semibold uppercase tracking-widest', accent === 'indigo' ? 'text-indigo-300/70' : 'text-emerald-300/70')}>
              {title}
            </span>
            <span className="text-[10px] text-muted-foreground/30">{cards.length} card{cards.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="text-right">
            <p className="text-xl font-bold tabular-nums leading-none">
              ${total.toFixed(2)}
            </p>
            {isMine && tradePct < 100 && (
              <p className={cn('text-[10px] tabular-nums', accent === 'indigo' ? 'text-indigo-300/50' : 'text-emerald-300/50')}>
                {tradePct}% → ${credits.toFixed(2)} credits
              </p>
            )}
          </div>
        </div>
        {unpricedCount > 0 && (
          <div className="flex items-center gap-1.5 mt-2 text-[10px] text-amber-400/60">
            <AlertCircle className="h-3 w-3 shrink-0" />
            {unpricedCount} card{unpricedCount > 1 ? 's' : ''} without TCGPlayer price — click the price to set manually
          </div>
        )}
      </div>

      {/* Card list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5 min-h-[180px] max-h-[420px]">
        {cards.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center py-8 text-center">
            <DollarSign className="h-6 w-6 text-muted-foreground/15 mb-2" />
            <p className="text-xs text-muted-foreground/30">Search and add cards below</p>
          </div>
        ) : (
          cards.map(c => (
            <CardRow
              key={c.id}
              card={c}
              onRemove={onRemove}
              onPriceChange={onPriceChange}
            />
          ))
        )}
      </div>

      {/* Search */}
      <div className="p-3 border-t border-white/5">
        <CardSearchDropdown side={isMine ? 'mine' : 'theirs'} onAdd={onAdd} existingIds={allIds} />
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'trade_analyzer_state'

export default function TradePage() {
  const [myCards,    setMyCards]    = useState<TradeCard[]>([])
  const [theirCards, setTheirCards] = useState<TradeCard[]>([])
  const [tradePct,   setTradePct]   = useState(100)
  const [customPct,  setCustomPct]  = useState('')
  const [isCustom,   setIsCustom]   = useState(false)
  const [hydrated,   setHydrated]   = useState(false)

  // ── Hydrate from localStorage ───────────────────────────────────────────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const s = JSON.parse(raw)
        if (s.myCards)    setMyCards(s.myCards)
        if (s.theirCards) setTheirCards(s.theirCards)
        if (s.tradePct)   setTradePct(s.tradePct)
        if (s.isCustom)   setIsCustom(s.isCustom)
        if (s.customPct)  setCustomPct(s.customPct)
      }
    } catch {}
    setHydrated(true)
  }, [])

  // ── Persist to localStorage ─────────────────────────────────────────────────
  useEffect(() => {
    if (!hydrated) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ myCards, theirCards, tradePct, isCustom, customPct }))
    } catch {}
  }, [myCards, theirCards, tradePct, isCustom, customPct, hydrated])

  // ── Calculations ────────────────────────────────────────────────────────────
  const myTotal    = myCards.reduce((s, c)    => s + (c.manualPrice ?? c.tcgPrice ?? 0), 0)
  const theirTotal = theirCards.reduce((s, c) => s + (c.manualPrice ?? c.tcgPrice ?? 0), 0)
  const myCredits  = myTotal * (tradePct / 100)
  const diff       = myCredits - theirTotal   // positive = I get cash back, negative = I owe

  const hasUnpricedMine   = myCards.some(c => c.manualPrice == null && c.tcgPrice == null)
  const hasUnpricedTheirs = theirCards.some(c => c.manualPrice == null && c.tcgPrice == null)
  const hasUnpriced = hasUnpricedMine || hasUnpricedTheirs

  // ── Shared card ID set (prevent duplicates across sides) ────────────────────
  const allIds = new Set([...myCards.map(c => c.id), ...theirCards.map(c => c.id)])

  // ── Handlers ────────────────────────────────────────────────────────────────
  const addMine    = (c: TradeCard) => setMyCards(prev => [...prev, c])
  const addTheirs  = (c: TradeCard) => setTheirCards(prev => [...prev, c])
  const removeMine    = (id: string) => setMyCards(prev => prev.filter(c => c.id !== id))
  const removeTheirs  = (id: string) => setTheirCards(prev => prev.filter(c => c.id !== id))

  const setPriceMine   = (id: string, manual: number | null) =>
    setMyCards(prev => prev.map(c => c.id === id ? { ...c, manualPrice: manual } : c))
  const setPriceTheirs = (id: string, manual: number | null) =>
    setTheirCards(prev => prev.map(c => c.id === id ? { ...c, manualPrice: manual } : c))

  const clearAll = () => {
    setMyCards([])
    setTheirCards([])
  }

  const handlePreset = (val: number) => {
    setTradePct(val)
    setIsCustom(false)
    setCustomPct('')
  }

  const handleCustomChange = (val: string) => {
    setCustomPct(val)
    const n = parseFloat(val)
    if (!isNaN(n) && n > 0 && n <= 100) {
      setTradePct(n)
      setIsCustom(true)
    }
  }

  const isEven    = Math.abs(diff) < 0.01
  const iOweCash  = diff < -0.01
  const iGetCash  = diff > 0.01
  const hasCards  = myCards.length > 0 || theirCards.length > 0

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-20">

      {/* ── Page header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Trade Analyzer</h1>
          <p className="text-xs text-muted-foreground/50 mt-0.5">
            Evaluate card trades instantly — know exactly how much cash changes hands
          </p>
        </div>
        {hasCards && (
          <button
            onClick={clearAll}
            className="flex items-center gap-1.5 text-xs text-muted-foreground/30 hover:text-red-400 transition-colors border border-white/8 hover:border-red-400/20 rounded-lg px-3 py-1.5"
          >
            <RotateCcw className="h-3 w-3" />
            Clear all
          </button>
        )}
      </div>

      {/* ── Trade-in rate selector ───────────────────────────────────────────── */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
            Trade-in Rate
          </span>
          <span className="text-[10px] text-muted-foreground/30 font-normal normal-case">
            · how much store credit you receive per dollar of card value
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {TRADE_PRESETS.map(p => {
            const isActive = !isCustom && tradePct === p.value
            return (
              <button
                key={p.value}
                onClick={() => handlePreset(p.value)}
                className={cn(
                  'flex flex-col items-center px-4 py-2.5 rounded-xl border text-xs font-medium transition-all',
                  isActive
                    ? 'border-indigo-400/30 bg-indigo-400/8 text-white'
                    : 'border-white/8 bg-white/[0.025] text-muted-foreground/60 hover:text-white/70 hover:border-white/15',
                )}
              >
                <span className={cn('text-base font-bold', isActive ? 'text-indigo-300' : '')}>{p.label}</span>
                <span className={cn('text-[9px] font-normal mt-0.5', isActive ? 'text-indigo-300/60' : 'text-muted-foreground/30')}>
                  {p.desc}
                </span>
              </button>
            )
          })}

          {/* Custom input */}
          <div className={cn(
            'flex items-center gap-1.5 px-3 py-2.5 rounded-xl border transition-all',
            isCustom ? 'border-indigo-400/30 bg-indigo-400/8' : 'border-white/8 bg-white/[0.025]',
          )}>
            <span className="text-xs text-muted-foreground/40">Custom</span>
            <input
              value={customPct}
              onChange={e => handleCustomChange(e.target.value)}
              onFocus={() => setIsCustom(true)}
              placeholder="95"
              className="w-12 bg-transparent text-sm tabular-nums font-bold text-center outline-none text-foreground placeholder:text-muted-foreground/20"
              type="number"
              min="1"
              max="100"
              step="1"
            />
            <span className="text-xs text-muted-foreground/40">%</span>
          </div>
        </div>

        {tradePct < 100 && (
          <p className="text-[11px] text-muted-foreground/35 flex items-center gap-1.5">
            <Info className="h-3 w-3 shrink-0" />
            At {tradePct}% trade-in: $100 of your cards = ${tradePct.toFixed(0)} in store credit
          </p>
        )}
      </div>

      {/* ── Two-panel trade layout ───────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TradePanel
          title="My Cards"
          accent="indigo"
          cards={myCards}
          tradePct={tradePct}
          isMine
          onAdd={addMine}
          onRemove={removeMine}
          onPriceChange={setPriceMine}
          allIds={allIds}
        />

        {/* Arrow divider (desktop only) */}
        <div className="hidden md:flex items-center justify-center absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
          <div className="rounded-full border border-white/10 bg-[#0d1117] p-2">
            <ArrowLeftRight className="h-4 w-4 text-white/20" />
          </div>
        </div>

        <TradePanel
          title="Their Cards / Store Items"
          accent="emerald"
          cards={theirCards}
          tradePct={tradePct}
          isMine={false}
          onAdd={addTheirs}
          onRemove={removeTheirs}
          onPriceChange={setPriceTheirs}
          allIds={allIds}
        />
      </div>

      {/* ── Verdict ─────────────────────────────────────────────────────────── */}
      {hasCards && (
        <div className={cn(
          'rounded-2xl border p-5 space-y-4 transition-all',
          isEven
            ? 'border-white/15 bg-white/[0.03]'
            : iGetCash
            ? 'border-emerald-400/20 bg-emerald-400/[0.04]'
            : 'border-rose-400/20 bg-rose-400/[0.04]',
        )}>

          {/* Math summary row */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-6">
              <div className="text-center">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground/40 mb-1">My cards</p>
                <p className="text-lg font-bold tabular-nums">${myTotal.toFixed(2)}</p>
                {tradePct < 100 && (
                  <p className="text-[10px] text-indigo-300/50 tabular-nums">
                    = ${myCredits.toFixed(2)} credits
                  </p>
                )}
              </div>

              <ArrowLeftRight className="h-4 w-4 text-muted-foreground/20 shrink-0" />

              <div className="text-center">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground/40 mb-1">Their cards</p>
                <p className="text-lg font-bold tabular-nums">${theirTotal.toFixed(2)}</p>
              </div>
            </div>

            {/* Verdict badge */}
            <div className={cn(
              'flex items-center gap-2 px-4 py-3 rounded-xl',
              isEven   ? 'bg-white/5'        :
              iGetCash ? 'bg-emerald-500/10' : 'bg-rose-500/10',
            )}>
              {isEven ? (
                <>
                  <span className="text-xl">🤝</span>
                  <div>
                    <p className="text-sm font-bold text-white">Even trade</p>
                    <p className="text-[10px] text-muted-foreground/40">Values match exactly</p>
                  </div>
                </>
              ) : iGetCash ? (
                <>
                  <span className="text-xl">💰</span>
                  <div>
                    <p className="text-sm font-bold text-emerald-300">
                      You receive ${Math.abs(diff).toFixed(2)} cash
                    </p>
                    <p className="text-[10px] text-muted-foreground/40">
                      Your cards are worth more — you get cash back
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <span className="text-xl">💸</span>
                  <div>
                    <p className="text-sm font-bold text-rose-300">
                      You owe ${Math.abs(diff).toFixed(2)} cash
                    </p>
                    <p className="text-[10px] text-muted-foreground/40">
                      Their cards are worth more — add cash to make up the difference
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Breakdown bar */}
          {(myTotal > 0 || theirTotal > 0) && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-[10px] text-muted-foreground/30">
                <span>My credits ({tradePct}%)</span>
                <span>Their total</span>
              </div>
              <div className="h-2 rounded-full bg-white/5 overflow-hidden flex">
                {(() => {
                  const total = myCredits + theirTotal
                  if (!total) return null
                  const myW = (myCredits / total) * 100
                  return (
                    <>
                      <div
                        className="h-full rounded-l-full bg-indigo-400 transition-all duration-500"
                        style={{ width: `${myW}%` }}
                      />
                      <div
                        className="h-full rounded-r-full bg-emerald-400 transition-all duration-500"
                        style={{ width: `${100 - myW}%` }}
                      />
                    </>
                  )
                })()}
              </div>
            </div>
          )}

          {/* Unpriced cards warning */}
          {hasUnpriced && (
            <p className="text-[11px] text-amber-400/60 flex items-center gap-1.5">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              Some cards are missing prices — total may be inaccurate. Click any price cell to set it manually.
            </p>
          )}
        </div>
      )}

      {/* ── Tip ──────────────────────────────────────────────────────────────── */}
      {!hasCards && (
        <div className="rounded-xl border border-white/5 bg-white/[0.01] p-5 text-center space-y-1">
          <p className="text-sm text-muted-foreground/40">
            Add cards to both sides to evaluate the trade
          </p>
          <p className="text-[11px] text-muted-foreground/20">
            Prices are pulled from TCGPlayer market data automatically · click any price to override
          </p>
        </div>
      )}
    </div>
  )
}
