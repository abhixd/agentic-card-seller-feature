'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { Skeleton } from '@/components/ui/skeleton'
import { PriceHistoryChart } from '@/components/catalog/PriceHistoryChart'
import type { CardSearchResult } from '@/types/catalog'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { AddToInventoryButton } from '@/components/catalog/AddToInventoryButton'

export type SortKey = 'price_desc' | 'price_asc' | 'name_asc' | 'year_desc' | 'year_asc'

// ── Edition mapping ───────────────────────────────────────────────────────────

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

// ── Condition multipliers (TCGPlayer market standard) ─────────────────────────

const CONDITIONS = [
  { abbr: 'NM',  label: 'Near Mint',      desc: 'Straight from pack, no visible wear', mult: 1.00 },
  { abbr: 'LP',  label: 'Lightly Played', desc: 'Minor surface wear, slight edge wear', mult: 0.83 },
  { abbr: 'MP',  label: 'Mod. Played',    desc: 'Visible wear, whitening on borders',   mult: 0.67 },
  { abbr: 'HP',  label: 'Heavily Played', desc: 'Significant wear, creases possible',   mult: 0.48 },
  { abbr: 'D',   label: 'Damaged',        desc: 'Tears, major bends, or water damage',  mult: 0.28 },
] as const

// ── Helpers ───────────────────────────────────────────────────────────────────

function getAvailableEditions(bands: Record<string, any>): EditionKey[] {
  const seen = new Set<EditionKey>()
  for (const k of Object.keys(bands)) {
    const ed = BAND_TO_EDITION[k]
    if (ed) seen.add(ed)
  }
  return EDITION_ORDER.filter((e) => seen.has(e))
}

function getBandsForEdition(bands: Record<string, any>, edition: EditionKey) {
  return Object.fromEntries(
    Object.entries(bands).filter(([k]) => BAND_TO_EDITION[k] === edition),
  )
}

/**
 * Returns the highest TCGPlayer market price across all bands in `bands`.
 * Falls back to highest mid price if no market data exists.
 *
 * Rules:
 *  1. Prefer market over mid — market reflects actual completed sales.
 *  2. Take the HIGHEST value across all bands — a card with both holofoil
 *     and normal bands should show the holo price, not the cheaper normal.
 *  3. Never use a band's mid price when a different band has a market price
 *     — avoids showing $0.50 mid when holo market is $45.
 */
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

/**
 * Best single price for a card chip/tile.
 * Scans ALL TCGPlayer price bands, market first, mid as fallback.
 * Takes the highest price so holo/1st-ed variants aren't hidden by cheaper bands.
 */
function getBestPrice(meta: Record<string, any> | null): number | null {
  const prices = meta?.tcgplayer?.prices
  if (!prices || typeof prices !== 'object') return null
  return bestMarket(prices)
}

/** Real 30-day % change from the stored price history, when the row has it. */
function chg30dFromMeta(meta: Record<string, any> | null): number | null {
  const pts: { date?: string; price?: number }[] = meta?.tcg_history?.points ?? []
  if (!Array.isArray(pts) || pts.length < 2) return null
  const clean = pts
    .filter((p) => typeof p?.date === 'string' && typeof p?.price === 'number' && p.price! > 0)
    .sort((a, b) => a.date!.localeCompare(b.date!))
  if (clean.length < 2) return null
  const target = Date.now() - 30 * 86_400_000
  let best: { date?: string; price?: number } | null = null
  let bestDiff = Infinity
  for (const p of clean) {
    const d = Math.abs(new Date(p.date!).getTime() - target)
    if (d < bestDiff) { bestDiff = d; best = p }
  }
  if (!best || bestDiff > 6 * 86_400_000) return null
  const latest = clean[clean.length - 1].price!
  return ((latest - best.price!) / best.price!) * 100
}

function fmt(n: number | null | undefined): string {
  if (n == null) return '—'
  return `$${n.toFixed(2)}`
}

