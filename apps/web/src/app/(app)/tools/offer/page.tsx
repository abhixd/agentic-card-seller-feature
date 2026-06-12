'use client'

/**
 * B2 — Offer Negotiation Advisor
 *
 * EV-based advisor that compares Accept / Counter / Decline outcomes
 * for an incoming buyer offer, choosing the action with the highest
 * expected value given list price, fair value, and days on market.
 */

import { useEffect, useState } from 'react'
import {
  Handshake, Play, Loader2, ChevronDown, AlertCircle,
  CheckCircle2, ArrowLeftRight, XCircle, Settings2,
  TrendingUp, Clock, DollarSign,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

interface InventoryListItem {
  item_id:                string
  catalog_id:             string
  status:                 string
  acquisition_cost:       number
  estimated_market_value: number | null
  card: { card_name: string; set_name: string }
}

interface OfferResponse {
  status:         string
  recommendation: 'accept' | 'counter' | 'decline'
  counter_price:  number | null
  net_if_accept:  number
  net_if_counter: number | null
  ev_accept:      number
  ev_counter:     number | null
  reasoning:      string
}

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

const REC_META = {
  accept: {
    label:  'Accept',
    icon:   CheckCircle2,
    color:  'text-emerald-400',
    bg:     'bg-emerald-500/10',
    border: 'border-emerald-500/25',
    glow:   'rgba(16,185,129,0.2)',
    grad:   ['#10b981', '#047857'],
  },
  counter: {
    label:  'Counter',
    icon:   ArrowLeftRight,
    color:  'text-amber-400',
    bg:     'bg-amber-500/10',
    border: 'border-amber-500/25',
    glow:   'rgba(245,158,11,0.2)',
    grad:   ['#f59e0b', '#b45309'],
  },
  decline: {
    label:  'Decline',
    icon:   XCircle,
    color:  'text-red-400',
    bg:     'bg-red-500/10',
    border: 'border-red-500/25',
    glow:   'rgba(239,68,68,0.2)',
    grad:   ['#ef4444', '#b91c1c'],
  },
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function usd(v: number | null | undefined) {
  if (v == null) return '—'
  return `$${v.toFixed(2)}`
}

function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs text-white/50">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-white/25">{hint}</p>}
    </div>
  )
}

function NumInput({
  value, onChange, placeholder, prefix, suffix, step = 0.01, min = 0,
}: {
  value: string; onChange: (v: string) => void
  placeholder?: string; prefix?: string; suffix?: string
  step?: number; min?: number
}) {
  return (
    <label className="relative flex items-center">
      {prefix && (
        <span className="absolute left-2.5 text-xs text-white/30 pointer-events-none">{prefix}</span>
      )}
      <input
        type="number"
        value={value}
        min={min}
        step={step}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        className={cn(
          'w-full rounded-lg border border-white/10 bg-white/5 text-white text-sm py-2',
          'placeholder:text-white/20 focus:outline-none focus:ring-1 focus:ring-indigo-500/60',
          'focus:border-indigo-500/40 transition-colors',
          prefix ? 'pl-6 pr-3' : suffix ? 'pl-3 pr-8' : 'px-3',
        )}
      />
      {suffix && (
        <span className="absolute right-3 text-xs text-white/30 pointer-events-none">{suffix}</span>
      )}
    </label>
  )
}

