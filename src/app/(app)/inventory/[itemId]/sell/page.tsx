'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, Copy, CheckCheck, TrendingUp, TrendingDown,
  Minus, Zap, Clock, DollarSign, BarChart2, ExternalLink,
  RefreshCw, AlertTriangle, Shield,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Intel {
  sellScore:           number
  grade:               string
  urgency:             'sell_now' | 'sell_soon' | 'hold' | 'strong_hold'
  optimalPrice:        number
  priceConfidenceLow:  number
  priceConfidenceHigh: number
  trendDirection:      'rising' | 'falling' | 'stable'
  title:               string
  description:         string
  analysis:            string
  recommendation:      string
  sellReasons:         string[]
  holdReasons:         string[]
  estDaysToSell:       number
}

interface Stats {
  count30d:     number
  p10: number; p25: number; p50: number; p75: number; p90: number
  trendPct:     number
  recentMedian: number
  allTimeMin:   number
  allTimeMax:   number
}

interface ChartPoint { price: number; count: number }

interface SellIntelResult {
  card:       { card_name: string; set_name?: string | null; card_number?: string | null; condition?: string | null }
  keyword:    string
  compsCount: number
  stats:      Stats
  chartData:  ChartPoint[]
  intel:      Intel
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtUsd(n: number) {
  return n >= 1000 ? `$${(n / 1000).toFixed(2)}k` : `$${n.toFixed(2)}`
}

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyBtn({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }}
      className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-white/40 hover:text-white/70 hover:bg-white/8 transition-all"
    >
      {copied
        ? <><CheckCheck className="h-3 w-3 text-emerald-400" /> Copied</>
        : <><Copy className="h-3 w-3" /> {label}</>
      }
    </button>
  )
}

// ── Sell Score Ring ───────────────────────────────────────────────────────────

function SellScoreRing({ score, grade, urgency }: { score: number; grade: string; urgency: string }) {
  const radius       = 45
  const circumference = 2 * Math.PI * radius   // ≈ 283
  const fillRatio    = score / 10
  const targetOffset = circumference * (1 - fillRatio)

  const color =
    urgency === 'sell_now'   ? '#4ade80' :
    urgency === 'sell_soon'  ? '#60a5fa' :
    urgency === 'hold'       ? '#fbbf24' : '#f87171'

  const urgencyLabel: Record<string, string> = {
    sell_now:    'SELL NOW',
    sell_soon:   'SELL SOON',
    hold:        'HOLD',
    strong_hold: 'STRONG HOLD',
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative w-28 h-28">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
          {/* Track */}
          <circle cx="50" cy="50" r={radius} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" />
          {/* Fill */}
          <circle
            cx="50" cy="50" r={radius}
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={targetOffset}
            className="sell-score-ring transition-all duration-1000 ease-out"
            style={{ '--target-offset': targetOffset } as React.CSSProperties}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-black tabular-nums" style={{ color }}>
            {score.toFixed(1)}
          </span>
          <span className="text-[10px] font-bold" style={{ color }}>{grade}</span>
        </div>
      </div>
      <span className="text-[10px] font-black uppercase tracking-widest" style={{ color }}>
        {urgencyLabel[urgency] ?? urgency}
      </span>
    </div>
  )
}

// ── Price Distribution Bar Chart ──────────────────────────────────────────────

