'use client'

import { useState, useCallback, useEffect, useMemo, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { SearchForm } from '@/components/catalog/SearchForm'
import { CardScanner } from '@/components/analyze/CardScanner'
import { SearchResults, type SortKey } from '@/components/catalog/SearchResults'
import type { CardSearchResult } from '@/types/catalog'
import { SlidersHorizontal, X, ChevronDown, ChevronUp } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface FilterState {
  priceMin:   number | null   // null = no lower bound
  priceMax:   number | null   // null = no upper bound
  set:        string          // '' = all sets
  rarity:     string          // '' = all rarities
  yearMin:    number | null
  yearMax:    number | null
  hasPrice:   boolean         // true = only cards with TCGPlayer price data
}

const EMPTY_FILTERS: FilterState = {
  priceMin: null, priceMax: null,
  set: '', rarity: '',
  yearMin: null, yearMax: null,
  hasPrice: false,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function activeFilterCount(f: FilterState): number {
  let n = 0
  if (f.priceMin != null) n++
  if (f.priceMax != null) n++
  if (f.set)      n++
  if (f.rarity)   n++
  if (f.yearMin != null) n++
  if (f.yearMax != null) n++
  if (f.hasPrice) n++
  return n
}

// ── Filter Panel ──────────────────────────────────────────────────────────────

interface FilterPanelProps {
  filters:    FilterState
  onChange:   (f: FilterState) => void
  onReset:    () => void
  sets:       string[]
  rarities:   string[]
  priceRange: [number, number] | null   // [min, max] from actual results
  yearRange:  [number, number] | null
}

function FilterPanel({ filters, onChange, onReset, sets, rarities, priceRange, yearRange }: FilterPanelProps) {
  const activeCount = activeFilterCount(filters)

  function set<K extends keyof FilterState>(key: K, value: FilterState[K]) {
    onChange({ ...filters, [key]: value })
  }

  const inputCls = [
    'w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm',
    'text-white/80 placeholder:text-white/25 focus:outline-none focus:border-white/25',
    'appearance-none',
  ].join(' ')

  const selectCls = [
    'w-full rounded-lg border border-white/10 bg-[#0f0a28] px-3 py-1.5 text-sm',
    'text-white/80 focus:outline-none focus:border-white/25 cursor-pointer',
  ].join(' ')

  const pillBase = 'px-3 py-1 rounded-full text-xs font-medium border transition-colors cursor-pointer select-none'
  const pillActive = 'bg-indigo-500/25 border-indigo-400/50 text-indigo-200'
  const pillInactive = 'bg-white/[0.04] border-white/10 text-white/40 hover:border-white/25 hover:text-white/60'

  // Common rarity order
  const RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Rare Holo', 'Rare Holo EX', 'Rare Ultra', 'Rare Secret', 'Illustration Rare', 'Special Illustration Rare', 'Hyper Rare', 'Promo']
  const sortedRarities = [...rarities].sort((a, b) => {
    const ai = RARITY_ORDER.indexOf(a)
    const bi = RARITY_ORDER.indexOf(b)
    if (ai === -1 && bi === -1) return a.localeCompare(b)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })

  return (
    <div
      style={{
        borderRadius: 14,
        border: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(255,255,255,0.02)',
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-3.5 w-3.5 text-white/40" />
          <span className="text-xs font-medium text-white/50 uppercase tracking-widest">Filters</span>
          {activeCount > 0 && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-indigo-500/25 text-indigo-300 border border-indigo-500/25">
              {activeCount}
            </span>
          )}
        </div>
        {activeCount > 0 && (
          <button
            onClick={onReset}
            className="flex items-center gap-1 text-[11px] text-white/30 hover:text-white/60 transition-colors"
          >
            <X className="h-3 w-3" />
            Clear all
          </button>
        )}
      </div>

      {/* Price range */}
      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">Price range (NM market)</p>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30 text-sm">$</span>
            <input
              type="number"
              min={0}
              step={1}
              placeholder={priceRange ? `${Math.floor(priceRange[0])}` : 'Min'}
              value={filters.priceMin ?? ''}
              onChange={(e) => set('priceMin', e.target.value ? Number(e.target.value) : null)}
              className={inputCls + ' pl-6'}
            />
          </div>
          <span className="text-white/20 text-xs shrink-0">—</span>
          <div className="relative flex-1">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30 text-sm">$</span>
            <input
              type="number"
              min={0}
              step={1}
              placeholder={priceRange ? `${Math.ceil(priceRange[1])}` : 'Max'}
              value={filters.priceMax ?? ''}
              onChange={(e) => set('priceMax', e.target.value ? Number(e.target.value) : null)}
              className={inputCls + ' pl-6'}
            />
          </div>
        </div>

        {/* Quick price presets */}
        <div className="flex flex-wrap gap-1.5">
          {[
            { label: 'Under $5',   min: null, max: 5 },
            { label: '$5–$25',     min: 5,    max: 25 },
            { label: '$25–$100',   min: 25,   max: 100 },
            { label: '$100–$500',  min: 100,  max: 500 },
            { label: '$500+',      min: 500,  max: null },
          ].map(({ label, min, max }) => {
            const active = filters.priceMin === min && filters.priceMax === max
            return (
              <button
                key={label}
                onClick={() => onChange({ ...filters, priceMin: min, priceMax: max })}
                className={`${pillBase} ${active ? pillActive : pillInactive}`}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Two-column: Set + Rarity */}
      <div className="grid grid-cols-2 gap-4">
        {/* Set */}
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">Set</p>
          <select
            value={filters.set}
            onChange={(e) => set('set', e.target.value)}
            className={selectCls}
          >
            <option value="">All sets</option>
            {sets.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        {/* Year range */}
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">Year</p>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={1996}
              max={2026}
              placeholder={yearRange ? String(yearRange[0]) : 'From'}
              value={filters.yearMin ?? ''}
              onChange={(e) => set('yearMin', e.target.value ? Number(e.target.value) : null)}
              className={inputCls}
            />
            <span className="text-white/20 text-xs shrink-0">–</span>
            <input
              type="number"
              min={1996}
              max={2026}
              placeholder={yearRange ? String(yearRange[1]) : 'To'}
              value={filters.yearMax ?? ''}
              onChange={(e) => set('yearMax', e.target.value ? Number(e.target.value) : null)}
              className={inputCls}
            />
          </div>
        </div>
      </div>

      {/* Rarity pills */}
      {sortedRarities.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">Rarity</p>
          <div className="flex flex-wrap gap-1.5">
            {sortedRarities.map((r) => (
              <button
                key={r}
                onClick={() => set('rarity', filters.rarity === r ? '' : r)}
                className={`${pillBase} ${filters.rarity === r ? pillActive : pillInactive}`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Has-price toggle */}
      <label className="flex items-center gap-3 cursor-pointer select-none group w-fit">
        <div
          onClick={() => set('hasPrice', !filters.hasPrice)}
          className={[
            'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
            filters.hasPrice
              ? 'bg-indigo-500/60 border-indigo-400/50'
              : 'bg-white/[0.07] border-white/10',
          ].join(' ')}
        >
          <span
            className={[
              'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform',
              filters.hasPrice ? 'translate-x-4' : 'translate-x-0.5',
            ].join(' ')}
          />
        </div>
        <span className="text-xs text-white/50 group-hover:text-white/70 transition-colors">
          Only show cards with price data
        </span>
      </label>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

function AnalyzePageContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const initialQ = searchParams.get('q') ?? ''

  const [results, setResults]         = useState<CardSearchResult[]>([])
  const [query, setQuery]             = useState(initialQ)
  const [isLoading, setIsLoading]     = useState(!!initialQ)
  const [hasSearched, setHasSearched] = useState(!!initialQ)
  const [sortKey, setSortKey]         = useState<SortKey>('price_desc')
  const [filters, setFilters]         = useState<FilterState>(EMPTY_FILTERS)
  const [showFilters, setShowFilters] = useState(false)

  const runSearch = useCallback(async (q: string) => {
    setQuery(q)
    router.replace(q ? `/analyze?q=${encodeURIComponent(q)}` : '/analyze', { scroll: false })
    if (!q) { setResults([]); setHasSearched(false); setFilters(EMPTY_FILTERS); return }
    setIsLoading(true)
    setHasSearched(true)
    try {
      const res = await fetch(`/api/catalog/search?q=${encodeURIComponent(q)}`)
      if (!res.ok) throw new Error('Search failed')
      const data = await res.json()
      setResults(data.results ?? [])
    } catch { setResults([]) }
    finally { setIsLoading(false) }
  }, [router])

  useEffect(() => {
    if (initialQ) runSearch(initialQ)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derive filter options from raw results ────────────────────────────────
  const filterMeta = useMemo(() => {
    const sets     = new Set<string>()
    const rarities = new Set<string>()
    let minPrice = Infinity, maxPrice = -Infinity
    let minYear  = Infinity, maxYear  = -Infinity

    for (const r of results) {
      if (r.set_name) sets.add(r.set_name)
      const rarity = (r.metadata_json as any)?.rarity
      if (rarity) rarities.add(rarity)
      const price = getBestPrice(r.metadata_json as any)
      if (price != null) {
        if (price < minPrice) minPrice = price
        if (price > maxPrice) maxPrice = price
      }
      if (r.year) {
        if (r.year < minYear) minYear = r.year
        if (r.year > maxYear) maxYear = r.year
      }
    }

    return {
      sets:       [...sets].sort(),
      rarities:   [...rarities],
      priceRange: (minPrice !== Infinity && maxPrice !== -Infinity) ? [minPrice, maxPrice] as [number, number] : null,
      yearRange:  (minYear  !== Infinity && maxYear  !== -Infinity) ? [minYear,  maxYear]  as [number, number] : null,
    }
  }, [results])

  // ── Apply filters ─────────────────────────────────────────────────────────
  const filteredResults = useMemo(() => {
    const { priceMin, priceMax, set, rarity, yearMin, yearMax, hasPrice } = filters

    return results.filter((r) => {
      const price = getBestPrice(r.metadata_json as any)

      if (hasPrice && price == null) return false
      if (priceMin != null && (price == null || price < priceMin)) return false
      if (priceMax != null && (price == null || price > priceMax)) return false
      if (set && r.set_name !== set) return false
      if (rarity) {
        const rMeta = (r.metadata_json as any)?.rarity
        if (rMeta !== rarity) return false
      }
      if (yearMin != null && (r.year == null || r.year < yearMin)) return false
      if (yearMax != null && (r.year == null || r.year > yearMax)) return false

      return true
    })
  }, [results, filters])

  const activeCount = activeFilterCount(filters)
  const hasResults  = results.length > 0

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analyze Card</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Search for a card to see live pricing, eBay comps, and a sell / grade / hold recommendation.
          Try <span className="text-white/60 font-medium">"Charizard 151"</span> or{' '}
          <span className="text-white/60 font-medium">"Pikachu Base Set"</span>.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 items-start">
        <div className="flex-1">
          <SearchForm onSearch={runSearch} isLoading={isLoading} initialQuery={initialQ} />
        </div>
        <CardScanner />
      </div>

      {/* Filter toggle — only shown once we have results */}
      {hasResults && (
        <button
          onClick={() => setShowFilters((v) => !v)}
          className={[
            'flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors',
            showFilters || activeCount > 0
              ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
              : 'border-white/10 bg-white/[0.03] text-white/40 hover:border-white/20 hover:text-white/60',
          ].join(' ')}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Filters
          {activeCount > 0 && (
            <span className="bg-indigo-500/30 text-indigo-200 text-[10px] font-bold px-1.5 py-0.5 rounded-full border border-indigo-500/30">
              {activeCount}
            </span>
          )}
          {showFilters ? <ChevronUp className="h-3 w-3 ml-auto" /> : <ChevronDown className="h-3 w-3 ml-auto" />}
        </button>
      )}

      {/* Filter panel */}
      {hasResults && showFilters && (
        <FilterPanel
          filters={filters}
          onChange={setFilters}
          onReset={() => setFilters(EMPTY_FILTERS)}
          sets={filterMeta.sets}
          rarities={filterMeta.rarities}
          priceRange={filterMeta.priceRange}
          yearRange={filterMeta.yearRange}
        />
      )}

      {/* Result count summary when filters are active */}
      {hasResults && activeCount > 0 && !isLoading && (
        <p className="text-[11px] text-white/30">
          Showing <span className="text-white/60 font-semibold">{filteredResults.length}</span> of{' '}
          <span className="text-white/50">{results.length}</span> results
          {activeCount > 0 && (
            <button
              onClick={() => setFilters(EMPTY_FILTERS)}
              className="ml-2 text-indigo-400/60 hover:text-indigo-400 transition-colors"
            >
              · clear filters
            </button>
          )}
        </p>
      )}

      <SearchResults
        results={filteredResults}
        query={query}
        isLoading={isLoading}
        hasSearched={hasSearched}
        sortKey={sortKey}
        onSortChange={setSortKey}
        searchQuery={query}
      />
    </div>
  )
}

export default function AnalyzePage() {
  return (
    <Suspense fallback={<div className="h-10 animate-pulse bg-muted/40 rounded-xl max-w-2xl mx-auto" />}>
      <AnalyzePageContent />
    </Suspense>
  )
}
