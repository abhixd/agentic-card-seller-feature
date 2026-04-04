'use client'

import { useState, useEffect } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { PriceIntelligenceHub } from '@/components/catalog/PriceIntelligenceHub'
import { GradingAdvisor } from '@/components/catalog/GradingAdvisor'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ConditionForm } from '@/components/analysis/ConditionForm'
import { ArrowLeft, Loader2, ChevronDown, ChevronUp, ChevronRight } from 'lucide-react'
import type { CardCatalogItem } from '@/types/catalog'
import type { ConditionRatings } from '@/types/analysis'
import { AddToInventoryButton } from '@/components/inventory/AddToInventoryButton'
import { NEXUSCardInsight } from '@/components/catalog/NEXUSCardInsight'
import { TournamentMetaBadge } from '@/components/catalog/TournamentMetaBadge'

// ── Edition mapping (same as SearchResults) ───────────────────────────────

type EditionKey = '1st_edition' | 'unlimited' | 'reverse_holo'

const BAND_TO_EDITION: Record<string, EditionKey> = {
  '1stEditionHolofoil': '1st_edition',
  '1stEditionNormal':   '1st_edition',
  holofoil:             'unlimited',
  normal:               'unlimited',
  unlimitedHolofoil:    'unlimited',
  reverseHolofoil:      'reverse_holo',
}

const EDITION_LABELS: Record<EditionKey, string> = {
  '1st_edition':  '1st Edition',
  unlimited:      'Unlimited',
  reverse_holo:   'Reverse Holo',
}

const BAND_DISPLAY: Record<string, string> = {
  '1stEditionHolofoil': 'Holo',
  '1stEditionNormal':   'Non-Holo',
  holofoil:             'Holo',
  normal:               'Non-Holo',
  unlimitedHolofoil:    'Holo',
  reverseHolofoil:      'Reverse Holo',
}

const EDITION_ORDER: EditionKey[] = ['unlimited', '1st_edition', 'reverse_holo']

const CONDITIONS = [
  { abbr: 'NM', label: 'Near Mint',      mult: 1.00, desc: 'Straight from pack, no visible wear' },
  { abbr: 'LP', label: 'Lightly Played', mult: 0.83, desc: 'Minor surface wear, slight edge wear' },
  { abbr: 'MP', label: 'Mod. Played',    mult: 0.67, desc: 'Visible wear, whitening on borders'   },
  { abbr: 'HP', label: 'Heavily Played', mult: 0.48, desc: 'Significant wear, creases possible'   },
  { abbr: 'D',  label: 'Damaged',        mult: 0.28, desc: 'Tears, major bends, or water damage'  },
] as const

function fmt(n: number | null | undefined) {
  if (n == null) return '—'
  return `$${n.toFixed(2)}`
}

function getAvailableEditions(bands: Record<string, any>): EditionKey[] {
  const seen = new Set<EditionKey>()
  for (const k of Object.keys(bands)) {
    const ed = BAND_TO_EDITION[k]; if (ed) seen.add(ed)
  }
  return EDITION_ORDER.filter((e) => seen.has(e))
}

function getBandsForEdition(bands: Record<string, any>, edition: EditionKey) {
  return Object.fromEntries(Object.entries(bands).filter(([k]) => BAND_TO_EDITION[k] === edition))
}

function bestMarket(bands: Record<string, any>): number | null {
  let bestM: number | null = null
  let bestMid: number | null = null
  for (const b of Object.values(bands)) {
    const m   = typeof (b as any)?.market === 'number' && (b as any).market > 0 ? (b as any).market : null
    const mid = typeof (b as any)?.mid    === 'number' && (b as any).mid    > 0 ? (b as any).mid    : null
    if (m   != null && (bestM   == null || m   > bestM))   bestM   = m
    if (mid != null && (bestMid == null || mid > bestMid)) bestMid = mid
  }
  return bestM ?? bestMid ?? null
}

