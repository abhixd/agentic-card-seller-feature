'use client'

/**
 * B1 — Listing Price Optimizer
 *
 * Uses a recency-weighted median of eBay sold comps to produce three
 * price bands: Quick Sale, Fair Market, and Stretch.
 *
 * Comps are auto-fetched from the eBay sold-history API when a catalog
 * card is selected, or entered manually.
 */

import { useEffect, useState, useMemo } from 'react'
import {
  Tag, Loader2, Play, Plus, Trash2, RefreshCw,
  Zap, Target, TrendingUp, AlertCircle, Settings2,
  ChevronDown, CheckCircle2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

interface InventoryListItem {
  item_id:    string
  catalog_id: string
  status:     string
  card: { card_name: string; set_name: string }
}

interface SalePoint {
  date:   string
  price:  number
  title:  string
  graded: boolean
}

interface Comp {
  id:         string
  sale_price: number
  days_ago:   number
  condition:  string
}

interface PriceBand {
  label:            string
  list_price:       number
  net_proceeds:     number
  est_days_to_sell: number | null
  confidence:       number
}

interface ListingPriceResponse {
  status:     string
  card_name:  string
  comp_count: number
  fair_value: number
  bands:      PriceBand[]
  reasoning:  string
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function usd(v: number)       { return `$${v.toFixed(2)}` }
function daysSince(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
}

const BAND_META: Record<string, {
  icon: any; color: string; bg: string; border: string; desc: string
}> = {
  'Quick Sale':  { icon: Zap,        color: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/20',   desc: 'Sells fast — best if you need cash now' },
  'Fair Market': { icon: Target,     color: 'text-indigo-400',  bg: 'bg-indigo-500/10',  border: 'border-indigo-500/20',  desc: 'Balanced speed vs. net proceeds' },
  'Stretch':     { icon: TrendingUp, color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', desc: 'Maximum net — requires patience' },
}

// ─────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────

export default function ListingPricePage() {
  // Card selection
  const [inventory,     setInventory]     = useState<InventoryListItem[]>([])
  const [selectedItem,  setSelectedItem]  = useState<InventoryListItem | null>(null)
  const [manualName,    setManualName]    = useState('')
  const [dropdownOpen,  setDropdownOpen]  = useState(false)

  // Comps
  const [comps,         setComps]         = useState<Comp[]>([])
  const [loadingComps,  setLoadingComps]  = useState(false)
  const [newPrice,      setNewPrice]      = useState('')
  const [newDays,       setNewDays]       = useState('')
  const [newCond,       setNewCond]       = useState('NM')

  // Settings
  const [showSettings,  setShowSettings]  = useState(false)
  const [urgencyDays,   setUrgencyDays]   = useState('')
  const [minNet,        setMinNet]        = useState('')
  const [shippingCost,  setShippingCost]  = useState('4.00')
  const [marketplaceFee, setMarketplaceFee] = useState('13.25')

  // Result
  const [result,        setResult]        = useState<ListingPriceResponse | null>(null)
  const [running,       setRunning]       = useState(false)
  const [error,         setError]         = useState<string | null>(null)

  // ── Load inventory ──────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/inventory')
      .then(r => r.json())
      .then(({ items }: { items: InventoryListItem[] }) => {
        setInventory((items ?? []).filter(i => i.status === 'owned'))
      })
      .catch(() => {})
  }, [])

  // ── Auto-fetch comps when card selected ─────────────────────────
  async function fetchComps(catalogId: string) {
    setLoadingComps(true)
    setComps([])
    setResult(null)
    try {
      const res  = await fetch(`/api/cards/sold-history?catalogId=${catalogId}`)
      const data = await res.json()
      const points: SalePoint[] = data.points ?? []
      // Use raw (non-graded) sales only, within 90 days
      const raw = points
        .filter(p => !p.graded)
        .map((p, i): Comp => ({
          id:         `auto-${i}`,
          sale_price: p.price,
          days_ago:   daysSince(p.date),
          condition:  'NM',
        }))
        .filter(c => c.days_ago <= 90)
      setComps(raw)
    } catch {
      setError('Failed to fetch sales history.')
    } finally {
      setLoadingComps(false)
    }
  }

  function selectCard(item: InventoryListItem) {
    setSelectedItem(item)
    setManualName('')
    setDropdownOpen(false)
    setResult(null)
    fetchComps(item.catalog_id)
  }

  // ── Comp management ─────────────────────────────────────────────
  function addComp() {
    const price = parseFloat(newPrice)
    const days  = parseInt(newDays)
    if (!price || price <= 0) { setError('Enter a valid sale price.'); return }
    setComps(prev => [...prev, {
      id:         `manual-${Date.now()}`,
      sale_price: price,
      days_ago:   isNaN(days) ? 0 : days,
      condition:  newCond,
    }])
    setNewPrice('')
    setNewDays('')
    setResult(null)
    setError(null)
  }

  function removeComp(id: string) {
    setComps(prev => prev.filter(c => c.id !== id))
    setResult(null)
  }

  function updateComp(id: string, field: 'sale_price' | 'days_ago', val: string) {
    setComps(prev => prev.map(c =>
      c.id === id ? { ...c, [field]: field === 'sale_price' ? parseFloat(val) || 0 : parseInt(val) || 0 } : c
    ))
    setResult(null)
  }

  const cardName = selectedItem?.card.card_name ?? manualName

  // ── Run optimizer ───────────────────────────────────────────────
  async function runOptimizer() {
    if (!cardName.trim()) { setError('Enter or select a card name.'); return }
    if (comps.length === 0) { setError('Add at least one comp.'); return }
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const payload = {
        card_id:         selectedItem?.item_id ?? 'manual',
        card_name:       cardName,
        condition:       'NM',
        comps:           comps.map(c => ({
          sale_price: c.sale_price,
          days_ago:   c.days_ago,
          condition:  c.condition,
        })),
        urgency_days:    urgencyDays   ? parseInt(urgencyDays)       : null,
        min_net:         minNet        ? parseFloat(minNet)          : null,
        marketplace_fee: (parseFloat(marketplaceFee) || 13.25) / 100,
        shipping_cost:   parseFloat(shippingCost) || 4.0,
      }
      const res  = await fetch('/api/optimize/listing-price', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) setError(data?.detail ?? data?.error ?? 'Optimizer error.')
      else setResult(data)
    } catch (e: any) {
      setError(e?.message ?? 'Network error')
    } finally {
      setRunning(false)
    }
  }

  // ── Comp stats ──────────────────────────────────────────────────
  const compStats = useMemo(() => {
    if (comps.length === 0) return null
    const prices = comps.map(c => c.sale_price)
    return {
      min:    Math.min(...prices),
      max:    Math.max(...prices),
      avg:    prices.reduce((s, p) => s + p, 0) / prices.length,
      count:  prices.length,
    }
  }, [comps])

  // ─────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen p-6 space-y-6"
      style={{ background: 'linear-gradient(135deg, #0d1117 0%, #0f1623 50%, #0d1117 100%)' }}>

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl"
              style={{ background: 'linear-gradient(135deg, #f97316, #c2410c)' }}>
              <Tag className="h-5 w-5 text-white" />
            </div>
            <h1 className="text-xl font-bold text-white">Listing Price Optimizer</h1>
          </div>
          <p className="text-sm text-white/40 ml-12">
            Recency-weighted comp analysis — get Quick Sale, Fair Market, and Stretch price bands.
          </p>
        </div>
        <button
          onClick={() => setShowSettings(v => !v)}
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all',
            showSettings
              ? 'border-orange-500/40 bg-orange-500/10 text-orange-300'
              : 'border-white/10 bg-white/5 text-white/50 hover:text-white/80',
          )}
        >
          <Settings2 className="h-3.5 w-3.5" />
          Settings
        </button>
      </div>

      {/* ── Settings panel ── */}
      {showSettings && (
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <p className="text-xs font-semibold text-white/40 uppercase tracking-widest mb-4">Fee & Urgency Settings</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Marketplace fee', value: marketplaceFee, onChange: setMarketplaceFee, suffix: '%', hint: 'eBay default 13.25%' },
              { label: 'Shipping cost',   value: shippingCost,   onChange: setShippingCost,   prefix: '$', hint: 'Deducted from net' },
              { label: 'Must sell within', value: urgencyDays,   onChange: setUrgencyDays,    suffix: 'days', hint: 'Adjusts bands downward', placeholder: 'None' },
              { label: 'Min net proceeds', value: minNet,        onChange: setMinNet,          prefix: '$', hint: 'Hides bands below floor', placeholder: 'None' },
            ].map(({ label, value, onChange, prefix, suffix, hint, placeholder }) => (
              <div key={label} className="space-y-1.5">
                <label className="text-xs text-white/50">{label}</label>
                <label className="relative flex items-center">
                  {prefix && <span className="absolute left-2.5 text-xs text-white/30 pointer-events-none">{prefix}</span>}
                  <input
                    type="number"
                    value={value}
                    placeholder={placeholder}
                    onChange={e => onChange(e.target.value)}
                    className={cn(
                      'w-full rounded-lg border border-white/10 bg-white/5 text-white text-xs py-1.5',
                      'placeholder:text-white/20 focus:outline-none focus:ring-1 focus:ring-orange-500/50',
                      'focus:border-orange-500/30 transition-colors',
                      prefix ? 'pl-5 pr-2.5' : suffix ? 'pl-2.5 pr-8' : 'px-2.5',
                    )}
                  />
                  {suffix && <span className="absolute right-2.5 text-xs text-white/30 pointer-events-none">{suffix}</span>}
                </label>
                <p className="text-[10px] text-white/25">{hint}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3">
          <AlertCircle className="h-4 w-4 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-300">{error}</p>
          <button onClick={() => setError(null)} className="ml-auto text-red-400/50 hover:text-red-400 text-xs">✕</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Left: Card + Comps ── */}
        <div className="space-y-4">

          {/* Card selection */}
          <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-5 space-y-4">
            <p className="text-xs font-semibold text-white/40 uppercase tracking-widest">Card</p>

            {/* Inventory picker */}
            {inventory.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setDropdownOpen(v => !v)}
                  className="w-full flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-left transition-colors hover:bg-white/8"
                >
                  <span className={selectedItem ? 'text-white' : 'text-white/30'}>
                    {selectedItem ? selectedItem.card.card_name : 'Pick from inventory…'}
                  </span>
                  <ChevronDown className={cn('h-4 w-4 text-white/30 flex-shrink-0 transition-transform', dropdownOpen && 'rotate-180')} />
                </button>
                {dropdownOpen && (
                  <div className="absolute top-full left-0 right-0 mt-1 z-20 rounded-xl border border-white/10 bg-[#0f1623] shadow-2xl overflow-hidden max-h-56 overflow-y-auto">
                    {inventory.map(item => (
                      <button
                        key={item.item_id}
                        onClick={() => selectCard(item)}
                        className="w-full text-left px-3 py-2.5 text-sm hover:bg-white/8 transition-colors border-b border-white/[0.04] last:border-0"
                      >
                        <p className="text-white/80 font-medium truncate">{item.card.card_name}</p>
                        <p className="text-[11px] text-white/35">{item.card.set_name}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Manual name */}
            <div className="space-y-1.5">
              <label className="text-xs text-white/40">
                {inventory.length > 0 ? 'Or enter name manually' : 'Card name'}
              </label>
              <input
                type="text"
                value={manualName}
                placeholder="e.g. Charizard Base Set Holo"
                onChange={e => { setManualName(e.target.value); setSelectedItem(null); setResult(null) }}
                className="w-full rounded-lg border border-white/10 bg-white/5 text-white text-sm px-3 py-2 placeholder:text-white/20 focus:outline-none focus:ring-1 focus:ring-orange-500/50 focus:border-orange-500/30 transition-colors"
              />
            </div>
          </div>

          {/* Comps table */}
          <div className="rounded-2xl border border-white/8 bg-white/[0.02] overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/6">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-white/50 uppercase tracking-widest">
                  Comps {comps.length > 0 && `(${comps.length})`}
                </span>
                {loadingComps && <Loader2 className="h-3.5 w-3.5 text-white/30 animate-spin" />}
                {selectedItem && !loadingComps && (
                  <button
                    onClick={() => fetchComps(selectedItem.catalog_id)}
                    className="text-white/25 hover:text-white/50 transition-colors"
                    title="Refresh comps"
                  >
                    <RefreshCw className="h-3 w-3" />
                  </button>
                )}
              </div>
              {compStats && (
                <span className="text-[11px] text-white/30">
                  Range: <span className="text-white/50">{usd(compStats.min)} – {usd(compStats.max)}</span>
                  {' '}· Avg: <span className="text-white/50">{usd(compStats.avg)}</span>
                </span>
              )}
            </div>

            {/* Comp rows */}
            {comps.length > 0 ? (
              <div className="divide-y divide-white/[0.04] max-h-64 overflow-y-auto">
                {comps.map(comp => (
                  <div key={comp.id} className="flex items-center gap-2 px-4 py-2">
                    <label className="relative flex-shrink-0 w-24">
                      <span className="absolute left-2 text-[10px] text-white/30 pointer-events-none top-1/2 -translate-y-1/2">$</span>
                      <input
                        type="number"
                        value={comp.sale_price}
                        onChange={e => updateComp(comp.id, 'sale_price', e.target.value)}
                        className="w-full rounded border border-white/10 bg-white/5 text-white text-xs pl-4 pr-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-orange-500/40"
                      />
                    </label>
                    <label className="relative flex-shrink-0 w-20">
                      <input
                        type="number"
                        value={comp.days_ago}
                        onChange={e => updateComp(comp.id, 'days_ago', e.target.value)}
                        className="w-full rounded border border-white/10 bg-white/5 text-white text-xs px-2 py-1 focus:outline-none focus:ring-1 focus:ring-orange-500/40"
                      />
                      <span className="absolute right-2 text-[10px] text-white/30 pointer-events-none top-1/2 -translate-y-1/2">d ago</span>
                    </label>
                    <span className="flex-1 text-[11px] text-white/25 truncate">{comp.condition}</span>
                    <button onClick={() => removeComp(comp.id)}
                      className="text-white/20 hover:text-red-400 transition-colors flex-shrink-0">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-6 text-center text-white/25 text-sm">
                {loadingComps ? 'Fetching sold history…' : 'No comps yet — select a card or add manually below'}
              </div>
            )}

            {/* Add comp row */}
            <div className="flex items-center gap-2 px-4 py-3 border-t border-white/6 bg-white/[0.01]">
              <label className="relative flex-shrink-0 w-24">
                <span className="absolute left-2 text-[10px] text-white/30 pointer-events-none top-1/2 -translate-y-1/2">$</span>
                <input
                  type="number"
                  value={newPrice}
                  placeholder="Price"
                  onChange={e => setNewPrice(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addComp()}
                  className="w-full rounded border border-white/10 bg-white/5 text-white text-xs pl-4 pr-1.5 py-1.5 placeholder:text-white/20 focus:outline-none focus:ring-1 focus:ring-orange-500/40"
                />
              </label>
              <label className="relative flex-shrink-0 w-20">
                <input
                  type="number"
                  value={newDays}
                  placeholder="Days"
                  onChange={e => setNewDays(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addComp()}
                  className="w-full rounded border border-white/10 bg-white/5 text-white text-xs px-2 py-1.5 placeholder:text-white/20 focus:outline-none focus:ring-1 focus:ring-orange-500/40"
                />
                <span className="absolute right-2 text-[10px] text-white/30 pointer-events-none top-1/2 -translate-y-1/2">d ago</span>
              </label>
              <select
                value={newCond}
                onChange={e => setNewCond(e.target.value)}
                className="flex-1 rounded border border-white/10 bg-white/5 text-white/60 text-xs px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-orange-500/40"
              >
                {['NM','LP','MP','HP','DMG'].map(c => (
                  <option key={c} value={c} className="bg-[#0f1623]">{c}</option>
                ))}
              </select>
              <button
                onClick={addComp}
                className="flex-shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-all hover:scale-105"
                style={{ background: 'linear-gradient(135deg, #f97316, #c2410c)' }}
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </button>
            </div>
          </div>

          {/* Run button */}
          <button
            onClick={runOptimizer}
            disabled={running || comps.length === 0 || !cardName.trim()}
            className={cn(
              'w-full flex items-center justify-center gap-2.5 py-3 rounded-2xl text-sm font-semibold',
              'transition-all duration-200',
              running || comps.length === 0 || !cardName.trim()
                ? 'bg-white/5 text-white/25 cursor-not-allowed'
                : 'text-white hover:scale-[1.01] active:scale-[0.99]',
            )}
            style={running || comps.length === 0 || !cardName.trim() ? {} : {
              background: 'linear-gradient(135deg, #f97316, #c2410c)',
              boxShadow:  '0 4px 24px rgba(249,115,22,0.35)',
            }}
          >
            {running
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Calculating…</>
              : <><Play className="h-4 w-4" /> Get Price Recommendation</>}
          </button>
        </div>

        {/* ── Right: Results ── */}
        <div className="space-y-4">
          {result ? (
            <>
              {/* Header */}
              <div className="rounded-2xl border border-white/8 bg-white/[0.02] px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-white">{result.card_name}</p>
                    <p className="text-xs text-white/40 mt-0.5">
                      Fair value: <span className="text-white/70 font-medium">{usd(result.fair_value)}</span>
                      {' '}· {result.comp_count} comp{result.comp_count !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <CheckCircle2 className="h-5 w-5 text-emerald-400 flex-shrink-0 mt-0.5" />
                </div>
                <p className="text-[11px] text-white/30 mt-2 leading-relaxed">{result.reasoning}</p>
              </div>

              {/* Price bands */}
              {result.bands.map(band => {
                const meta = BAND_META[band.label]
                if (!meta) return null
                const Icon = meta.icon
                const confPct = Math.round(band.confidence * 100)

                return (
                  <div key={band.label}
                    className={cn('rounded-2xl border p-5', meta.bg, meta.border)}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          'w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0',
                          meta.bg, 'border', meta.border,
                        )}>
                          <Icon className={cn('h-5 w-5', meta.color)} />
                        </div>
                        <div>
                          <p className={cn('text-base font-bold', meta.color)}>{band.label}</p>
                          <p className="text-xs text-white/35">{meta.desc}</p>
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-2xl font-bold text-white">{usd(band.list_price)}</p>
                        <p className="text-xs text-white/40">list price</p>
                      </div>
                    </div>

                    <div className="mt-4 grid grid-cols-3 gap-3">
                      <div className="rounded-lg border border-white/8 bg-black/20 px-3 py-2 text-center">
                        <p className="text-[10px] text-white/35 uppercase tracking-widest mb-1">Net proceeds</p>
                        <p className="text-sm font-bold text-white">{usd(band.net_proceeds)}</p>
                      </div>
                      <div className="rounded-lg border border-white/8 bg-black/20 px-3 py-2 text-center">
                        <p className="text-[10px] text-white/35 uppercase tracking-widest mb-1">Est. days to sell</p>
                        <p className="text-sm font-bold text-white">
                          {band.est_days_to_sell != null ? `${band.est_days_to_sell}d` : '—'}
                        </p>
                      </div>
                      <div className="rounded-lg border border-white/8 bg-black/20 px-3 py-2 text-center">
                        <p className="text-[10px] text-white/35 uppercase tracking-widest mb-1">Confidence</p>
                        <div className="flex items-center justify-center gap-1.5">
                          <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                            <div
                              className={cn('h-full rounded-full', meta.color.replace('text-', 'bg-').replace('400', '500'))}
                              style={{ width: `${confPct}%` }}
                            />
                          </div>
                          <span className="text-xs font-bold text-white">{confPct}%</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </>
          ) : (
            <div className="rounded-2xl border border-white/8 bg-white/[0.02] flex flex-col items-center justify-center py-20 gap-3 text-white/25">
              <Tag className="h-10 w-10 opacity-30" />
              <p className="text-sm">Select a card and add comps to get price recommendations</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