function typeColor(type: string): string {
  const map: Record<string, string> = {
    Fire:      'bg-orange-500/15 text-orange-300 border-orange-500/25',
    Water:     'bg-blue-500/15 text-blue-300 border-blue-500/25',
    Grass:     'bg-green-500/15 text-green-300 border-green-500/25',
    Lightning: 'bg-yellow-400/15 text-yellow-300 border-yellow-400/25',
    Psychic:   'bg-purple-500/15 text-purple-300 border-purple-500/25',
    Fighting:  'bg-red-700/15 text-red-300 border-red-700/25',
    Darkness:  'bg-gray-700/15 text-gray-300 border-gray-600/25',
    Metal:     'bg-slate-400/15 text-slate-300 border-slate-400/25',
    Dragon:    'bg-indigo-500/15 text-indigo-300 border-indigo-500/25',
    Fairy:     'bg-pink-400/15 text-pink-300 border-pink-400/25',
    Colorless: 'bg-gray-400/15 text-gray-300 border-gray-400/25',
  }
  return map[type] ?? 'bg-gray-400/15 text-gray-300 border-gray-400/25'
}

// ── Condition Estimator ───────────────────────────────────────────────────────

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
          const price      = basePrice * mult
          const isSelected = selected === abbr
          return (
            <button
              key={abbr}
              onClick={() => setSelected(isSelected ? null : abbr)}
              className={[
                'w-full flex items-center gap-3 px-3 py-2.5 text-left border-b border-border/15 last:border-0 transition-all',
                isSelected ? 'bg-primary/8' : 'bg-card hover:bg-muted/20',
              ].join(' ')}
            >
              {/* Progress bar */}
              <div className="w-16 h-1.5 bg-muted/50 rounded-full overflow-hidden shrink-0">
                <div
                  className={[
                    'h-full rounded-full transition-all',
                    isSelected ? 'bg-primary' : 'bg-muted-foreground/30',
                  ].join(' ')}
                  style={{ width: `${mult * 100}%` }}
                />
              </div>

              {/* Abbr */}
              <span className={[
                'font-mono font-bold text-xs w-6 shrink-0',
                isSelected ? 'text-primary' : 'text-muted-foreground',
              ].join(' ')}>
                {abbr}
              </span>

              {/* Label + desc */}
              <span className="flex-1 min-w-0">
                <span className={[
                  'text-xs font-medium',
                  isSelected ? 'text-foreground' : 'text-muted-foreground',
                ].join(' ')}>
                  {label}
                </span>
                {isSelected && (
                  <span className="block text-[10px] text-muted-foreground/70 leading-tight mt-0.5 truncate">
                    {desc}
                  </span>
                )}
              </span>

              {/* Price */}
              <span className={[
                'tabular-nums font-semibold shrink-0 transition-all',
                isSelected ? 'text-foreground text-base' : 'text-xs text-muted-foreground/60',
              ].join(' ')}>
                {fmt(price)}
              </span>
            </button>
          )
        })}
      </div>
      <p className="text-[10px] text-muted-foreground/40">
        Based on TCGPlayer condition-tier multipliers applied to NM market price.
      </p>
    </div>
  )
}

// ── CardMarket section (edition-aware) ────────────────────────────────────────