function PriceDistChart({ data, optimalPrice }: { data: ChartPoint[]; optimalPrice: number }) {
  if (!data.length) return null
  const maxCount = Math.max(...data.map(d => d.count))

  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-widest text-white/30 font-semibold">Price Distribution</p>
      <div className="flex items-end gap-0.5 h-16">
        {data.map(({ price, count }) => {
          const height = `${Math.round((count / maxCount) * 100)}%`
          const isOptimal = Math.abs(price - optimalPrice) <= 2.5
          return (
            <div key={price} className="flex-1 flex flex-col items-center gap-0.5 group relative">
              <div
                className="w-full rounded-t transition-all"
                style={{
                  height,
                  background: isOptimal
                    ? 'oklch(0.62 0.2 250 / 0.9)'
                    : 'oklch(0.62 0.2 250 / 0.25)',
                  minHeight: 2,
                }}
              />
              {/* Tooltip on hover */}
              <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-black/90 rounded px-1.5 py-0.5 text-[9px] text-white/80 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                ${price} × {count}
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex justify-between text-[9px] text-white/20 tabular-nums">
        <span>${data[0]?.price}</span>
        <span className="text-indigo-400/70 font-semibold">▲ ${optimalPrice.toFixed(2)} optimal</span>
        <span>${data[data.length - 1]?.price}</span>
      </div>
    </div>
  )
}

// ── Percentile Bar ────────────────────────────────────────────────────────────

function PercentileBar({ stats, optimalPrice }: { stats: Stats; optimalPrice: number }) {
  const min = stats.p10
  const max = stats.p90
  const range = max - min || 1

  const pct = (v: number) => Math.max(0, Math.min(100, ((v - min) / range) * 100))
  const optPct = pct(optimalPrice)

  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-widest text-white/30 font-semibold">Comp Range · P10–P90</p>
      <div className="relative h-2 rounded-full bg-white/8">
        {/* IQR band */}
        <div
          className="absolute top-0 h-full rounded-full bg-indigo-400/20"
          style={{ left: `${pct(stats.p25)}%`, width: `${pct(stats.p75) - pct(stats.p25)}%` }}
        />
        {/* Median tick */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 bg-white/40 rounded-full"
          style={{ left: `${pct(stats.p50)}%` }}
        />
        {/* Optimal price marker */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-indigo-400 ring-2 ring-indigo-400/30 shadow-lg shadow-indigo-400/40"
          style={{ left: `${optPct}%`, transform: `translateX(-50%) translateY(-50%)` }}
        />
      </div>
      <div className="flex justify-between text-[9px] text-white/25 tabular-nums">
        <span>{fmtUsd(stats.p10)}<br/><span className="text-white/15">P10</span></span>
        <span className="text-center">{fmtUsd(stats.p50)}<br/><span className="text-white/15">Median</span></span>
        <span className="text-right">{fmtUsd(stats.p90)}<br/><span className="text-white/15">P90</span></span>
      </div>
    </div>
  )
}

// ── Editable field ────────────────────────────────────────────────────────────

function EditableField({
  label, value, onChange, maxChars, mono = false, multiline = false,
}: {
  label: string; value: string; onChange: (v: string) => void
  maxChars?: number; mono?: boolean; multiline?: boolean
}) {
  const over = maxChars ? value.length > maxChars : false
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-widest text-white/30 font-semibold">{label}</p>
        <div className="flex items-center gap-2">
          {maxChars && (
            <span className={`text-[10px] tabular-nums font-mono ${over ? 'text-red-400' : 'text-white/25'}`}>
              {value.length}/{maxChars}
            </span>
          )}
          <CopyBtn text={value} />
        </div>
      </div>
      {multiline ? (
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          rows={7}
          className={`w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm resize-none
            focus:outline-none focus:border-indigo-400/30 focus:bg-indigo-400/[0.03] transition-all
            leading-relaxed ${mono ? 'font-mono text-xs' : ''}`}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          className={`w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm
            focus:outline-none focus:border-indigo-400/30 focus:bg-indigo-400/[0.03] transition-all
            ${over ? 'border-red-400/40' : ''} ${mono ? 'font-mono' : ''}`}
        />
      )}
    </div>
  )
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-5 animate-pulse">
      <div className="h-7 w-48 rounded-lg bg-white/6" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[1,2,3].map(i => <div key={i} className="h-40 rounded-2xl bg-white/4" />)}
      </div>
      <div className="h-56 rounded-2xl bg-white/4" />
      <div className="h-32 rounded-2xl bg-white/4" />
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SellIntelPage() {
  const { itemId } = useParams<{ itemId: string }>()

  const [result,   setResult]   = useState<SellIntelResult | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)

  // Editable listing fields
  const [title, setTitle]             = useState('')
  const [description, setDescription] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/ebay/sell-intel', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ itemId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to generate intelligence')
      setResult(data)
      setTitle(data.intel.title ?? '')
      setDescription(data.intel.description ?? '')
    } catch (e: any) {
      setError(e.message ?? 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [itemId])

  useEffect(() => { load() }, [load])

  const ebaySearchUrl = result
    ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(result.keyword)}&_sacat=0`
    : '#'

  const ebayListUrl = 'https://www.ebay.com/sl/list'

  const allText = result ? [
    `TITLE:\n${title}`,
    `SUGGESTED PRICE: $${result.intel.optimalPrice.toFixed(2)}`,
    `CONDITION: ${result.card.condition ?? 'Near Mint'}`,
    `\nDESCRIPTION:\n${description}`,
  ].join('\n\n') : ''

  if (loading) return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-sm text-white/40">
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        Analyzing eBay market data…
      </div>
      <LoadingSkeleton />
    </div>
  )

  if (error) return (
    <div className="max-w-2xl mx-auto space-y-4">
      <Link href={`/inventory/${itemId}`} className="flex items-center gap-2 text-sm text-white/40 hover:text-white/70 transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back
      </Link>
      <div className="rounded-2xl border border-red-400/20 bg-red-400/[0.04] p-5 flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-red-300">Could not generate sell intelligence</p>
          <p className="text-xs text-white/40 mt-1">{error}</p>
          <button onClick={load} className="mt-3 flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
            <RefreshCw className="h-3 w-3" /> Try again
          </button>
        </div>
      </div>
    </div>
  )

  if (!result) return null
  const { intel, stats, chartData, card, compsCount } = result

  const TrendIcon = intel.trendDirection === 'rising' ? TrendingUp : intel.trendDirection === 'falling' ? TrendingDown : Minus
  const trendColor = intel.trendDirection === 'rising' ? 'text-emerald-400' : intel.trendDirection === 'falling' ? 'text-red-400' : 'text-white/40'

  return (
    <div className="max-w-2xl mx-auto space-y-5 pb-10">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href={`/inventory/${itemId}`} className="text-white/30 hover:text-white/70 transition-colors">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-lg font-bold tracking-tight">Sell Intelligence</h1>
            <p className="text-xs text-white/35">{card.card_name}{card.set_name ? ` · ${card.set_name}` : ''}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-white/8 transition-colors text-white/30 hover:text-white/60">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <a href={ebaySearchUrl} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-white/10 bg-white/[0.04] hover:bg-white/8 transition-all text-white/60 hover:text-white/90">
            <ExternalLink className="h-3.5 w-3.5" /> eBay comps
          </a>
        </div>
      </div>

      {/* ── Intelligence row ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">

        {/* Sell score */}
        <div className="col-span-1 rounded-2xl border border-white/8 bg-white/[0.025] p-4 flex flex-col items-center justify-center gap-2">
          <SellScoreRing score={intel.sellScore} grade={intel.grade} urgency={intel.urgency} />
        </div>

        {/* Market pulse */}
        <div className="col-span-2 rounded-2xl border border-white/8 bg-white/[0.025] p-4 space-y-3">
          <p className="text-[10px] uppercase tracking-widest text-white/30 font-semibold">Market Pulse</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {[
              { label: 'Sold / 30d', value: String(stats.count30d), icon: BarChart2 },
              { label: 'Median price', value: fmtUsd(stats.p50), icon: DollarSign },
              { label: '30d trend', value: `${stats.trendPct >= 0 ? '+' : ''}${stats.trendPct}%`, icon: TrendIcon, colorClass: trendColor },
              { label: 'Est. days to sell', value: `~${intel.estDaysToSell}d`, icon: Clock },
            ].map(({ label, value, icon: Icon, colorClass }) => (
              <div key={label}>
                <p className="text-[10px] text-white/25">{label}</p>
                <p className={`text-sm font-bold tabular-nums ${colorClass ?? 'text-white/80'} flex items-center gap-1`}>
                  <Icon className="h-3 w-3 shrink-0 opacity-50" />
                  {value}
                </p>
              </div>
            ))}
          </div>
          <PercentileBar stats={stats} optimalPrice={intel.optimalPrice} />
        </div>
      </div>

      {/* ── Optimal price + chart ────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-indigo-400/15 bg-indigo-400/[0.04] p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-indigo-300/60 font-semibold">Optimal Listing Price</p>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-3xl font-black tabular-nums text-white">{fmtUsd(intel.optimalPrice)}</span>
              <span className="text-xs text-white/35">
                confidence: {fmtUsd(intel.priceConfidenceLow)} – {fmtUsd(intel.priceConfidenceHigh)}
              </span>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-white/25">vs median</p>
            <p className={`text-sm font-bold tabular-nums ${intel.optimalPrice >= stats.p50 ? 'text-emerald-400' : 'text-red-400'}`}>
              {intel.optimalPrice >= stats.p50 ? '+' : ''}{fmtUsd(intel.optimalPrice - stats.p50)}
            </p>
          </div>
        </div>
        {chartData.length > 0 && <PriceDistChart data={chartData} optimalPrice={intel.optimalPrice} />}
        <p className="text-xs text-white/25 text-center">{compsCount} eBay sold comps analyzed</p>
      </div>

      {/* ── AI Analysis ──────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Zap className="h-3.5 w-3.5 text-amber-400/70" />
          <p className="text-[10px] uppercase tracking-widest text-white/30 font-semibold">AI Market Analysis</p>
        </div>
        <p className="text-sm text-white/70 leading-relaxed">{intel.analysis}</p>
        <div className="pt-1 border-t border-white/6">
          <p className="text-xs font-semibold text-indigo-300/80">{intel.recommendation}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          {intel.sellReasons?.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-widest text-emerald-400/50 font-semibold flex items-center gap-1">
                <TrendingUp className="h-3 w-3" /> Sell Signals
              </p>
              {intel.sellReasons.map((r, i) => (
                <p key={i} className="text-xs text-white/45 flex items-start gap-1.5">
                  <span className="text-emerald-400/60 mt-0.5 shrink-0">•</span>{r}
                </p>
              ))}
            </div>
          )}
          {intel.holdReasons?.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-widest text-amber-400/50 font-semibold flex items-center gap-1">
                <Shield className="h-3 w-3" /> Hold Signals
              </p>
              {intel.holdReasons.map((r, i) => (
                <p key={i} className="text-xs text-white/45 flex items-start gap-1.5">
                  <span className="text-amber-400/60 mt-0.5 shrink-0">•</span>{r}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Listing Package ──────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-5 space-y-4">
        <p className="text-[10px] uppercase tracking-widest text-white/30 font-semibold">Listing Package</p>

        <EditableField
          label="eBay Title"
          value={title}
          onChange={setTitle}
          maxChars={80}
        />

        <EditableField
          label="Description"
          value={description}
          onChange={setDescription}
          multiline
        />

        {/* Item specifics summary */}
        <div className="flex flex-wrap gap-2">
          {[
            { k: 'Condition', v: card.condition ?? 'Near Mint' },
            { k: 'Set', v: card.set_name ?? '—' },
            { k: 'Card #', v: card.card_number ?? '—' },
          ].map(({ k, v }) => (
            <div key={k} className="flex items-center gap-1.5 rounded-lg border border-white/8 bg-white/[0.03] px-2.5 py-1">
              <span className="text-[10px] text-white/30">{k}:</span>
              <span className="text-[10px] font-medium text-white/65">{v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Actions ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <CopyBtn text={allText} label="Copy full listing" />
        <div className="flex-1" />
        <a
          href={ebayListUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:-translate-y-0.5"
          style={{ background: 'linear-gradient(135deg, #6366f1, #4f46e5)' }}
        >
          <ExternalLink className="h-4 w-4" />
          Open eBay Sell Form
        </a>
      </div>

      <p className="text-[10px] text-white/15 text-center leading-relaxed">
        Price intelligence based on {compsCount} real eBay sold comps.
        Review before posting — adjust condition notes and shipping as needed.
      </p>
    </div>
  )
}
