'use client'

import { useState, useEffect } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import {
  Search, X, Loader2, ChevronRight, ChevronLeft,
  TrendingUp, TrendingDown, ShoppingBag, ArrowLeftRight,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SearchResult {
  catalog_id:          string
  card_name:           string
  set_name:            string
  card_number:         string | null
  canonical_image_url: string | null
  metadata_json:       Record<string, unknown>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bestMarketPrice(metadataJson: Record<string, unknown> | null): number | null {
  if (!metadataJson) return null
  const prices = (metadataJson as { tcgplayer?: { prices?: Record<string, { market?: number; mid?: number }> } })
    ?.tcgplayer?.prices
  if (!prices) return null

  let best: number | null = null
  for (const band of Object.values(prices)) {
    if (band?.market && band.market > 0) {
      if (best === null || band.market > best) best = band.market
    }
  }
  if (best !== null) return best
  for (const band of Object.values(prices)) {
    if (band?.mid && band.mid > 0) {
      if (best === null || band.mid > best) best = band.mid
    }
  }
  return best
}

function fmtUsd(n: number) {
  return n >= 1000 ? `$${(n / 1000).toFixed(2)}k` : `$${n.toFixed(2)}`
}

function priceDeltaLabel(delta: number): { text: string; color: string } {
  if (Math.abs(delta) <= 5)  return { text: 'At market price',               color: 'text-emerald-400' }
  if (delta > 20)            return { text: `${delta.toFixed(1)}% above market — may be hard to sell`, color: 'text-red-400' }
  if (delta > 5)             return { text: `${delta.toFixed(1)}% above market`,   color: 'text-yellow-400' }
  if (delta < -20)           return { text: `${Math.abs(delta).toFixed(1)}% below market — HOT DEAL`, color: 'text-emerald-400' }
  return { text: `${Math.abs(delta).toFixed(1)}% below market`,               color: 'text-emerald-400' }
}

// ── Condition options ─────────────────────────────────────────────────────────

const CONDITIONS = [
  { value: 'NM',     label: 'NM',     desc: 'Near Mint' },
  { value: 'LP',     label: 'LP',     desc: 'Lightly Played' },
  { value: 'MP',     label: 'MP',     desc: 'Moderately Played' },
  { value: 'HP',     label: 'HP',     desc: 'Heavily Played' },
  { value: 'D',      label: 'D',      desc: 'Damaged' },
  { value: 'PSA10',  label: 'PSA 10', desc: 'Graded PSA 10' },
  { value: 'PSA9',   label: 'PSA 9',  desc: 'Graded PSA 9' },
  { value: 'BGS9.5', label: 'BGS 9.5', desc: 'Graded BGS 9.5' },
]

function conditionColor(value: string) {
  if (value === 'NM')    return 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
  if (value === 'LP')    return 'border-yellow-500/50 bg-yellow-500/15 text-yellow-300'
  if (value === 'MP')    return 'border-orange-500/50 bg-orange-500/15 text-orange-300'
  if (value === 'HP' || value === 'D') return 'border-red-500/50 bg-red-500/15 text-red-300'
  return 'border-blue-500/50 bg-blue-500/15 text-blue-300'
}

// ── Step 1: Card Search ───────────────────────────────────────────────────────

function StepSearch({ onSelect }: { onSelect: (card: SearchResult) => void }) {
  const [query,     setQuery]     = useState('')
  const [results,   setResults]   = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (query.length < 2) { setResults([]); return }
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const res  = await fetch(`/api/catalog/search?q=${encodeURIComponent(query)}&limit=10`)
        const data = await res.json()
        setResults(data.results ?? [])
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [query])

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-white/85">Step 1 — Find the card</h2>
        <p className="text-xs text-white/30 mt-1">Search the catalog to get real market price data.</p>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/25" />
        <input
          autoFocus
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search for a card (e.g. Charizard, Pikachu ex…)"
          className="w-full rounded-xl border border-white/10 bg-white/[0.04] pl-9 pr-4 py-3 text-sm text-white/80 placeholder:text-white/25 focus:outline-none focus:border-white/20 transition-all"
        />
        {searching && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-white/25" />
        )}
        {query && !searching && (
          <button onClick={() => setQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2">
            <X className="h-4 w-4 text-white/25 hover:text-white/60 transition-colors" />
          </button>
        )}
      </div>

      {results.length > 0 && (
        <div className="rounded-xl border border-white/8 overflow-hidden divide-y divide-white/[0.05]">
          {results.map(r => {
            const price = bestMarketPrice(r.metadata_json)
            return (
              <button
                key={r.catalog_id}
                onClick={() => onSelect(r)}
                className="flex items-center gap-3 w-full px-4 py-3 hover:bg-white/[0.04] transition-colors text-left"
              >
                {r.canonical_image_url
                  ? <Image src={r.canonical_image_url} alt={r.card_name} width={28} height={38} className="rounded shrink-0" unoptimized />
                  : <div className="w-7 h-10 rounded bg-white/5 shrink-0" />
                }
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white/80 truncate">{r.card_name}</p>
                  <p className="text-xs text-white/30 truncate">
                    {r.set_name}{r.card_number ? ` · #${r.card_number}` : ''}
                  </p>
                </div>
                {price && (
                  <span className="text-sm font-bold tabular-nums text-white/60 shrink-0">{fmtUsd(price)}</span>
                )}
                <ChevronRight className="h-4 w-4 text-white/20 shrink-0" />
              </button>
            )
          })}
        </div>
      )}

      {query.length >= 2 && !searching && results.length === 0 && (
        <p className="text-sm text-white/30 text-center py-6">No cards found for &quot;{query}&quot;</p>
      )}
    </div>
  )
}