// EV comparison bar
function EVBar({
  evAccept, evCounter, evRelist,
}: { evAccept: number; evCounter: number | null; evRelist?: number }) {
  const vals = [evAccept, evCounter ?? -Infinity].filter(v => isFinite(v))
  const max  = Math.max(...vals, 0.01)

  return (
    <div className="space-y-2">
      {[
        { label: 'Accept',  value: evAccept,  color: 'bg-emerald-500' },
        { label: 'Counter', value: evCounter, color: 'bg-amber-500' },
      ].map(({ label, value, color }) => (
        value != null && (
          <div key={label} className="flex items-center gap-3">
            <span className="text-xs text-white/40 w-14 flex-shrink-0">{label}</span>
            <div className="flex-1 h-2 rounded-full bg-white/8 overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all duration-500', color)}
                style={{ width: `${Math.max((value / max) * 100, 2)}%` }}
              />
            </div>
            <span className="text-xs font-medium text-white/70 w-16 text-right">{usd(value)}</span>
          </div>
        )
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────

export default function OfferPage() {
  const [inventory,      setInventory]      = useState<InventoryListItem[]>([])
  const [selectedItem,   setSelectedItem]   = useState<InventoryListItem | null>(null)
  const [dropdownOpen,   setDropdownOpen]   = useState(false)
  const [manualName,     setManualName]     = useState('')

  // Core inputs
  const [listPrice,      setListPrice]      = useState('')
  const [offerPrice,     setOfferPrice]     = useState('')
  const [fairValue,      setFairValue]      = useState('')
  const [daysOnMarket,   setDaysOnMarket]   = useState('')

  // Optional
  const [showSettings,   setShowSettings]   = useState(false)
  const [urgencyDays,    setUrgencyDays]    = useState('')
  const [minNet,         setMinNet]         = useState('')
  const [marketplaceFee, setMarketplaceFee] = useState('13.25')
  const [shippingCost,   setShippingCost]   = useState('4.00')

  const [result,   setResult]   = useState<OfferResponse | null>(null)
  const [running,  setRunning]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  // ── Load inventory ──────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/inventory')
      .then(r => r.json())
      .then(({ items }: { items: InventoryListItem[] }) =>
        setInventory((items ?? []).filter(i => i.status === 'owned' || i.status === 'listed'))
      )
      .catch(() => {})
  }, [])

  // Auto-fill fair value from inventory
  function selectCard(item: InventoryListItem) {
    setSelectedItem(item)
    setManualName('')
    setDropdownOpen(false)
    if (item.estimated_market_value) {
      setFairValue(item.estimated_market_value.toFixed(2))
      setListPrice(item.estimated_market_value.toFixed(2))
    }
    setResult(null)
  }

  const cardName = selectedItem?.card.card_name ?? manualName

  // ── Derived: offer/fair ratio ───────────────────────────────────
  const offerRatio = parseFloat(offerPrice) > 0 && parseFloat(fairValue) > 0
    ? parseFloat(offerPrice) / parseFloat(fairValue)
    : null

  // ── Run optimizer ───────────────────────────────────────────────
  async function runAdvisor() {
    const lp   = parseFloat(listPrice)
    const op   = parseFloat(offerPrice)
    const fv   = parseFloat(fairValue)
    const dom  = parseInt(daysOnMarket)

    if (!cardName.trim()) { setError('Enter or select a card name.'); return }
    if (!lp || lp <= 0)   { setError('Enter a valid list price.'); return }
    if (!op || op <= 0)   { setError('Enter a valid offer price.'); return }
    if (!fv || fv <= 0)   { setError('Enter a valid fair value.'); return }
    if (isNaN(dom))        { setError('Enter days on market.'); return }

    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const payload = {
        card_id:         selectedItem?.item_id ?? 'manual',
        card_name:       cardName,
        list_price:      lp,
        offer_price:     op,
        fair_value:      fv,
        days_on_market:  dom,
        urgency_days:    urgencyDays ? parseInt(urgencyDays)    : null,
        min_net:         minNet      ? parseFloat(minNet)       : null,
        marketplace_fee: (parseFloat(marketplaceFee) || 13.25) / 100,
        shipping_cost:   parseFloat(shippingCost) || 4.0,
      }
      const res  = await fetch('/api/optimize/offer', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) setError(data?.detail ?? data?.error ?? 'Advisor error.')
      else setResult(data)
    } catch (e: any) {
      setError(e?.message ?? 'Network error')
    } finally {
      setRunning(false)
    }
  }

  const canRun = cardName.trim() && listPrice && offerPrice && fairValue && daysOnMarket && !running

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
              style={{ background: 'linear-gradient(135deg, #8b5cf6, #6d28d9)' }}>
              <Handshake className="h-5 w-5 text-white" />
            </div>
            <h1 className="text-xl font-bold text-white">Offer Negotiation Advisor</h1>
          </div>
          <p className="text-sm text-white/40 ml-12">
            EV analysis of Accept / Counter / Decline — finds the highest-value response to any buyer offer.
          </p>
        </div>
        <button
          onClick={() => setShowSettings(v => !v)}
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all',
            showSettings
              ? 'border-violet-500/40 bg-violet-500/10 text-violet-300'
              : 'border-white/10 bg-white/5 text-white/50 hover:text-white/80',
          )}
        >
          <Settings2 className="h-3.5 w-3.5" />
          Settings
        </button>
      </div>

      {/* ── Settings ── */}
      {showSettings && (
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <p className="text-xs font-semibold text-white/40 uppercase tracking-widest mb-4">Fee Settings</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Field label="Marketplace fee" hint="eBay default 13.25%">
              <NumInput value={marketplaceFee} onChange={setMarketplaceFee} suffix="%" step={0.01} />
            </Field>
            <Field label="Shipping cost" hint="Deducted from net proceeds">
              <NumInput value={shippingCost} onChange={setShippingCost} prefix="$" />
            </Field>
            <Field label="Urgency — must sell within" hint="Discounts relist EV if overdue">
              <NumInput value={urgencyDays} onChange={setUrgencyDays} suffix="days" step={1} placeholder="None" />
            </Field>
            <Field label="Minimum net proceeds" hint="Offer below this → auto decline">
              <NumInput value={minNet} onChange={setMinNet} prefix="$" placeholder="None" />
            </Field>
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

        {/* ── Left: Inputs ── */}
        <div className="space-y-5">

          {/* Card */}
          <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-5 space-y-4">
            <p className="text-xs font-semibold text-white/40 uppercase tracking-widest">Card</p>

            {inventory.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setDropdownOpen(v => !v)}
                  className="w-full flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-left hover:bg-white/8 transition-colors"
                >
                  <span className={selectedItem ? 'text-white' : 'text-white/30'}>
                    {selectedItem ? selectedItem.card.card_name : 'Pick from inventory…'}
                  </span>
                  <ChevronDown className={cn('h-4 w-4 text-white/30 flex-shrink-0 transition-transform', dropdownOpen && 'rotate-180')} />
                </button>
                {dropdownOpen && (
                  <div className="absolute top-full left-0 right-0 mt-1 z-20 rounded-xl border border-white/10 bg-[#0f1623] shadow-2xl overflow-hidden max-h-48 overflow-y-auto">
                    {inventory.map(item => (
                      <button
                        key={item.item_id}
                        onClick={() => selectCard(item)}
                        className="w-full text-left px-3 py-2.5 text-sm hover:bg-white/8 transition-colors border-b border-white/[0.04] last:border-0"
                      >
                        <p className="text-white/80 font-medium truncate">{item.card.card_name}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[11px] text-white/35">{item.card.set_name}</span>
                          {item.estimated_market_value && (
                            <span className="text-[11px] text-white/25">· {usd(item.estimated_market_value)}</span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <Field label={inventory.length > 0 ? 'Or enter name manually' : 'Card name'}>
              <input
                type="text"
                value={manualName}
                placeholder="e.g. Charizard Base Set Holo"
                onChange={e => { setManualName(e.target.value); setSelectedItem(null); setResult(null) }}
                className="w-full rounded-lg border border-white/10 bg-white/5 text-white text-sm px-3 py-2 placeholder:text-white/20 focus:outline-none focus:ring-1 focus:ring-violet-500/50 focus:border-violet-500/30 transition-colors"
              />
            </Field>
          </div>

          {/* Offer details */}
          <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-5 space-y-4">
            <p className="text-xs font-semibold text-white/40 uppercase tracking-widest">Offer Details</p>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Your list price" hint="What you&apos;re currently asking">
                <NumInput value={listPrice} onChange={v => { setListPrice(v); setResult(null) }} prefix="$" placeholder="0.00" />
              </Field>
              <Field label="Buyer&apos;s offer" hint="What they offered to pay">
                <NumInput value={offerPrice} onChange={v => { setOfferPrice(v); setResult(null) }} prefix="$" placeholder="0.00" />
              </Field>
              <Field label="Fair market value" hint="Recency-weighted comp median">
                <NumInput value={fairValue} onChange={v => { setFairValue(v); setResult(null) }} prefix="$" placeholder="0.00" />
              </Field>
              <Field label="Days on market" hint="How long the listing has been active">
                <NumInput value={daysOnMarket} onChange={v => { setDaysOnMarket(v); setResult(null) }} suffix="days" step={1} placeholder="0" />
              </Field>
            </div>

            {/* Offer quality indicator */}
            {offerRatio !== null && (
              <div className={cn(
                'flex items-center gap-3 rounded-xl border px-4 py-2.5',
                offerRatio >= 0.90 ? 'border-emerald-500/20 bg-emerald-500/8' :
                offerRatio >= 0.75 ? 'border-amber-500/20 bg-amber-500/8' :
                                     'border-red-500/20 bg-red-500/8',
              )}>
                <DollarSign className={cn('h-4 w-4 flex-shrink-0',
                  offerRatio >= 0.90 ? 'text-emerald-400' :
                  offerRatio >= 0.75 ? 'text-amber-400' : 'text-red-400',
                )} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-white/60">
                    Offer is{' '}
                    <span className={cn('font-semibold',
                      offerRatio >= 0.90 ? 'text-emerald-400' :
                      offerRatio >= 0.75 ? 'text-amber-400' : 'text-red-400',
                    )}>
                      {(offerRatio * 100).toFixed(0)}% of fair value
                    </span>
                    {' '}(
                    {offerRatio >= 0.90 ? 'strong offer' :
                     offerRatio >= 0.75 ? 'reasonable offer' : 'low offer'}
                    )
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Run button */}
          <button
            onClick={runAdvisor}
            disabled={!canRun}
            className={cn(
              'w-full flex items-center justify-center gap-2.5 py-3.5 rounded-2xl text-sm font-semibold',
              'transition-all duration-200',
              !canRun
                ? 'bg-white/5 text-white/25 cursor-not-allowed'
                : 'text-white hover:scale-[1.01] active:scale-[0.99]',
            )}
            style={!canRun ? {} : {
              background: 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
              boxShadow:  '0 4px 24px rgba(139,92,246,0.35)',
            }}
          >
            {running
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Analyzing…</>
              : <><Play className="h-4 w-4" /> Analyze Offer</>}
          </button>
        </div>

        {/* ── Right: Result ── */}
        <div className="space-y-4">
          {result ? (() => {
            const meta = REC_META[result.recommendation]
            const Icon = meta.icon

            return (
              <>
                {/* Decision card */}
                <div className={cn(
                  'rounded-2xl border p-6 space-y-4',
                  meta.bg, meta.border,
                )}
                  style={{ boxShadow: `0 0 40px ${meta.glow}` }}>

                  {/* Recommendation */}
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0"
                      style={{ background: `linear-gradient(135deg, ${meta.grad[0]}, ${meta.grad[1]})` }}>
                      <Icon className="h-7 w-7 text-white" />
                    </div>
                    <div>
                      <p className="text-xs text-white/40 uppercase tracking-widest mb-0.5">Recommendation</p>
                      <p className={cn('text-3xl font-bold', meta.color)}>{meta.label}</p>
                      {result.recommendation === 'counter' && result.counter_price && (
                        <p className="text-sm text-white/60 mt-0.5">
                          at <span className="font-semibold text-white">{usd(result.counter_price)}</span>
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Reasoning */}
                  <p className="text-sm text-white/60 leading-relaxed border-t border-white/8 pt-4">
                    {result.reasoning}
                  </p>
                </div>

                {/* Net proceeds comparison */}
                <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-5 space-y-3">
                  <p className="text-xs font-semibold text-white/40 uppercase tracking-widest">Net Proceeds</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3">
                      <p className="text-[10px] text-white/35 uppercase tracking-widest mb-1">If accept</p>
                      <p className="text-xl font-bold text-white">{usd(result.net_if_accept)}</p>
                      <p className="text-[10px] text-white/25 mt-0.5">certain</p>
                    </div>
                    {result.net_if_counter != null && (
                      <div className="rounded-xl border border-amber-500/15 bg-amber-500/5 px-4 py-3">
                        <p className="text-[10px] text-white/35 uppercase tracking-widest mb-1">If counter accepted</p>
                        <p className="text-xl font-bold text-amber-300">{usd(result.net_if_counter)}</p>
                        <p className="text-[10px] text-white/25 mt-0.5">at {usd(result.counter_price)}</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* EV comparison */}
                <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-5 space-y-4">
                  <p className="text-xs font-semibold text-white/40 uppercase tracking-widest">Expected Value Comparison</p>
                  <EVBar evAccept={result.ev_accept} evCounter={result.ev_counter} />
                  <p className="text-[11px] text-white/25 leading-relaxed">
                    EV accounts for probability of sale at each price, relist success rate,
                    and days-on-market staleness penalty.
                  </p>
                </div>

                {/* Timeline */}
                <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-5">
                  <p className="text-xs font-semibold text-white/40 uppercase tracking-widest mb-3">At a Glance</p>
                  <div className="grid grid-cols-3 gap-3 text-center">
                    {[
                      { icon: DollarSign,    label: 'Offer',    value: usd(parseFloat(offerPrice)), color: 'text-white' },
                      { icon: TrendingUp,    label: 'Fair value', value: usd(parseFloat(fairValue)),  color: 'text-indigo-300' },
                      { icon: Clock,         label: 'On market', value: `${daysOnMarket}d`,           color: 'text-white/60' },
                    ].map(({ icon: Ic, label, value, color }) => (
                      <div key={label} className="rounded-xl border border-white/6 bg-white/[0.02] px-3 py-2.5">
                        <Ic className="h-4 w-4 text-white/25 mx-auto mb-1" />
                        <p className={cn('text-sm font-bold', color)}>{value}</p>
                        <p className="text-[10px] text-white/30">{label}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )
          })() : (
            <div className="rounded-2xl border border-white/8 bg-white/[0.02] flex flex-col items-center justify-center py-24 gap-3 text-white/25">
              <Handshake className="h-12 w-12 opacity-25" />
              <p className="text-sm text-center">Fill in the offer details and click<br />Analyze Offer to get a recommendation</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