function CardMarketSection({
  cm,
  selectedEdition,
  bands,
}: {
  cm: any
  selectedEdition: EditionKey
  bands: Record<string, any>
}) {
  if (!cm?.prices) return null

  // Compute TCGPlayer 1st Ed premium to estimate CardMarket 1st Ed prices
  let premium: number | null = null
  if (selectedEdition === '1st_edition') {
    const unlimitedRef = bands.holofoil?.market ?? bands.normal?.market ?? bands.unlimitedHolofoil?.market
    const firstEdRef   = bands['1stEditionHolofoil']?.market ?? bands['1stEditionNormal']?.market
    if (unlimitedRef && unlimitedRef > 0 && firstEdRef) {
      premium = firstEdRef / unlimitedRef
    }
  }

  const rawRows = [
    { label: 'Avg Sell',    val: cm.prices.averageSellPrice },
    { label: 'Low',         val: cm.prices.lowPrice },
    { label: 'Trend',       val: cm.prices.trendPrice },
    { label: 'Low (Ex+)',   val: cm.prices.lowPriceExPlus },
    { label: '1-Day Avg',   val: cm.prices.avg1 },
    { label: '7-Day Avg',   val: cm.prices.avg7 },
    { label: '30-Day Avg',  val: cm.prices.avg30 },
  ].filter((r) => r.val != null)

  if (rawRows.length === 0) return null

  // For 1st Edition: apply premium to derive estimated values
  const displayRows = rawRows.map((r) => ({
    ...r,
    displayVal: selectedEdition === '1st_edition' && premium != null ? r.val * premium : r.val,
    isEstimated: selectedEdition === '1st_edition' && premium != null,
  }))

  // Edition-specific note
  let editionNote: React.ReactNode = null
  if (selectedEdition === '1st_edition' && premium != null) {
    editionNote = (
      <span className="text-amber-400/80 font-normal normal-case tracking-normal">
        · estimated via {premium.toFixed(1)}× TCGPlayer premium
      </span>
    )
  } else if (selectedEdition === '1st_edition') {
    editionNote = (
      <span className="text-muted-foreground/50 font-normal normal-case tracking-normal">
        · 1st Ed premium unavailable — showing aggregated
      </span>
    )
  } else if (selectedEdition === 'reverse_holo') {
    editionNote = (
      <span className="text-muted-foreground/50 font-normal normal-case tracking-normal">
        · EU market (reverse holo may be aggregated)
      </span>
    )
  } else {
    editionNote = (
      <span className="text-muted-foreground/50 font-normal normal-case tracking-normal">
        · EU market
      </span>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium flex items-center gap-1.5">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400/70" />
        CardMarket {editionNote}
      </p>

      <div className="rounded-xl overflow-hidden border border-border/25">
        <div className="grid grid-cols-2">
          {displayRows.map(({ label, displayVal, isEstimated }, i) => (
            <div
              key={label}
              className={[
                'flex items-center justify-between px-3 py-2.5 bg-card text-xs',
                i % 2 === 0 ? 'border-r border-border/20' : '',
                i < displayRows.length - 2 ? 'border-b border-border/20' : '',
                i === displayRows.length - 1 && displayRows.length % 2 !== 0
                  ? 'col-span-2 border-r-0'
                  : '',
              ].filter(Boolean).join(' ')}
            >
              <span className="text-muted-foreground">{label}</span>
              <span className={['tabular-nums font-medium', isEstimated ? 'text-amber-400' : ''].join(' ')}>
                {fmt(displayVal)}
                {isEstimated && <sup className="text-[8px] text-amber-400/60 ml-0.5">est</sup>}
              </span>
            </div>
          ))}
        </div>
      </div>

      {selectedEdition === '1st_edition' && premium != null && (
        <p className="text-[10px] text-muted-foreground/45 leading-relaxed">
          Values estimated by applying the {premium.toFixed(1)}× TCGPlayer 1st&nbsp;Ed/Unlimited ratio
          to CardMarket&apos;s aggregated price. Treat as directional — actual 1st&nbsp;Ed spreads vary
          by condition and listing quality.
        </p>
      )}
      {cm.updatedAt && (
        <p className="text-[10px] text-muted-foreground/40">Updated {cm.updatedAt}</p>
      )}
    </div>
  )
}

// ── Expanded details panel ────────────────────────────────────────────────────

function ExpandedDetails({
  meta,
  catalogId,
}: {
  meta: Record<string, any> | null
  catalogId: string
}) {
  const [showCardDetails, setShowCardDetails] = useState(false)

  const bands    = meta?.tcgplayer?.prices ?? {}
  const editions = useMemo(() => getAvailableEditions(bands), [bands])

  const [selectedEdition, setSelectedEdition] = useState<EditionKey | null>(null)
  const activeEdition  = selectedEdition ?? editions[0] ?? 'unlimited'
  const editionBands   = getBandsForEdition(bands, activeEdition)
  const editionEntries = Object.entries(editionBands)
  const heroPrice      = bestMarket(editionBands)

  const heroSubLabel = editionEntries.find(([, b]) => {
    const p = (b as any)?.market ?? (b as any)?.mid
    return p === heroPrice
  })?.[0]

  if (!meta) {
    return <p className="text-xs text-muted-foreground py-3">No metadata available.</p>
  }

  return (
    <div className="space-y-5 pt-1">

      {/* ── Edition toggle ── */}
      {editions.length > 1 && (
        <div className="flex bg-muted/50 rounded-lg p-0.5 gap-0.5 w-fit">
          {editions.map((ed) => (
            <button
              key={ed}
              onClick={() => setSelectedEdition(ed)}
              className={[
                'text-xs px-3 py-1.5 rounded-md font-medium transition-all',
                activeEdition === ed
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {EDITION_LABELS[ed]}
            </button>
          ))}
        </div>
      )}

      {/* ── Hero price ── */}
      {heroPrice != null && (
        <div>
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium mb-0.5">
            TCGPlayer
            {heroSubLabel && ` · ${BAND_DISPLAY[heroSubLabel] ?? heroSubLabel}`}
            {' · Market Price (NM)'}
          </p>
          <p className="text-[2rem] font-bold tabular-nums leading-none tracking-tight">
            {fmt(heroPrice)}
          </p>
        </div>
      )}

      {/* ── Condition Estimator ── */}
      {heroPrice != null && <ConditionEstimator basePrice={heroPrice} />}

      {/* ── TCGPlayer price table ── */}
      {editionEntries.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary/70" />
            TCGPlayer · {EDITION_LABELS[activeEdition]} Prices
          </p>
          <div className="rounded-xl overflow-hidden border border-border/25">
            <div className="grid grid-cols-5 text-[10px] uppercase tracking-widest text-muted-foreground/70 px-3 py-2 bg-muted/20 border-b border-border/20">
              <span>Finish</span>
              <span className="text-right">Low</span>
              <span className="text-right">Mid</span>
              <span className="text-right font-medium text-foreground/50">Market</span>
              <span className="text-right">High</span>
            </div>
            {editionEntries.map(([bandKey, b]) => (
              <div key={bandKey}
                className="grid grid-cols-5 text-xs px-3 py-2.5 border-b border-border/15 last:border-0 bg-card">
                <span className="text-muted-foreground font-medium">
                  {BAND_DISPLAY[bandKey] ?? bandKey}
                </span>
                <span className="tabular-nums text-right text-muted-foreground">{fmt((b as any).low)}</span>
                <span className="tabular-nums text-right text-muted-foreground">{fmt((b as any).mid)}</span>
                <span className="tabular-nums text-right font-semibold text-foreground">{fmt((b as any).market)}</span>
                <span className="tabular-nums text-right text-muted-foreground">{fmt((b as any).high)}</span>
              </div>
            ))}
            {meta.tcgplayer?.updatedAt && (
              <div className="px-3 py-1.5 text-[10px] text-muted-foreground/40 bg-muted/10">
                Updated {meta.tcgplayer.updatedAt}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── eBay sales chart (EN Raw / Graded / JP tabs inside) ── */}
      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium flex items-center gap-1.5">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400/70" />
          eBay Sold History
        </p>
        <PriceHistoryChart catalogId={catalogId} />
      </div>

      {/* ── Card Details (collapsible) ── */}
      {(meta.attacks?.length > 0 ||
        meta.abilities?.length > 0 ||
        meta.weaknesses?.length > 0 ||
        meta.resistances?.length > 0 ||
        meta.flavor_text ||
        meta.artist) && (
        <div>
          <button
            onClick={() => setShowCardDetails((v) => !v)}
            className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground font-medium hover:text-foreground transition-colors"
          >
            <ChevronRight className={[
              'h-3 w-3 transition-transform duration-200',
              showCardDetails ? 'rotate-90' : '',
            ].join(' ')} />
            Card Details
          </button>

          {showCardDetails && (
            <div className="mt-3 space-y-4">
              {(meta.attacks?.length > 0 || meta.abilities?.length > 0) && (
                <div className="space-y-2.5">
                  {(meta.abilities ?? []).map((a: any) => (
                    <div key={a.name} className="text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-purple-400">{a.name}</span>
                        <span className="text-[10px] text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded-full">{a.type}</span>
                      </div>
                      {a.text && <p className="text-muted-foreground text-[11px] leading-relaxed mt-1">{a.text}</p>}
                    </div>
                  ))}
                  {(meta.attacks ?? []).map((a: any) => (
                    <div key={a.name} className="text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{a.name}</span>
                        {a.damage && <span className="text-primary font-bold">{a.damage}</span>}
                        {a.cost?.length > 0 && (
                          <span className="text-[10px] text-muted-foreground">[{a.cost.join(', ')}]</span>
                        )}
                      </div>
                      {a.text && <p className="text-muted-foreground text-[11px] leading-relaxed mt-1">{a.text}</p>}
                    </div>
                  ))}
                </div>
              )}

              {(meta.weaknesses?.length > 0 || meta.resistances?.length > 0) && (
                <div className="flex gap-8 text-xs">
                  {meta.weaknesses?.length > 0 && (
                    <div>
                      <p className="text-[10px] text-muted-foreground mb-1.5 uppercase tracking-widest">Weakness</p>
                      <div className="flex gap-1.5">
                        {meta.weaknesses.map((w: any) => (
                          <span key={w.type} className="text-red-400 font-semibold bg-red-500/10 px-2 py-0.5 rounded-full text-[11px]">
                            {w.type} {w.value}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {meta.resistances?.length > 0 && (
                    <div>
                      <p className="text-[10px] text-muted-foreground mb-1.5 uppercase tracking-widest">Resistance</p>
                      <div className="flex gap-1.5">
                        {meta.resistances.map((r: any) => (
                          <span key={r.type} className="text-emerald-400 font-semibold bg-emerald-500/10 px-2 py-0.5 rounded-full text-[11px]">
                            {r.type} {r.value}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {meta.flavor_text && (
                <p className="text-[11px] text-muted-foreground italic leading-relaxed border-l-2 border-primary/20 pl-3 py-0.5">
                  {meta.flavor_text}
                </p>
              )}
              {meta.artist && (
                <p className="text-[10px] text-muted-foreground/50">Illustrated by {meta.artist}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Card row ──────────────────────────────────────────────────────────────────

function CardResultRow({ card, searchQuery }: { card: CardSearchResult; searchQuery?: string }) {
  const [expanded, setExpanded] = useState(false)
  const meta   = card.metadata_json
  const price  = getBestPrice(meta)
  const chg30d = chg30dFromMeta(meta)
  const types: string[] = meta?.types ?? []
  const hp     = meta?.hp ?? null
  const rarity = meta?.rarity ?? card.variant ?? null

  return (
    <div className="group/row border-b border-border/25 last:border-0 hover:bg-white/[0.035] transition-colors relative">
      {/* hover accent bar */}
      <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[2px] bg-gradient-to-b from-indigo-400 to-violet-500 opacity-0 group-hover/row:opacity-100 transition-opacity" />
      <div className="flex items-center gap-3.5 px-4 py-3">

        {/* Thumbnail — larger, framed, lifts on hover */}
        <div className="shrink-0 w-11 h-[62px] rounded-lg overflow-hidden bg-black/30 relative ring-1 ring-white/10 shadow-md shadow-black/30 transition-transform duration-200 group-hover/row:scale-105">
          {card.canonical_image_url ? (
            <Image src={card.canonical_image_url} alt={card.card_name}
              fill className="object-cover object-top" sizes="44px" unoptimized />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground text-[9px] text-center px-1">
              No image
            </div>
          )}
        </div>

        {/* Info */}
        <Link href={`/analyze/${card.catalog_id}${searchQuery ? `?q=${encodeURIComponent(searchQuery)}` : ''}`} className="flex-1 min-w-0 group"
          data-testid="search-result-item">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-semibold text-[15px] tracking-tight group-hover:text-primary transition-colors leading-tight">
              {card.card_name}
            </span>
            {types.map((t) => (
              <span key={t} className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${typeColor(t)}`}>
                {t}
              </span>
            ))}
            {hp && <span className="text-[10px] text-muted-foreground">HP {hp}</span>}
          </div>
          <div className="flex items-center gap-1 mt-1 flex-wrap text-xs text-muted-foreground leading-tight">
            <span>{card.set_name}</span>
            {card.year && <><span>·</span><span>{card.year}</span></>}
            {card.card_number && <><span>·</span><span className="font-mono">#{card.card_number}</span></>}
            {rarity && <><span>·</span><span>{rarity}</span></>}
          </div>
        </Link>

        {/* 30d momentum chip (only when real history exists) */}
        {chg30d != null && Math.abs(chg30d) >= 1 && (
          <span className={[
            'hidden sm:inline-flex shrink-0 items-center text-[10px] font-bold tabular-nums px-1.5 py-0.5 rounded-md border',
            chg30d > 0
              ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/25'
              : 'text-red-300 bg-red-500/10 border-red-500/25',
          ].join(' ')}>
            {chg30d > 0 ? '▲' : '▼'} {Math.abs(chg30d).toFixed(0)}% 30d
          </span>
        )}

        {/* Price + expand */}
        <div className="shrink-0 flex items-center gap-1.5">
          {price != null ? (
            <div className="text-right">
              <p className="text-[9px] text-muted-foreground uppercase tracking-widest leading-tight">TCGPlayer</p>
              <p className="stat-num text-[15px] font-bold tabular-nums text-white leading-tight">{fmt(price)}</p>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground w-12 text-right">—</span>
          )}
          <AddToInventoryButton catalogId={card.catalog_id} cardName={card.card_name} price={price} />
          <button onClick={() => setExpanded((v) => !v)}
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md hover:bg-muted/30"
            aria-label={expanded ? 'Collapse' : 'Expand'}>
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div className="px-4 pb-6 pl-[3.75rem] border-t border-border/15 pt-4 bg-muted/8">
          <ExpandedDetails meta={meta} catalogId={card.catalog_id} />
        </div>
      )}
    </div>
  )
}

// ── Sort bar ──────────────────────────────────────────────────────────────────

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'price_desc', label: 'Price ↓' },
  { key: 'price_asc',  label: 'Price ↑' },
  { key: 'name_asc',   label: 'Name'    },
  { key: 'year_desc',  label: 'Newest'  },
  { key: 'year_asc',   label: 'Oldest'  },
]

function sortResults(results: CardSearchResult[], key: SortKey): CardSearchResult[] {
  const s = [...results]
  switch (key) {
    case 'price_desc': return s.sort((a, b) => (getBestPrice(b.metadata_json) ?? -1) - (getBestPrice(a.metadata_json) ?? -1))
    case 'price_asc':  return s.sort((a, b) => {
      const pa = getBestPrice(a.metadata_json), pb = getBestPrice(b.metadata_json)
      if (pa == null && pb == null) return 0
      if (pa == null) return 1; if (pb == null) return -1
      return pa - pb
    })
    case 'name_asc':   return s.sort((a, b) => a.card_name.localeCompare(b.card_name))
    case 'year_desc':  return s.sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    case 'year_asc':   return s.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999))
    default:           return s
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

interface SearchResultsProps {
  results:       CardSearchResult[]
  query:         string
  isLoading:     boolean
  hasSearched:   boolean
  sortKey?:      SortKey
  onSortChange?: (key: SortKey) => void
  searchQuery?:  string
}

export function SearchResults({ results, query, isLoading, hasSearched, sortKey = 'price_desc', onSortChange, searchQuery }: SearchResultsProps) {
  if (isLoading) {
    return (
      <div className="space-y-2" aria-label="Loading results" role="status">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex gap-3 p-3 rounded-xl bg-card border border-border/25">
            <Skeleton className="w-10 h-14 rounded-lg shrink-0" />
            <div className="flex-1 space-y-2 py-1">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-56" />
            </div>
            <Skeleton className="h-8 w-14 shrink-0" />
          </div>
        ))}
      </div>
    )
  }

  if (!hasSearched) return null

  if (results.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-6 text-center" data-testid="no-results">
        No cards found for &ldquo;<strong>{query}</strong>&rdquo;.
      </p>
    )
  }

  const sorted = sortResults(results, sortKey)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex bg-muted/50 rounded-lg p-0.5 gap-0.5">
          {SORT_OPTIONS.map((opt) => (
            <button key={opt.key} onClick={() => onSortChange?.(opt.key)}
              className={[
                'text-xs px-2.5 py-1.5 rounded-md font-medium transition-all',
                sortKey === opt.key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}>
              {opt.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-muted-foreground">
          {results.length} result{results.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div
        className="glass-panel overflow-hidden"
        data-testid="search-results"
        role="list"
        aria-label={`${results.length} search result${results.length !== 1 ? 's' : ''}`}
      >
        {sorted.map((card) => (
          <CardResultRow key={card.catalog_id} card={card} searchQuery={searchQuery} />
        ))}
      </div>
    </div>
  )
}