function typeColor(type: string): string {
  const map: Record<string, string> = {
    Fire: 'bg-orange-500/15 text-orange-300 border-orange-500/25',
    Water: 'bg-blue-500/15 text-blue-300 border-blue-500/25',
    Grass: 'bg-green-500/15 text-green-300 border-green-500/25',
    Lightning: 'bg-yellow-400/15 text-yellow-300 border-yellow-400/25',
    Psychic: 'bg-purple-500/15 text-purple-300 border-purple-500/25',
    Fighting: 'bg-red-700/15 text-red-300 border-red-700/25',
    Darkness: 'bg-gray-700/15 text-gray-300 border-gray-600/25',
    Metal: 'bg-slate-400/15 text-slate-300 border-slate-400/25',
    Dragon: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/25',
    Fairy: 'bg-pink-400/15 text-pink-300 border-pink-400/25',
    Colorless: 'bg-gray-400/15 text-gray-300 border-gray-400/25',
  }
  return map[type] ?? 'bg-gray-400/15 text-gray-300 border-gray-400/25'
}

// ── Condition Estimator ───────────────────────────────────────────────────

function ConditionEstimator({ basePrice }: { basePrice: number }) {
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
        Condition Estimator
        <span className="normal-case tracking-normal text-muted-foreground/50 font-normal ml-1.5">
          · tap your card&apos;s condition
        </span>
      </p>
      <div className="rounded-xl overflow-hidden border border-border/25">
        {CONDITIONS.map(({ abbr, label, desc, mult }) => {
          const price = basePrice * mult
          const isSelected = selected === abbr
          return (
            <button key={abbr} onClick={() => setSelected(isSelected ? null : abbr)}
              className={['w-full flex items-center gap-3 px-3 py-2.5 text-left border-b border-border/15 last:border-0 transition-all',
                isSelected ? 'bg-primary/8' : 'bg-card hover:bg-muted/20'].join(' ')}>
              <div className="w-14 h-1.5 bg-muted/50 rounded-full overflow-hidden shrink-0">
                <div className={['h-full rounded-full transition-all', isSelected ? 'bg-primary' : 'bg-muted-foreground/30'].join(' ')}
                  style={{ width: `${mult * 100}%` }} />
              </div>
              <span className={['font-mono font-bold text-xs w-6 shrink-0', isSelected ? 'text-primary' : 'text-muted-foreground'].join(' ')}>{abbr}</span>
              <span className="flex-1 min-w-0">
                <span className={['text-xs font-medium', isSelected ? 'text-foreground' : 'text-muted-foreground'].join(' ')}>{label}</span>
                {isSelected && <span className="block text-[10px] text-muted-foreground/70 leading-tight mt-0.5">{desc}</span>}
              </span>
              <span className={['tabular-nums font-semibold shrink-0 transition-all', isSelected ? 'text-foreground text-base' : 'text-xs text-muted-foreground/60'].join(' ')}>{fmt(price)}</span>
            </button>
          )
        })}
      </div>
      <p className="text-[10px] text-muted-foreground/40">Based on TCGPlayer condition-tier multipliers · NM baseline</p>
    </div>
  )
}

// ── CardMarket section ────────────────────────────────────────────────────