// ── Step 2: Details ───────────────────────────────────────────────────────────

interface Step2Props {
  card:          SearchResult
  condition:     string
  setCondition:  (v: string) => void
  askingPrice:   string
  setAskingPrice:(v: string) => void
  description:   string
  setDescription:(v: string) => void
  acceptsTrades: boolean
  setAcceptsTrades:(v: boolean) => void
  onBack:        () => void
  onNext:        () => void
}

function StepDetails(props: Step2Props) {
  const {
    card, condition, setCondition, askingPrice, setAskingPrice,
    description, setDescription, acceptsTrades, setAcceptsTrades,
    onBack, onNext,
  } = props

  const market   = bestMarketPrice(card.metadata_json)
  const priceNum = parseFloat(askingPrice)
  const delta    = market && priceNum > 0 ? ((priceNum - market) / market) * 100 : null
  const hint     = delta !== null ? priceDeltaLabel(delta) : null

  const canProceed = condition && priceNum > 0

  return (
    <div className="space-y-6">
      <div>
        <button onClick={onBack} className="flex items-center gap-1 text-white/30 hover:text-white/60 text-sm mb-3 transition-colors">
          <ChevronLeft className="h-4 w-4" />
          Change card
        </button>
        <h2 className="text-lg font-bold text-white/85">Step 2 — Set details</h2>

        {/* Selected card preview */}
        <div className="flex items-center gap-3 mt-3 rounded-xl border border-white/8 bg-white/[0.03] p-3">
          {card.canonical_image_url
            ? <Image src={card.canonical_image_url} alt={card.card_name} width={36} height={50} className="rounded shrink-0" unoptimized />
            : <div className="w-9 h-12 rounded bg-white/5 shrink-0" />
          }
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white/85 truncate">{card.card_name}</p>
            <p className="text-xs text-white/30 truncate">{card.set_name}</p>
          </div>
          {market && (
            <div className="text-right shrink-0">
              <p className="text-xs text-white/25">Market</p>
              <p className="text-sm font-bold text-white/70 tabular-nums">{fmtUsd(market)}</p>
            </div>
          )}
        </div>
      </div>

      {/* Condition */}
      <div className="space-y-2">
        <p className="text-xs uppercase tracking-widest text-white/25 font-semibold">Condition</p>
        <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
          {CONDITIONS.map(c => (
            <button
              key={c.value}
              onClick={() => setCondition(c.value)}
              title={c.desc}
              className={`rounded-xl border py-2 text-xs font-bold transition-all ${
                condition === c.value
                  ? conditionColor(c.value)
                  : 'border-white/8 bg-white/[0.03] text-white/35 hover:text-white/55 hover:border-white/15'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Price */}
      <div className="space-y-2">
        <p className="text-xs uppercase tracking-widest text-white/25 font-semibold">Asking Price</p>
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-white/40 text-lg font-semibold">$</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={askingPrice}
            onChange={e => setAskingPrice(e.target.value)}
            placeholder="0.00"
            className="w-full rounded-xl border border-white/10 bg-white/[0.04] pl-9 pr-4 py-3 text-lg font-bold text-white/85 placeholder:text-white/20 focus:outline-none focus:border-white/20 transition-all"
          />
        </div>

        {/* Real-time market delta hint */}
        {hint && (
          <p className={`text-sm font-semibold ${hint.color}`}>
            {delta !== null && delta > 0
              ? <><TrendingUp className="h-4 w-4 inline mr-1" />{hint.text}</>
              : <><TrendingDown className="h-4 w-4 inline mr-1" />{hint.text}</>
            }
          </p>
        )}
        {market && !askingPrice && (
          <p className="text-xs text-white/25">Market price: {fmtUsd(market)}</p>
        )}
      </div>

      {/* Description */}
      <div className="space-y-2">
        <p className="text-xs uppercase tracking-widest text-white/25 font-semibold">Description <span className="normal-case tracking-normal text-white/20 font-normal">(optional)</span></p>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Add any details about condition, centering, print lines, etc."
          rows={3}
          className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white/70 placeholder:text-white/25 focus:outline-none focus:border-white/20 resize-none transition-all"
        />
      </div>

      {/* Accepts trades toggle */}
      <div
        className="flex items-center justify-between rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 cursor-pointer"
        onClick={() => setAcceptsTrades(!acceptsTrades)}
      >
        <div className="flex items-center gap-3">
          <ArrowLeftRight className="h-4 w-4 text-indigo-400/60" />
          <div>
            <p className="text-sm font-medium text-white/70">Accept trades</p>
            <p className="text-xs text-white/25">Buyers can propose card-for-card trades</p>
          </div>
        </div>
        <div className={`w-10 h-5.5 rounded-full transition-all relative ${acceptsTrades ? 'bg-indigo-600' : 'bg-white/10'}`}
          style={{ minWidth: 40, height: 22 }}>
          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${acceptsTrades ? 'left-[22px]' : 'left-0.5'}`} />
        </div>
      </div>

      <button
        onClick={onNext}
        disabled={!canProceed}
        className="flex items-center justify-center gap-2 w-full rounded-xl py-3 text-sm font-semibold text-white disabled:opacity-40 transition-all btn-primary-glow"
        style={{ background: 'linear-gradient(135deg, #6366f1, #4338ca)' }}
      >
        Preview Listing
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  )
}

// ── Step 3: Preview + Submit ──────────────────────────────────────────────────

interface Step3Props {
  card:          SearchResult
  condition:     string
  askingPrice:   string
  description:   string
  acceptsTrades: boolean
  onBack:        () => void
  onSubmit:      () => Promise<void>
  submitting:    boolean
  error:         string
}

function StepPreview({ card, condition, askingPrice, description, acceptsTrades, onBack, onSubmit, submitting, error }: Step3Props) {
  const market   = bestMarketPrice(card.metadata_json)
  const priceNum = parseFloat(askingPrice)
  const delta    = market && priceNum > 0 ? ((priceNum - market) / market) * 100 : null
  const hint     = delta !== null ? priceDeltaLabel(delta) : null

  return (
    <div className="space-y-5">
      <div>
        <button onClick={onBack} className="flex items-center gap-1 text-white/30 hover:text-white/60 text-sm mb-3 transition-colors">
          <ChevronLeft className="h-4 w-4" />
          Edit details
        </button>
        <h2 className="text-lg font-bold text-white/85">Step 3 — Preview</h2>
        <p className="text-xs text-white/30 mt-1">Review your listing before publishing.</p>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.025] overflow-hidden">
        <div className="flex gap-4 p-4">
          {card.canonical_image_url
            ? <Image src={card.canonical_image_url} alt={card.card_name} width={60} height={84} className="rounded-lg shrink-0" unoptimized />
            : <div className="w-15 h-21 rounded-lg bg-white/5 shrink-0" style={{ width: 60, height: 84 }} />
          }
          <div className="flex-1 min-w-0 space-y-1.5">
            <p className="text-base font-bold text-white/90">{card.card_name}</p>
            <p className="text-xs text-white/35">{card.set_name}</p>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-semibold ${
              condition === 'NM' ? 'border-emerald-500/35 bg-emerald-500/15 text-emerald-400' :
              condition === 'LP' ? 'border-yellow-500/35 bg-yellow-500/15 text-yellow-400' :
              condition === 'MP' ? 'border-orange-500/35 bg-orange-500/15 text-orange-400' :
              condition === 'HP' || condition === 'D' ? 'border-red-500/35 bg-red-500/15 text-red-400' :
              'border-blue-500/35 bg-blue-500/15 text-blue-400'
            }`}>
              {condition}
            </span>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xl font-bold text-white tabular-nums">{fmtUsd(priceNum)}</p>
            {hint && (
              <p className={`text-xs font-semibold mt-1 ${hint.color}`}>{
                delta !== null && Math.abs(delta) > 5
                  ? (delta > 0 ? `+${delta.toFixed(1)}% mkt` : `${Math.abs(delta).toFixed(1)}% deal`)
                  : 'At market'
              }</p>
            )}
          </div>
        </div>

        {description && (
          <div className="border-t border-white/5 px-4 py-3">
            <p className="text-xs text-white/40 leading-relaxed">{description}</p>
          </div>
        )}

        {acceptsTrades && (
          <div className="border-t border-white/5 px-4 py-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-indigo-300/70">
              <ArrowLeftRight className="h-3 w-3" />
              Accepts trades
            </span>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/25 bg-red-500/8 px-4 py-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={onBack}
          className="flex-1 rounded-xl border border-white/10 bg-white/[0.04] py-3 text-sm font-semibold text-white/60 hover:text-white/80 hover:bg-white/[0.06] transition-all"
        >
          Edit
        </button>
        <button
          onClick={onSubmit}
          disabled={submitting}
          className="flex-[2] flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold text-white disabled:opacity-50 transition-all btn-primary-glow"
          style={{ background: 'linear-gradient(135deg, #6366f1, #4338ca)' }}
        >
          {submitting
            ? <><Loader2 className="h-4 w-4 animate-spin" />Publishing…</>
            : <><ShoppingBag className="h-4 w-4" />Publish Listing</>
          }
        </button>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function NewListingPage() {
  const router = useRouter()

  const [step,          setStep]          = useState<1 | 2 | 3>(1)
  const [selectedCard,  setSelectedCard]  = useState<SearchResult | null>(null)
  const [condition,     setCondition]     = useState('NM')
  const [askingPrice,   setAskingPrice]   = useState('')
  const [description,   setDescription]   = useState('')
  const [acceptsTrades, setAcceptsTrades] = useState(false)
  const [submitting,    setSubmitting]    = useState(false)
  const [error,         setError]         = useState('')

  const handleSubmit = async () => {
    if (!selectedCard) return
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('/api/marketplace/listings', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          catalog_id:    selectedCard.catalog_id,
          condition,
          asking_price:  parseFloat(askingPrice),
          description:   description || undefined,
          accepts_trades: acceptsTrades,
          image_urls:    [],
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Failed to create listing'); return }
      router.push(`/marketplace/${data.id}`)
    } finally {
      setSubmitting(false)
    }
  }

  // Step indicators
  const steps = [
    { n: 1, label: 'Find card' },
    { n: 2, label: 'Details' },
    { n: 3, label: 'Preview' },
  ]

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-12">

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <ShoppingBag className="h-5 w-5 text-indigo-400" />
          List a Card
        </h1>
        <p className="text-xs text-white/30 mt-1">Sell or trade from your collection.</p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {steps.map((s, i) => (
          <div key={s.n} className="flex items-center gap-2 flex-1">
            <div className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold shrink-0 transition-all ${
              step === s.n ? 'bg-indigo-600 text-white' :
              step > s.n  ? 'bg-indigo-600/30 text-indigo-400' :
              'bg-white/8 text-white/25'
            }`}>
              {s.n}
            </div>
            <span className={`text-xs font-medium hidden sm:block ${step === s.n ? 'text-white/70' : 'text-white/25'}`}>
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <div className={`flex-1 h-px mx-2 ${step > s.n ? 'bg-indigo-600/40' : 'bg-white/8'}`} />
            )}
          </div>
        ))}
      </div>

      {/* Step content */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-5">
        {step === 1 && (
          <StepSearch
            onSelect={card => { setSelectedCard(card); setStep(2) }}
          />
        )}

        {step === 2 && selectedCard && (
          <StepDetails
            card={selectedCard}
            condition={condition}        setCondition={setCondition}
            askingPrice={askingPrice}    setAskingPrice={setAskingPrice}
            description={description}   setDescription={setDescription}
            acceptsTrades={acceptsTrades} setAcceptsTrades={setAcceptsTrades}
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
          />
        )}

        {step === 3 && selectedCard && (
          <StepPreview
            card={selectedCard}
            condition={condition}
            askingPrice={askingPrice}
            description={description}
            acceptsTrades={acceptsTrades}
            onBack={() => setStep(2)}
            onSubmit={handleSubmit}
            submitting={submitting}
            error={error}
          />
        )}
      </div>
    </div>
  )
}