function CardMarketSection({ cm, selectedEdition, bands }: { cm: any; selectedEdition: EditionKey; bands: Record<string, any> }) {
  if (!cm?.prices) return null
  let premium: number | null = null
  if (selectedEdition === '1st_edition') {
    const unlimitedRef = bands.holofoil?.market ?? bands.normal?.market ?? bands.unlimitedHolofoil?.market
    const firstEdRef = bands['1stEditionHolofoil']?.market ?? bands['1stEditionNormal']?.market
    if (unlimitedRef && unlimitedRef > 0 && firstEdRef) premium = firstEdRef / unlimitedRef
  }
  const rawRows = [
    { label: 'Avg Sell',   val: cm.prices.averageSellPrice },
    { label: 'Low',        val: cm.prices.lowPrice },
    { label: 'Trend',      val: cm.prices.trendPrice },
    { label: 'Low (Ex+)',  val: cm.prices.lowPriceExPlus },
    { label: '1-Day Avg',  val: cm.prices.avg1 },
    { label: '7-Day Avg',  val: cm.prices.avg7 },
    { label: '30-Day Avg', val: cm.prices.avg30 },
  ].filter((r) => r.val != null)
  if (rawRows.length === 0) return null
  const displayRows = rawRows.map((r) => ({
    ...r,
    displayVal: selectedEdition === '1st_edition' && premium != null ? r.val * premium : r.val,
    isEstimated: selectedEdition === '1st_edition' && premium != null,
  }))
  const editionNote = selectedEdition === '1st_edition' && premium != null
    ? <span className="text-amber-400/80 font-normal normal-case tracking-normal">· estimated via {premium.toFixed(1)}× TCGPlayer premium</span>
    : selectedEdition === '1st_edition'
    ? <span className="text-muted-foreground/50 font-normal normal-case tracking-normal">· 1st Ed premium unavailable</span>
    : <span className="text-muted-foreground/50 font-normal normal-case tracking-normal">· EU market</span>
  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium flex items-center gap-1.5">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400/70" />
        CardMarket {editionNote}
      </p>
      <div className="rounded-xl overflow-hidden border border-border/25">
        <div className="grid grid-cols-2">
          {displayRows.map(({ label, displayVal, isEstimated }, i) => (
            <div key={label} className={['flex items-center justify-between px-3 py-2.5 bg-card text-xs',
              i % 2 === 0 ? 'border-r border-border/20' : '',
              i < displayRows.length - 2 ? 'border-b border-border/20' : '',
              i === displayRows.length - 1 && displayRows.length % 2 !== 0 ? 'col-span-2 border-r-0' : '',
            ].filter(Boolean).join(' ')}>
              <span className="text-muted-foreground">{label}</span>
              <span className={['tabular-nums font-medium', isEstimated ? 'text-amber-400' : ''].join(' ')}>
                {fmt(displayVal)}{isEstimated && <sup className="text-[8px] text-amber-400/60 ml-0.5">est</sup>}
              </span>
            </div>
          ))}
        </div>
      </div>
      {cm.updatedAt && <p className="text-[10px] text-muted-foreground/40">Updated {cm.updatedAt}</p>}
    </div>
  )
}

// ── Analysis form ─────────────────────────────────────────────────────────

const DEFAULT_CONDITION: ConditionRatings = { corners_rating: 3, edges_rating: 3, surface_rating: 3, centering_rating: 3 }

interface AnalysisFormProps {
  catalogId: string
  selectedEdition: string | null
}

function AnalysisForm({ catalogId, selectedEdition }: AnalysisFormProps) {
  const router = useRouter()
  const [analyzing, setAnalyzing]           = useState(false)
  const [error, setError]                   = useState<string | null>(null)
  const [platform, setPlatform]             = useState<'ebay' | 'tcgplayer'>('ebay')
  const [shippingCost, setShippingCost]     = useState('4.00')
  const [acquisitionCost, setAcquisitionCost] = useState('0')
  const [showCondition, setShowCondition]   = useState(false)
  const [conditionRatings, setConditionRatings] = useState<ConditionRatings | null>(null)

  async function handleAnalyze() {
    setAnalyzing(true); setError(null)
    try {
      const res = await fetch('/api/analysis', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          catalogId,
          conditionRatings,
          platform,
          shippingCost: parseFloat(shippingCost) || 4,
          acquisitionCost: parseFloat(acquisitionCost) || 0,
          edition: selectedEdition ?? null,
        }),
      })
      if (!res.ok) { const b = await res.json(); throw new Error(b.error ?? 'Analysis failed') }
      const a = await res.json()
      router.push(`/analyze/result/${a.analysis_id}`)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Analysis failed. Please try again.')
      setAnalyzing(false)
    }
  }

  return (
    <div
      className="rounded-2xl border p-5 space-y-4"
      style={{
        background:   'linear-gradient(135deg, rgba(99,102,241,0.08) 0%, rgba(139,92,246,0.05) 100%)',
        borderColor:  'rgba(99,102,241,0.25)',
        boxShadow:    '0 0 0 1px rgba(99,102,241,0.10), 0 4px 24px rgba(99,102,241,0.06)',
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-bold text-sm text-white tracking-tight">Run Full Analysis</h3>
          <p className="text-[11px] text-zinc-500 mt-0.5 leading-snug">
            Get a sell / grade / hold recommendation with exact net proceeds after all fees.
          </p>
        </div>
        {/* Edition badge — shows which edition will be analyzed */}
        {selectedEdition && (
          <span
            className="shrink-0 text-[10px] font-semibold px-2 py-1 rounded-md uppercase tracking-widest"
            style={{
              background:  'rgba(99,102,241,0.18)',
              border:      '1px solid rgba(99,102,241,0.35)',
              color:       '#a5b4fc',
            }}
          >
            {EDITION_LABELS[selectedEdition as EditionKey] ?? selectedEdition}
          </span>
        )}
      </div>

      <div className="space-y-3.5">
        {/* Platform selector */}
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-widest text-zinc-500 font-medium">Where you&apos;re selling</p>
          <div className="grid grid-cols-2 gap-1.5">
            {(['ebay', 'tcgplayer'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPlatform(p)}
                className={[
                  'text-xs py-2 rounded-lg font-semibold transition-all border',
                  platform === p
                    ? 'bg-indigo-600/20 border-indigo-500/40 text-indigo-300'
                    : 'bg-zinc-900/60 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700',
                ].join(' ')}
              >
                {p === 'ebay' ? 'eBay' : 'TCGPlayer'}
              </button>
            ))}
          </div>
        </div>

        {/* Cost inputs */}
        <div className="grid grid-cols-2 gap-3">
          {([
            { id: 'ship', label: 'Shipping cost',  val: shippingCost,     set: setShippingCost,     step: '0.50', hint: 'Envelope + postage' },
            { id: 'acq',  label: 'What you paid',  val: acquisitionCost,  set: setAcquisitionCost,  step: '1',    hint: 'Used for ROI calc' },
          ] as const).map(({ id, label, val, set, step, hint }) => (
            <div key={id} className="space-y-1">
              <label htmlFor={id} className="text-[10px] uppercase tracking-widest text-zinc-500 font-medium block">{label}</label>
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600 text-sm select-none">$</span>
                <input
                  id={id} type="number" min="0" step={step} value={val}
                  onChange={(e) => set(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 pl-6 pr-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50 transition-colors"
                />
              </div>
              <p className="text-[10px] text-zinc-600">{hint}</p>
            </div>
          ))}
        </div>

        {/* Condition toggle */}
        <button
          onClick={() => {
            setShowCondition(v => !v)
            if (!showCondition) setConditionRatings({ ...DEFAULT_CONDITION })
            else setConditionRatings(null)
          }}
          className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors w-full"
        >
          {showCondition ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          <span>{showCondition ? 'Hide condition details' : 'Add condition details'}</span>
          {!showCondition && <span className="text-zinc-600 ml-0.5">(optional — improves grading estimate)</span>}
        </button>
        {showCondition && conditionRatings && (
          <ConditionForm value={conditionRatings} onChange={setConditionRatings} />
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      <Button
        className="w-full gap-2 h-11 font-semibold text-sm"
        style={{
          background: analyzing ? 'rgba(99,102,241,0.3)' : 'linear-gradient(135deg, #4f46e5, #7c3aed)',
          boxShadow:  analyzing ? 'none' : '0 4px 16px rgba(99,102,241,0.35)',
        }}
        onClick={handleAnalyze}
        disabled={analyzing}
      >
        {analyzing && <Loader2 className="h-4 w-4 animate-spin" />}
        {analyzing ? 'Calculating…' : 'Get sell recommendation'}
      </Button>

      <p className="text-[10px] text-zinc-600 text-center leading-relaxed">
        Pulls recent eBay sold comps · calculates fees, shipping, grading ROI
      </p>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────

export default function CardDetailPage() {
  const { catalogId } = useParams<{ catalogId: string }>()
  const searchParams  = useSearchParams()
  const backQuery     = searchParams.get('q') ?? ''

  const [card, setCard]           = useState<CardCatalogItem | null>(null)
  const [loading, setLoading]     = useState(true)
  // Lifted from PriceIntelligenceHub so AnalysisForm knows which edition to analyze
  const [selectedEdition, setSelectedEdition] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/catalog/${catalogId}`)
      .then(r => r.json())
      .then(d => { setCard(d.card); setLoading(false) })
      .catch(() => setLoading(false))
  }, [catalogId])

  const meta = (card?.metadata_json ?? {}) as Record<string, any>
  const [showCardDetails, setShowCardDetails] = useState(false)
  const types: string[] = meta?.types ?? []
  const imageUrl = meta?.images?.large ?? meta?.images?.small ?? card?.canonical_image_url

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto space-y-4 p-4">
        <div className="h-6 w-48 bg-muted/40 animate-pulse rounded-lg" />
        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">
          <div className="aspect-[2/3] bg-muted/30 animate-pulse rounded-2xl" />
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => <div key={i} className="h-12 bg-muted/30 animate-pulse rounded-xl" />)}
          </div>
        </div>
      </div>
    )
  }

  if (!card) return (
    <div className="max-w-5xl mx-auto p-4 text-muted-foreground">Card not found.</div>
  )

  return (
    <div className="max-w-5xl mx-auto px-4 pb-12 space-y-6">

      {/* Back link */}
      <Link
        href={backQuery ? `/analyze?q=${encodeURIComponent(backQuery)}` : '/analyze'}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors group"
      >
        <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-0.5" />
        {backQuery ? `Back to "${backQuery}" results` : 'Back to search'}
      </Link>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6 lg:gap-10 items-start">

        {/* ── Left: Image + card identity (sticky on desktop) ── */}
        <div className="lg:sticky lg:top-6 space-y-4">
          {/* Card image */}
          <div className="relative rounded-2xl overflow-hidden bg-muted/20 shadow-2xl shadow-black/30 border border-border/20"
            style={{ aspectRatio: '2/3' }}>
            {imageUrl ? (
              <Image src={imageUrl} alt={card.card_name} fill className="object-contain p-2" sizes="300px" unoptimized />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">No image</div>
            )}
          </div>

          {/* Card identity */}
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight leading-tight">{card.card_name}</h1>
            <p className="text-sm text-muted-foreground">
              {card.set_name}
              {card.year ? ` · ${card.year}` : ''}
              {card.card_number ? ` · #${card.card_number}` : ''}
            </p>
            <div className="flex items-center gap-1.5 flex-wrap">
              {types.map((t) => (
                <span key={t} className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${typeColor(t)}`}>{t}</span>
              ))}
              {meta?.hp && <span className="text-[10px] text-muted-foreground border border-border/30 px-2 py-0.5 rounded-full">HP {meta.hp}</span>}
              {meta?.rarity && <span className="text-[10px] text-muted-foreground">{meta.rarity}</span>}
              <TournamentMetaBadge catalogId={catalogId} />
            </div>
          </div>

          {/* Add to Inventory */}
          {card && (
            <AddToInventoryButton
              catalogId={catalogId}
              tcgPrice={(() => {
                const prices = meta?.tcgplayer?.prices as Record<string, any> | undefined
                if (!prices) return null
                // Use bestMarket so expensive cards (1st ed, delta stars, etc.)
                // aren't underpriced by a cheaper band appearing first.
                return bestMarket(prices)
              })()}
            />
          )}
        </div>

        {/* ── Right: Price intelligence + analysis ── */}
        <div className="space-y-6">

          {/* ── NEXUS AI Market Insight ── */}
          <NEXUSCardInsight catalogId={catalogId} />

          {/* ── Price Intelligence Hub — unified multi-platform price view ── */}
          <PriceIntelligenceHub
            catalogId={catalogId}
            meta={meta}
            onEditionChange={setSelectedEdition}
          />

          {/* Grading Intelligence */}
          <GradingAdvisor catalogId={catalogId} />

          {/* Card Details collapsible */}
          {(meta.attacks?.length > 0 || meta.abilities?.length > 0 || meta.weaknesses?.length > 0 || meta.flavor_text || meta.artist) && (
            <div>
              <button onClick={() => setShowCardDetails(v => !v)}
                className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground font-medium hover:text-foreground transition-colors">
                <ChevronRight className={['h-3 w-3 transition-transform', showCardDetails ? 'rotate-90' : ''].join(' ')} />
                Card Details
              </button>
              {showCardDetails && (
                <div className="mt-4 space-y-4">
                  {(meta.attacks?.length > 0 || meta.abilities?.length > 0) && (
                    <div className="space-y-3">
                      {(meta.abilities ?? []).map((a: any) => (
                        <div key={a.name} className="text-sm">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-purple-400">{a.name}</span>
                            <span className="text-[10px] text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded-full">{a.type}</span>
                          </div>
                          {a.text && <p className="text-muted-foreground text-xs leading-relaxed mt-1">{a.text}</p>}
                        </div>
                      ))}
                      {(meta.attacks ?? []).map((a: any) => (
                        <div key={a.name} className="text-sm">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold">{a.name}</span>
                            {a.damage && <span className="text-primary font-bold">{a.damage}</span>}
                            {a.cost?.length > 0 && <span className="text-xs text-muted-foreground">[{a.cost.join(', ')}]</span>}
                          </div>
                          {a.text && <p className="text-muted-foreground text-xs leading-relaxed mt-1">{a.text}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                  {(meta.weaknesses?.length > 0 || meta.resistances?.length > 0) && (
                    <div className="flex gap-8 text-sm">
                      {meta.weaknesses?.length > 0 && (
                        <div>
                          <p className="text-[10px] text-muted-foreground mb-1.5 uppercase tracking-widest">Weakness</p>
                          <div className="flex gap-1.5">{meta.weaknesses.map((w: any) => (
                            <span key={w.type} className="text-red-400 font-semibold bg-red-500/10 px-2.5 py-1 rounded-full text-xs">{w.type} {w.value}</span>
                          ))}</div>
                        </div>
                      )}
                      {meta.resistances?.length > 0 && (
                        <div>
                          <p className="text-[10px] text-muted-foreground mb-1.5 uppercase tracking-widest">Resistance</p>
                          <div className="flex gap-1.5">{meta.resistances.map((r: any) => (
                            <span key={r.type} className="text-emerald-400 font-semibold bg-emerald-500/10 px-2.5 py-1 rounded-full text-xs">{r.type} {r.value}</span>
                          ))}</div>
                        </div>
                      )}
                    </div>
                  )}
                  {meta.flavor_text && <p className="text-xs text-muted-foreground italic leading-relaxed border-l-2 border-primary/20 pl-3">{meta.flavor_text}</p>}
                  {meta.artist && <p className="text-[10px] text-muted-foreground/50">Illustrated by {meta.artist}</p>}
                </div>
              )}
            </div>
          )}

          {/* Analysis form */}
          <AnalysisForm catalogId={catalogId} selectedEdition={selectedEdition} />
        </div>
      </div>
    </div>
  )
}
