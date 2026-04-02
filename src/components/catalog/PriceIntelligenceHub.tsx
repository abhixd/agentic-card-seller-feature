'use client'

/**
 * PriceIntelligenceHub — unified price intelligence across all platforms.
 *
 * Layout (top → bottom):
 *  1. TCGPlayer hero price  (big number, edition toggle, Low/Mid/Market/High)
 *  2. Source comparison cards  (eBay Raw · PSA 10 · CardMarket* · PriceCharting*)
 *  3. Consensus fair value + arbitrage alert
 *  4. Multi-source overlay chart  (per-source toggles · duration · forecast horizon + confidence)
 *  5. Cross-platform comparison table
 *
 * CardMarket is shown but clearly labelled "EU" and secondary.
 * TCGPlayer is always the primary / biggest element.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  ResponsiveContainer, ComposedChart, Line, Area,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import {
  TrendingUp, TrendingDown, Minus, RefreshCw, ExternalLink,
  Sparkles, BarChart2, Info, Zap, ChevronDown, ChevronUp, Loader2,
} from 'lucide-react'
// CardMarket removed — EU pricing data caused inaccuracies; TCGPlayer is primary
import type { JustTcgPoint } from '@/lib/justtcg/justTcgApi'
import type { SalePoint } from '@/app/api/cards/sold-history/route'
import type { ForecastPoint } from '@/app/api/cards/forecast/route'
import type { PriceChartingSnapshot } from '@/app/api/cards/pricecharting/route'

// ── Palette ────────────────────────────────────────────────────────────────────

const C = {
  tcg:       '#60a5fa',  // blue    — TCGPlayer
  ebayRaw:   '#f97316',  // orange  — eBay Raw
  ebayPsa10: '#fbbf24',  // amber   — eBay PSA 10
  pc:        '#c084fc',  // purple  — PriceCharting
  forecast:  '#a78bfa',  // violet  — Prophet
} as const

// ── Edition helpers ────────────────────────────────────────────────────────────

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
  '1st_edition': '1st Edition',
  unlimited:     'Unlimited',
  reverse_holo:  'Reverse Holo',
}
const EDITION_ORDER: EditionKey[] = ['unlimited', '1st_edition', 'reverse_holo']
const BAND_DISPLAY: Record<string, string> = {
  '1stEditionHolofoil': 'Holo',
  '1stEditionNormal':   'Non-Holo',
  holofoil:             'Holo',
  normal:               'Non-Holo',
  unlimitedHolofoil:    'Holo',
  reverseHolofoil:      'Rev. Holo',
}

function getAvailableEditions(bands: Record<string, any>): EditionKey[] {
  const seen = new Set<EditionKey>()
  for (const k of Object.keys(bands)) { const e = BAND_TO_EDITION[k]; if (e) seen.add(e) }
  return EDITION_ORDER.filter(e => seen.has(e))
}
function getBandsForEdition(bands: Record<string, any>, ed: EditionKey) {
  return Object.fromEntries(Object.entries(bands).filter(([k]) => BAND_TO_EDITION[k] === ed))
}
function bestMarket(bands: Record<string, any>): number | null {
  for (const b of Object.values(bands)) {
    const p = (b as any)?.market ?? (b as any)?.mid; if (p != null) return p
  }
  return null
}

// ── Duration ───────────────────────────────────────────────────────────────────

const DURATIONS = ['1m', '3m', '6m', '1y', 'all'] as const
type Duration = typeof DURATIONS[number]
const DURATION_DAYS: Record<Duration, number> = {
  '1m': 30, '3m': 90, '6m': 180, '1y': 365, 'all': 99999,
}

// ── Forecast ───────────────────────────────────────────────────────────────────

type FcHorizon = 7 | 30 | 90 | 180
const FC_HORIZONS: FcHorizon[] = [7, 30, 90, 180]

// Horizon uncertainty multipliers — how much less reliable vs 7-day baseline
const FC_PENALTY: Record<FcHorizon, number> = { 7: 1.0, 30: 1.5, 90: 2.6, 180: 4.5 }

interface FcConfidence {
  level:    'High' | 'Good' | 'Moderate' | 'Low' | 'Speculative'
  color:    string
  barPct:   number  // 0-100 for the fill bar
  mape:     number | null
  effMape:  number | null
}

function computeFcConfidence(
  tcgPts:    JustTcgPoint[],
  fitted:    ForecastPoint[],
  horizon:   FcHorizon,
): FcConfidence {
  const unknown: FcConfidence = { level: 'Moderate', color: 'text-amber-400', barPct: 50, mape: null, effMape: null }
  if (!tcgPts.length || !fitted.length) return unknown

  const actualMap = new Map<string, number>()
  for (const p of tcgPts) actualMap.set(p.date.slice(0, 10), p.price)

  const errs: number[] = []
  for (const f of fitted) {
    const a = actualMap.get(f.date)
    if (a && a > 0) errs.push(Math.abs((f.yhat - a) / a) * 100)
  }
  if (!errs.length) return unknown

  const mape    = errs.reduce((s, e) => s + e, 0) / errs.length
  const effMape = mape * FC_PENALTY[horizon]

  // Map effective MAPE to a confidence level
  // Lower is better. We express confidence as 100 - effMape (floored at 0)
  const barPct = Math.max(0, Math.min(100, 100 - effMape * 1.5))

  if (effMape < 10) return { level: 'High',        color: 'text-emerald-400', barPct, mape, effMape }
  if (effMape < 18) return { level: 'Good',        color: 'text-green-400',   barPct, mape, effMape }
  if (effMape < 30) return { level: 'Moderate',    color: 'text-amber-400',   barPct, mape, effMape }
  if (effMape < 50) return { level: 'Low',         color: 'text-orange-400',  barPct, mape, effMape }
  return                    { level: 'Speculative', color: 'text-red-400',     barPct, mape, effMape }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, sym = '$') {
  if (n == null) return '—'
  return `${sym}${n.toFixed(2)}`
}
function pct(n: number | null | undefined) {
  if (n == null) return null
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`
}
function medianByDay(pts: Array<{ date: string; price: number }>): Map<string, number> {
  const by = new Map<string, number[]>()
  for (const p of pts) {
    const d = p.date.slice(0, 10)
    if (!by.has(d)) by.set(d, [])
    by.get(d)!.push(p.price)
  }
  const out = new Map<string, number>()
  for (const [d, ps] of by) {
    const s = [...ps].sort((a, b) => a - b), m = Math.floor(s.length / 2)
    out.set(d, s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2)
  }
  return out
}
function isoLabel(day: string, showYear: boolean) {
  return new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(showYear ? { year: '2-digit' } : {}),
  })
}

// ── Timeline ───────────────────────────────────────────────────────────────────

interface TL {
  isoDay:    string
  label:     string
  tcg?:      number
  ebayRaw?:  number
  ebayPsa10?: number
  forecast?: number
  fcLower?:  number
  fcUpper?:  number
}

function buildTimeline(
  tcgPts:  JustTcgPoint[],
  ebayPts: SalePoint[],
  fcPts:   ForecastPoint[],
  days:    number,
): TL[] {
  const cutoff = days >= 99999 ? 0 : Date.now() - days * 86_400_000

  const tcgMap = new Map<string, number>()
  for (const p of tcgPts)
    if (!cutoff || new Date(p.date).getTime() >= cutoff)
      tcgMap.set(p.date.slice(0, 10), Math.round(p.price * 100) / 100)

  const rawMap  = medianByDay(ebayPts.filter(p => !p.graded && (!cutoff || new Date(p.date).getTime() >= cutoff)))
  const p10Map  = medianByDay(ebayPts.filter(p => p.graded && p.grader?.toUpperCase() === 'PSA' && p.grade === 10 && (!cutoff || new Date(p.date).getTime() >= cutoff)))

  const lastActual = [...tcgMap.keys()].sort().at(-1) ?? ''
  const fcMap = new Map<string, ForecastPoint>()
  for (const f of fcPts)
    if (f.date > lastActual && (!cutoff || new Date(f.date).getTime() >= cutoff))
      fcMap.set(f.date, f)

  const allDays = new Set([...tcgMap.keys(), ...rawMap.keys(), ...p10Map.keys(), ...fcMap.keys()])
  const sorted  = [...allDays].sort()
  if (!sorted.length) return []

  const showY = new Date(sorted[0]).getFullYear() !== new Date(sorted[sorted.length - 1]).getFullYear()
  return sorted.map(day => {
    const fc = fcMap.get(day)
    return {
      isoDay:    day,
      label:     isoLabel(day, showY),
      tcg:       tcgMap.get(day),
      ebayRaw:   rawMap.has(day)  ? Math.round(rawMap.get(day)!  * 100) / 100 : undefined,
      ebayPsa10: p10Map.has(day)  ? Math.round(p10Map.get(day)! * 100) / 100 : undefined,
      forecast:  fc ? Math.round(fc.yhat  * 100) / 100 : undefined,
      fcLower:   fc ? Math.round(fc.lower * 100) / 100 : undefined,
      fcUpper:   fc ? Math.round(fc.upper * 100) / 100 : undefined,
    }
  })
}

// ── Multi-source tooltip ───────────────────────────────────────────────────────

function MultiTooltip({ active, payload, label, vis }: any) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload as TL
  if (!row) return null
  const isForecast = row.tcg == null && row.forecast != null
  const entries = [
    vis.tcg       && row.tcg       != null && { label: 'TCGPlayer', color: C.tcg,       v: row.tcg       },
    vis.ebayRaw   && row.ebayRaw   != null && { label: 'eBay Raw',  color: C.ebayRaw,   v: row.ebayRaw   },
    vis.ebayPsa10 && row.ebayPsa10 != null && { label: 'PSA 10',   color: C.ebayPsa10, v: row.ebayPsa10 },
    vis.forecast  && row.forecast  != null && { label: isForecast ? 'Forecast' : 'Fitted', color: C.forecast, v: row.forecast, tag: isForecast ? 'projected' : undefined },
  ].filter(Boolean) as Array<{ label: string; color: string; v: number; tag?: string }>

  return (
    <div className="rounded-xl border border-white/10 bg-black/85 backdrop-blur-md px-3.5 py-3 text-xs shadow-2xl min-w-[185px]">
      <div className="flex items-center gap-2 mb-2.5">
        <p className="font-semibold text-white/70 text-[11px] tracking-wide">{label}</p>
        {isForecast && <span className="text-[9px] px-1.5 rounded bg-violet-500/20 text-violet-300">forecast</span>}
      </div>
      <div className="space-y-1.5">
        {entries.map(e => (
          <div key={e.label} className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: e.color }} />
              <span className="text-white/50">{e.label}</span>
            </div>
            <span className="tabular-nums font-bold" style={{ color: e.color }}>${e.v.toFixed(2)}</span>
          </div>
        ))}
        {row.fcLower != null && row.fcUpper != null && (
          <div className="flex justify-between gap-4 pt-1 border-t border-white/5">
            <span className="text-white/30">80% CI</span>
            <span className="tabular-nums text-white/35">${row.fcLower.toFixed(2)} – ${row.fcUpper.toFixed(2)}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Condition Estimator ────────────────────────────────────────────────────────

const CONDITIONS = [
  { abbr: 'NM', label: 'Near Mint',      mult: 1.00, desc: 'Straight from pack, no visible wear'    },
  { abbr: 'LP', label: 'Lightly Played', mult: 0.83, desc: 'Minor surface wear, slight edge wear'   },
  { abbr: 'MP', label: 'Mod. Played',    mult: 0.67, desc: 'Visible wear, whitening on borders'     },
  { abbr: 'HP', label: 'Heavily Played', mult: 0.48, desc: 'Significant wear, creases possible'     },
  { abbr: 'D',  label: 'Damaged',        mult: 0.28, desc: 'Tears, major bends, or water damage'    },
] as const

function ConditionEstimator({ basePrice }: { basePrice: number }) {
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <div className="space-y-2 pt-1">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground/50 font-medium">
        Condition Estimator
        <span className="normal-case tracking-normal font-normal ml-1.5 text-muted-foreground/30">
          · tap your card&apos;s condition
        </span>
      </p>
      <div className="rounded-xl overflow-hidden border border-blue-400/10">
        {CONDITIONS.map(({ abbr, label, desc, mult }) => {
          const price = basePrice * mult
          const isSel = selected === abbr
          return (
            <button key={abbr} onClick={() => setSelected(isSel ? null : abbr)}
              className={['w-full flex items-center gap-3 px-3 py-2.5 text-left border-b border-white/[0.05] last:border-0 transition-all',
                isSel ? 'bg-blue-400/8' : 'bg-card/60 hover:bg-white/[0.03]'].join(' ')}>
              <div className="w-14 h-1 bg-white/10 rounded-full overflow-hidden shrink-0">
                <div className={['h-full rounded-full', isSel ? 'bg-blue-400' : 'bg-white/20'].join(' ')} style={{ width: `${mult * 100}%` }} />
              </div>
              <span className={['font-mono font-bold text-xs w-6 shrink-0', isSel ? 'text-blue-300' : 'text-muted-foreground/50'].join(' ')}>{abbr}</span>
              <span className="flex-1 min-w-0">
                <span className={['text-xs font-medium', isSel ? 'text-foreground' : 'text-muted-foreground/70'].join(' ')}>{label}</span>
                {isSel && <span className="block text-[10px] text-muted-foreground/50 leading-tight mt-0.5">{desc}</span>}
              </span>
              <span className={['tabular-nums font-semibold shrink-0 transition-all', isSel ? 'text-white text-base' : 'text-xs text-muted-foreground/40'].join(' ')}>
                {fmt(price)}
              </span>
            </button>
          )
        })}
      </div>
      <p className="text-[10px] text-muted-foreground/25">Based on TCGPlayer condition-tier multipliers · NM baseline</p>
    </div>
  )
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface Props { catalogId: string; meta: Record<string, any> }

// ── Component ──────────────────────────────────────────────────────────────────

export function PriceIntelligenceHub({ catalogId, meta }: Props) {

  // ── Data ─────────────────────────────────────────────────────────────────────
  const [tcgPoints,    setTcgPoints]    = useState<JustTcgPoint[]>([])
  const [ebayPoints,   setEbayPoints]   = useState<SalePoint[]>([])
  const [fcPoints,     setFcPoints]     = useState<ForecastPoint[]>([])
  const [fittedPoints, setFittedPoints] = useState<ForecastPoint[]>([])
  const [pcSnap,       setPcSnap]       = useState<PriceChartingSnapshot | null>(null)
  const [pcConfigured, setPcConfigured] = useState<boolean | null>(null)
  const [loading,      setLoading]      = useState(true)
  const [refreshing,   setRefreshing]   = useState(false)
  const [fcLoading,    setFcLoading]    = useState(false)

  // ── UI state ──────────────────────────────────────────────────────────────────
  const [duration,      setDuration]      = useState<Duration>('3m')
  const [fcHorizon,     setFcHorizon]     = useState<FcHorizon>(30)
  const [showTcgTable,  setShowTcgTable]  = useState(false)
  const [vis,           setVis]           = useState<Record<string, boolean>>({
    tcg: true, ebayRaw: true, ebayPsa10: true, forecast: false,
  })

  // Edition selection (TCGPlayer)
  const tcgBands   = meta?.tcgplayer?.prices ?? {}
  const editions   = useMemo(() => getAvailableEditions(tcgBands), [tcgBands])
  const [selEd, setSelEd] = useState<EditionKey | null>(null)
  const activeEd   = selEd ?? editions[0] ?? 'unlimited'
  const edBands    = getBandsForEdition(tcgBands, activeEd)
  const heroPrice  = bestMarket(edBands)
  const edEntries  = Object.entries(edBands)

  const toggleVis = (key: string) => setVis(v => ({ ...v, [key]: !v[key] }))

  // ── Fetch forecast (horizon-aware) ────────────────────────────────────────────
  const fetchForecast = useCallback(async (horizon: FcHorizon, force = false) => {
    setFcLoading(true)
    try {
      const res = await fetch(
        `/api/cards/forecast?catalogId=${catalogId}&source=tcg&horizon=${horizon}${force ? '&force=1' : ''}`,
      )
      if (res.ok) {
        const d = await res.json()
        if (d?.forecast) { setFcPoints(d.forecast); setFittedPoints(d.fitted ?? []) }
      }
    } catch {}
    finally { setFcLoading(false) }
  }, [catalogId])

  // Re-fetch when horizon changes and forecast is visible
  const prevFcHorizon = useRef<FcHorizon | null>(null)
  useEffect(() => {
    if (!vis.forecast) return
    if (prevFcHorizon.current === fcHorizon) return
    prevFcHorizon.current = fcHorizon
    fetchForecast(fcHorizon)
  }, [fcHorizon, vis.forecast, fetchForecast])

  // Fetch forecast on first toggle-on
  const fcFetchedRef = useRef(false)
  useEffect(() => {
    if (vis.forecast && !fcFetchedRef.current && !fcLoading) {
      fcFetchedRef.current = true
      prevFcHorizon.current = fcHorizon
      fetchForecast(fcHorizon)
    }
  }, [vis.forecast, fcHorizon, fcLoading, fetchForecast])

  // ── Main fetch ─────────────────────────────────────────────────────────────────
  const fetchAll = useCallback(async (force = false) => {
    const qs = force ? '&force=1' : ''
    try {
      const [tcgRes, ebayRes, pcRes] = await Promise.all([
        fetch(`/api/cards/tcg-price-history?catalogId=${catalogId}${qs}`),
        fetch(`/api/cards/sold-history?catalogId=${catalogId}&lang=en${qs}`),
        fetch(`/api/cards/pricecharting?catalogId=${catalogId}`),
      ])
      const [tcgData, ebayData, pcData] = await Promise.all([
        tcgRes.json(), ebayRes.json(), pcRes.json(),
      ])
      setTcgPoints(tcgData.points ?? [])
      setEbayPoints(ebayData.points ?? [])
      setPcSnap(pcData.snapshot ?? null)
      setPcConfigured(pcData.configured ?? false)
      // Refresh forecast if already loaded
      if (fcFetchedRef.current) fetchForecast(fcHorizon, force)
    } finally { setLoading(false); setRefreshing(false) }
  }, [catalogId, fcHorizon, fetchForecast])

  useEffect(() => { fetchAll() }, [fetchAll])

  const handleRefresh = () => { setRefreshing(true); fetchAll(true) }

  // ── Derived prices ─────────────────────────────────────────────────────────────
  const rawPoints   = useMemo(() => ebayPoints.filter(p => !p.graded),              [ebayPoints])
  const p10Points   = useMemo(() => ebayPoints.filter(p => p.graded && p.grader?.toUpperCase() === 'PSA' && p.grade === 10), [ebayPoints])

  // ── Trend period (configurable — shared between hero badge + comparison table) ─
  const TREND_PERIODS = [
    { days: 7,   label: '7D',  desc: '7-day change'   },
    { days: 30,  label: '30D', desc: '30-day change'  },
    { days: 90,  label: '90D', desc: '90-day change'  },
    { days: 180, label: '6M',  desc: '6-month change' },
    { days: 365, label: '1Y',  desc: '1-year change'  },
  ] as const
  type TrendPeriodDays = typeof TREND_PERIODS[number]['days']
  const [trendPeriodDays, setTrendPeriodDays] = useState<TrendPeriodDays>(7)
  const trendPeriod = TREND_PERIODS.find(p => p.days === trendPeriodDays)!

  // Generic TCGPlayer % change for the selected period
  const tcgPeriodChange = useMemo(() => {
    if (tcgPoints.length < 2) return null
    const sorted = [...tcgPoints].sort((a, b) => a.date.localeCompare(b.date))
    const latest = sorted[sorted.length - 1].price
    const cutoff = Date.now() - trendPeriodDays * 86_400_000
    const anchor = sorted.filter(p => new Date(p.date).getTime() <= cutoff).at(-1)
    if (!anchor || anchor.price === 0) return null
    return (latest - anchor.price) / anchor.price * 100
  }, [tcgPoints, trendPeriodDays])

  // Keep legacy alias so comparison rows still compile
  const tcg7dChange = tcgPeriodChange

  const ebayRawMed = useMemo(() => {
    const ps = rawPoints.filter(p => Date.now() - new Date(p.date).getTime() <= 30 * 86_400_000).map(p => p.price)
    if (!ps.length) return null
    const s = [...ps].sort((a, b) => a - b), m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }, [rawPoints])

  // eBay raw change for the selected trend period
  const ebayRawPeriodChange = useMemo(() => {
    const now = Date.now()
    const ms  = trendPeriodDays * 86_400_000
    const r   = rawPoints.filter(p => now - new Date(p.date).getTime() <= ms).map(p => p.price)
    const pr  = rawPoints.filter(p => { const a = now - new Date(p.date).getTime(); return a > ms && a <= ms * 2 }).map(p => p.price)
    if (!r.length || !pr.length) return null
    const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length
    return (avg(r) - avg(pr)) / avg(pr) * 100
  }, [rawPoints, trendPeriodDays])

  const ebayRaw7d = ebayRawPeriodChange

  const p10Med = useMemo(() => {
    const ps = p10Points.map(p => p.price)
    if (!ps.length) return null
    const s = [...ps].sort((a, b) => a - b), m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }, [p10Points])

  // ── eBay data availability ─────────────────────────────────────────────────
  // If neither raw sales nor graded sales exist, the eBay sections are hidden
  // until real data accumulates — avoids showing empty / misleading cards
  const hasEbayData = rawPoints.length > 0 || p10Points.length > 0

  // ── Low data signal for forecast ─────────────────────────────────────────
  // Fewer than 30 historical points means the Prophet model has very limited
  // signal to learn from; we surface a warning regardless of MAPE score.
  const sparseData = tcgPoints.length < 30 && tcgPoints.length > 0
  const noTcgData  = tcgPoints.length === 0

  // eBay vs TCGPlayer delta (for the quick alignment signal)
  const ebayVsTcg = heroPrice && ebayRawMed && heroPrice > 0
    ? (ebayRawMed - heroPrice) / heroPrice * 100
    : null

  // ── Forecast confidence ────────────────────────────────────────────────────────
  const fcConf = useMemo(
    () => computeFcConfidence(tcgPoints, fittedPoints, fcHorizon),
    [tcgPoints, fittedPoints, fcHorizon],
  )

  // ── Chart data ─────────────────────────────────────────────────────────────────
  const days     = DURATION_DAYS[duration]
  const timeline = useMemo(() => buildTimeline(tcgPoints, ebayPoints, fcPoints, days), [tcgPoints, ebayPoints, fcPoints, days])

  const tickInterval = useMemo(() => {
    const n = timeline.length
    return n <= 30 ? 0 : n <= 90 ? Math.floor(n / 8) : n <= 200 ? Math.floor(n / 10) : Math.floor(n / 12)
  }, [timeline])

  const yDomain = useMemo((): [number, number] | undefined => {
    const vals: number[] = []
    for (const r of timeline) {
      if (vis.tcg       && r.tcg       != null) vals.push(r.tcg)
      if (vis.ebayRaw   && r.ebayRaw   != null) vals.push(r.ebayRaw)
      if (vis.ebayPsa10 && r.ebayPsa10 != null) vals.push(r.ebayPsa10)
      if (vis.forecast  && r.forecast  != null) vals.push(r.forecast)
    }
    if (!vals.length) return undefined
    const lo = Math.min(...vals), hi = Math.max(...vals)
    const pad = (hi - lo) * 0.12 || lo * 0.12
    return [Math.max(0, lo - pad), hi + pad]
  }, [timeline, vis])

  const tcgCoverage = useMemo(() => {
    if (!tcgPoints.length) return null
    const sorted = [...tcgPoints].sort((a, b) => a.date.localeCompare(b.date))
    return {
      first:  new Date(sorted[0].date),
      months: Math.round((Date.now() - new Date(sorted[0].date).getTime()) / (30 * 86_400_000)),
      count:  sorted.length,
    }
  }, [tcgPoints])

  // ── Loading skeleton ───────────────────────────────────────────────────────────
  if (loading) return (
    <div className="space-y-4">
      <div className="h-28 rounded-2xl bg-white/[0.03] animate-pulse" />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {[...Array(4)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-white/[0.03] animate-pulse" />)}
      </div>
      <div className="h-60 rounded-2xl bg-white/[0.03] animate-pulse" />
    </div>
  )

  // ── Render ─────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">

      {/* ── Header row ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart2 className="h-4 w-4 text-muted-foreground/40" />
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
            Price Intelligence
          </span>
        </div>
        <button onClick={handleRefresh} disabled={refreshing}
          className="flex items-center gap-1.5 text-[10px] text-muted-foreground/35 hover:text-muted-foreground/70 transition-colors">
          <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh all
        </button>
      </div>

      {/* ════════════════════════════════════════════════════════════════════════
          1.  TCGPlayer Hero — the primary price signal
          ════════════════════════════════════════════════════════════════════════ */}
      <div className="rounded-2xl border border-blue-400/15 bg-blue-400/[0.03] p-5 space-y-4">

        {/* Edition toggle */}
        {editions.length > 1 && (
          <div className="flex bg-white/[0.05] rounded-lg p-0.5 gap-0.5 w-fit">
            {editions.map(ed => (
              <button key={ed} onClick={() => setSelEd(ed)}
                className={['text-xs px-3 py-1.5 rounded-md font-medium transition-all',
                  activeEd === ed ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'].join(' ')}>
                {EDITION_LABELS[ed]}
              </button>
            ))}
          </div>
        )}

        {/* Hero number */}
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-400 shrink-0" />
              <span className="text-[10px] uppercase tracking-widest text-blue-300/60 font-semibold">
                TCGPlayer · {EDITION_LABELS[activeEd]} · Market (NM)
              </span>
            </div>
            <p className={`tabular-nums font-bold tracking-tight leading-none ${heroPrice != null ? 'text-5xl' : 'text-3xl text-muted-foreground/40'}`}>
              {heroPrice != null ? `$${heroPrice.toFixed(2)}` : '—'}
            </p>
          </div>

          {/* Period change with toggler */}
          <div className="flex flex-col items-end gap-1.5">
            {/* Segmented period selector */}
            <div className="flex items-center gap-0.5 rounded-lg bg-white/[0.04] p-0.5 border border-white/8">
              {TREND_PERIODS.map(({ days, label }) => (
                <button
                  key={days}
                  onClick={() => setTrendPeriodDays(days as TrendPeriodDays)}
                  className={[
                    'px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wide transition-all',
                    trendPeriodDays === days
                      ? 'bg-white/12 text-white'
                      : 'text-white/30 hover:text-white/60',
                  ].join(' ')}
                >
                  {label}
                </button>
              ))}
            </div>
            {/* Change value */}
            {tcgPeriodChange != null ? (
              <div className={`flex flex-col items-end gap-0.5 ${tcgPeriodChange > 2 ? 'text-emerald-400' : tcgPeriodChange < -2 ? 'text-red-400' : 'text-yellow-400'}`}>
                <div className="flex items-center gap-1">
                  {tcgPeriodChange > 0 ? <TrendingUp className="h-4 w-4" /> : tcgPeriodChange < 0 ? <TrendingDown className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
                  <span className="text-lg font-bold tabular-nums">{pct(tcgPeriodChange)}</span>
                </div>
                <span className="text-[10px] opacity-50">{trendPeriod.desc}</span>
              </div>
            ) : (
              <div className="flex flex-col items-end gap-0.5 text-white/20">
                <Minus className="h-4 w-4" />
                <span className="text-[10px]">no {trendPeriod.label} data</span>
              </div>
            )}
          </div>
        </div>

        {/* Low / Mid / Market / High per finish — collapsible */}
        {edEntries.length > 0 && (
          <div>
            <button onClick={() => setShowTcgTable(v => !v)}
              className="flex items-center gap-1.5 text-[10px] text-blue-300/40 hover:text-blue-300/60 transition-colors">
              {showTcgTable ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {showTcgTable ? 'Hide' : 'Show'} full price table · {EDITION_LABELS[activeEd]}
            </button>
            {showTcgTable && (
              <div className="mt-2.5 rounded-xl overflow-hidden border border-white/8">
                <div className="grid grid-cols-5 text-[10px] uppercase tracking-widest text-muted-foreground/40 px-3 py-2 bg-white/[0.03] border-b border-white/5">
                  <span>Finish</span>
                  <span className="text-right">Low</span>
                  <span className="text-right">Mid</span>
                  <span className="text-right font-medium text-white/60">Market</span>
                  <span className="text-right">High</span>
                </div>
                {edEntries.map(([bk, b]) => (
                  <div key={bk} className="grid grid-cols-5 text-sm px-3 py-2.5 border-b border-white/[0.04] last:border-0 bg-card">
                    <span className="text-muted-foreground font-medium text-xs">{BAND_DISPLAY[bk] ?? bk}</span>
                    <span className="tabular-nums text-right text-xs text-muted-foreground/60">{fmt((b as any).low)}</span>
                    <span className="tabular-nums text-right text-xs text-muted-foreground/60">{fmt((b as any).mid)}</span>
                    <span className="tabular-nums text-right font-bold text-white">{fmt((b as any).market)}</span>
                    <span className="tabular-nums text-right text-xs text-muted-foreground/60">{fmt((b as any).high)}</span>
                  </div>
                ))}
                {meta.tcgplayer?.updatedAt && (
                  <div className="px-3 py-1.5 text-[10px] text-muted-foreground/25 bg-white/[0.02]">
                    Updated {meta.tcgplayer.updatedAt}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {heroPrice == null && (
          <p className="text-xs text-muted-foreground/40">
            TCGPlayer price data not available. Try refreshing or check sync status.
          </p>
        )}

        {/* Condition Estimator — anchored to TCGPlayer NM market price */}
        {heroPrice != null && <ConditionEstimator basePrice={heroPrice} />}
      </div>

      {/* ════════════════════════════════════════════════════════════════════════
          2.  eBay context cards (Raw · PSA 10 · PriceCharting)
              Hidden until we have actual eBay sales data — avoids empty/
              misleading cards for cards with no recent sold history.
          ════════════════════════════════════════════════════════════════════════ */}
      {hasEbayData && <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        {[
          {
            key:   'ebayRaw',
            label: 'eBay Raw',
            price: ebayRawMed,
            note:  `30d median · ${rawPoints.length} sales`,
            chg:   ebayRaw7d,
            color: C.ebayRaw,
            url:   null,
          },
          {
            key:   'ebayPsa10',
            label: 'eBay PSA 10',
            price: p10Med,
            note:  `${p10Points.length} graded sales`,
            chg:   null as number | null,
            color: C.ebayPsa10,
            url:   null,
          },
          ...(pcConfigured !== false ? [{
            key:   'pc',
            label: 'PriceCharting',
            price: pcSnap?.loosePrice ?? null,
            note:  pcSnap ? 'Loose price' : 'Not configured',
            chg:   null as number | null,
            color: C.pc,
            url:   pcSnap?.url ?? null,
          }] : []),
        ].map(src => {
          const Arrow = src.chg == null ? Minus : src.chg > 0 ? TrendingUp : TrendingDown
          const chgCls = src.chg == null ? 'text-muted-foreground/25'
            : src.chg > 2 ? 'text-emerald-400' : src.chg < -2 ? 'text-red-400' : 'text-yellow-400'
          const isChart = ['ebayRaw', 'ebayPsa10'].includes(src.key)
          return (
            <div key={src.key}
              className={['rounded-xl border px-3.5 py-3 space-y-1.5 transition-all',
                isChart ? (vis[src.key] ? 'border-white/12 bg-white/[0.04] cursor-pointer' : 'border-white/5 bg-white/[0.015] opacity-55 cursor-pointer') : 'border-white/8 bg-white/[0.025]'].join(' ')}
              onClick={isChart ? () => toggleVis(src.key) : undefined}
            >
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: src.color }} />
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{src.label}</span>
                {src.key === 'cardmarket' && <span className="text-[9px] text-muted-foreground/30 font-normal normal-case tracking-normal ml-0.5">EU</span>}
                {isChart && (
                  <span className={`ml-auto w-1.5 h-1.5 rounded-full transition-opacity ${vis[src.key] ? 'opacity-100' : 'opacity-0'}`}
                    style={{ background: src.color }} />
                )}
              </div>
              <p className="text-lg font-bold tabular-nums leading-none">{fmt(src.price)}</p>
              <div className="flex items-center justify-between gap-1">
                <span className="text-[10px] text-muted-foreground/40 truncate">{src.note}</span>
                {src.chg != null && (
                  <div className={`flex items-center gap-0.5 shrink-0 ${chgCls}`}>
                    <Arrow className="h-3 w-3" />
                    <span className="text-[10px] font-medium tabular-nums">{pct(src.chg)}</span>
                  </div>
                )}
              </div>
              {src.url && (
                <a href={src.url} target="_blank" rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="flex items-center gap-1 text-[9px] text-muted-foreground/25 hover:text-muted-foreground/50 transition-colors w-fit">
                  <ExternalLink className="h-2.5 w-2.5" /> View
                </a>
              )}
            </div>
          )
        })}
      </div>}

      {/* ════════════════════════════════════════════════════════════════════════
          3.  eBay vs TCGPlayer alignment signal
          ════════════════════════════════════════════════════════════════════════ */}
      {ebayVsTcg != null && (
        <div className={[
          'flex items-center gap-3 px-4 py-3 rounded-xl border',
          Math.abs(ebayVsTcg) > 15
            ? 'border-amber-400/20 bg-amber-400/5'
            : 'border-white/8 bg-white/[0.02]',
        ].join(' ')}>
          {Math.abs(ebayVsTcg) > 15
            ? <Zap className="h-4 w-4 text-amber-400 shrink-0" />
            : <Sparkles className="h-4 w-4 text-white/20 shrink-0" />}
          <div className="flex-1">
            <p className="text-xs font-medium">
              eBay is{' '}
              <span className={ebayVsTcg > 0 ? 'text-orange-400' : 'text-blue-400'}>
                {Math.abs(ebayVsTcg).toFixed(1)}% {ebayVsTcg > 0 ? 'above' : 'below'}
              </span>
              {' '}TCGPlayer
            </p>
            <p className="text-[10px] text-muted-foreground/40 mt-0.5">
              {Math.abs(ebayVsTcg) <= 5
                ? 'Markets aligned — TCGPlayer price is representative'
                : Math.abs(ebayVsTcg) <= 15
                ? 'Slight divergence — check recent sold comps before pricing'
                : ebayVsTcg < 0
                ? 'eBay underpriced vs TCGPlayer — potential buy opportunity on eBay'
                : 'eBay premium over TCGPlayer — may indicate high demand or listing inflation'}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-[10px] text-muted-foreground/30">TCGPlayer</p>
            <p className="text-base font-bold tabular-nums">{fmt(heroPrice)}</p>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          4.  Multi-source overlay chart
          ════════════════════════════════════════════════════════════════════════ */}
      {timeline.length >= 2 ? (
        <div className="rounded-2xl border border-white/8 bg-white/[0.015] overflow-hidden">

          {/* Control bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-white/5">
            {/* Source toggles */}
            <div className="flex flex-wrap gap-1.5">
              {[
                { key: 'tcg',       label: 'TCGPlayer', color: C.tcg,       count: tcgPoints.length   },
                { key: 'ebayRaw',   label: 'eBay Raw',  color: C.ebayRaw,   count: rawPoints.length   },
                { key: 'ebayPsa10', label: 'PSA 10',    color: C.ebayPsa10, count: p10Points.length   },
                { key: 'forecast',  label: 'Forecast',  color: C.forecast,  count: 1 /* always show */ },
              ].map(({ key, label, color, count }) =>
                count > 0 && (
                  <button key={key} onClick={() => toggleVis(key)}
                    className={['flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all border',
                      vis[key] ? 'border-white/15 text-white/80 bg-white/[0.05]' : 'border-white/5 text-white/25'].join(' ')}>
                    <span className="w-2 h-2 rounded-full" style={{ background: vis[key] ? color : '#444' }} />
                    {label}
                    {key === 'forecast' && fcLoading && <Loader2 className="h-3 w-3 animate-spin ml-0.5 opacity-60" />}
                  </button>
                )
              )}
            </div>

            {/* Duration selector */}
            <div className="flex items-center gap-0.5 bg-white/[0.04] rounded-lg p-0.5">
              {DURATIONS.map(d => (
                <button key={d} onClick={() => setDuration(d)}
                  className={['px-2.5 py-1 rounded-md text-[11px] font-medium transition-all uppercase',
                    duration === d ? 'bg-white/10 text-white/90' : 'text-white/30 hover:text-white/60'].join(' ')}>
                  {d}
                </button>
              ))}
            </div>
          </div>

          {/* Forecast horizon + confidence (only when forecast is on) */}
          {vis.forecast && (
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b border-white/5 bg-violet-500/[0.04]">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-violet-300/50 font-medium uppercase tracking-widest">Horizon</span>
                <div className="flex items-center gap-0.5 bg-white/[0.04] rounded-lg p-0.5">
                  {FC_HORIZONS.map(h => (
                    <button key={h} onClick={() => setFcHorizon(h)}
                      className={['px-2.5 py-1 rounded-md text-[11px] font-medium transition-all',
                        fcHorizon === h ? 'bg-violet-500/30 text-violet-200' : 'text-white/30 hover:text-white/60'].join(' ')}>
                      {h}d
                    </button>
                  ))}
                </div>
              </div>

              {/* Confidence meter */}
              <div className="flex items-center gap-2.5">
                {sparseData || noTcgData ? (
                  <div className="flex items-center gap-2">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-amber-400/70 font-semibold uppercase tracking-widest">
                          Low data
                        </span>
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400/70">
                          {noTcgData ? '0 pts' : `${tcgPoints.length} pts`}
                        </span>
                      </div>
                      <div className="w-28 h-1.5 bg-white/8 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-amber-400/40" style={{ width: noTcgData ? '5%' : '20%' }} />
                      </div>
                    </div>
                    <div className="text-[10px] text-amber-400/40 max-w-[160px] leading-tight">
                      {noTcgData
                        ? 'No historical data — forecast not reliable'
                        : `Only ${tcgPoints.length} data points. Forecast accuracy improves as history accumulates (need 30+).`}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[10px] text-white/30 uppercase tracking-widest">Confidence</span>
                      <span className={`text-[11px] font-semibold ${fcConf.color}`}>{fcConf.level}</span>
                    </div>
                    <div className="w-28 h-1.5 bg-white/8 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${fcConf.barPct}%`,
                          background: fcConf.level === 'High' || fcConf.level === 'Good'
                            ? '#4ade80'
                            : fcConf.level === 'Moderate' ? '#fbbf24'
                            : fcConf.level === 'Low' ? '#f97316'
                            : '#f87171',
                        }} />
                    </div>
                  </div>
                )}
                {!sparseData && !noTcgData && fcConf.mape != null && (
                  <span className="text-[10px] text-white/20 tabular-nums">
                    MAPE {fcConf.mape.toFixed(1)}% →
                    eff. {fcConf.effMape!.toFixed(1)}%
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Chart */}
          <div className="h-64 px-1 pt-4 pb-2">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={timeline} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.25)' }} tickLine={false} axisLine={false} interval={tickInterval} />
                <YAxis domain={yDomain} tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.25)' }} tickLine={false} axisLine={false}
                  tickFormatter={v => `$${v >= 100 ? Math.round(v) : v.toFixed(0)}`} width={42} />
                <Tooltip content={<MultiTooltip vis={vis} />} cursor={{ stroke: 'rgba(255,255,255,0.07)', strokeWidth: 1 }} />

                {vis.tcg && (
                  <Line dataKey="tcg" stroke={C.tcg} strokeWidth={2.5} dot={false} connectNulls={false} name="TCGPlayer" />
                )}
                {vis.ebayRaw && (
                  <Line dataKey="ebayRaw" stroke={C.ebayRaw} strokeWidth={1.5} dot={{ r: 2.5, fill: C.ebayRaw, strokeWidth: 0 }} connectNulls={false} name="eBay Raw" />
                )}
                {vis.ebayPsa10 && (
                  <Line dataKey="ebayPsa10" stroke={C.ebayPsa10} strokeWidth={1.5} dot={{ r: 2.5, fill: C.ebayPsa10, strokeWidth: 0 }} connectNulls={false} name="PSA 10" />
                )}
                {vis.forecast && fcPoints.length > 0 && (
                  <>
                    <Area dataKey="fcUpper" stroke="none" fill={C.forecast} fillOpacity={0.07} connectNulls />
                    <Area dataKey="fcLower" stroke="none" fill="white"      fillOpacity={0}    connectNulls />
                    <Line dataKey="forecast" stroke={C.forecast} strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls name="Forecast" />
                  </>
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Coverage footer */}
          <div className="px-4 py-2 border-t border-white/[0.04] flex flex-wrap gap-x-4 gap-y-0.5 items-center">
            {tcgCoverage && (
              <p className={`text-[10px] ${sparseData ? 'text-amber-400/40' : 'text-white/15'}`}>
                TCGPlayer: {tcgCoverage.count} data point{tcgCoverage.count !== 1 ? 's' : ''}
                {sparseData
                  ? ' · low data — forecast confidence limited'
                  : tcgCoverage.months > 6
                  ? ` · ${tcgCoverage.months}mo accumulated`
                  : ' · accumulating (grows daily with each view)'}
              </p>
            )}
            {rawPoints.length > 0 && (
              <p className="text-[10px] text-white/15">eBay: {rawPoints.length} raw · {p10Points.length} PSA 10 (90d window)</p>
            )}
          </div>
        </div>
      ) : (
        tcgPoints.length === 0 && ebayPoints.length === 0 && (
          <div className="rounded-2xl border border-white/8 p-8 text-center">
            <p className="text-sm text-muted-foreground">No price history yet</p>
            <p className="text-[11px] text-muted-foreground/35 mt-1">Data accumulates as you view this card — check back in 24h.</p>
          </div>
        )
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          5.  eBay quick comparison (vs TCGPlayer)
          ════════════════════════════════════════════════════════════════════════ */}
      {(() => {
        const rows = [
          { label: 'TCGPlayer Market', color: C.tcg,       price: heroPrice,  chg: tcg7dChange, note: EDITION_LABELS[activeEd] },
          { label: 'eBay Raw',         color: C.ebayRaw,   price: ebayRawMed, chg: ebayRaw7d,   note: '30d median'              },
          { label: 'eBay PSA 10',      color: C.ebayPsa10, price: p10Med,     chg: null,        note: 'Graded'                  },
          ...(pcSnap?.loosePrice ? [{ label: 'PriceCharting', color: C.pc, price: pcSnap.loosePrice, chg: null, note: 'Loose' }] : []),
        ].filter(r => r.price != null)
        if (rows.length < 2) return null
        return (
          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium flex items-center gap-1.5">
              <Info className="h-3 w-3" />
              Market Comparison
            </p>
            <div className="rounded-xl overflow-hidden border border-border/25">
              <div className="grid grid-cols-4 px-3 py-2 text-[10px] uppercase tracking-widest text-muted-foreground/40 bg-muted/8 border-b border-border/20">
                <span>Market</span>
                <span className="text-right">Price</span>
                <span className="text-right">{trendPeriod.label} Δ</span>
                <span className="text-right">vs TCGPlayer</span>
              </div>
              {rows.map(row => {
                const vsTcg = heroPrice && row.price && heroPrice > 0 ? (row.price - heroPrice) / heroPrice * 100 : null
                return (
                  <div key={row.label} className="grid grid-cols-4 px-3 py-2.5 bg-card border-b border-border/15 last:border-0 items-center">
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: row.color }} />
                      <div>
                        <span className="text-xs font-medium text-muted-foreground">{row.label}</span>
                        <span className="text-[9px] text-muted-foreground/30 ml-1">{row.note}</span>
                      </div>
                    </div>
                    <span className="tabular-nums font-bold text-right">{fmt(row.price)}</span>
                    <span className={`tabular-nums text-right text-xs ${row.chg == null ? 'text-muted-foreground/25' : row.chg > 1 ? 'text-emerald-400' : row.chg < -1 ? 'text-red-400' : 'text-yellow-400'}`}>
                      {row.chg != null ? pct(row.chg) : '—'}
                    </span>
                    <span className={`tabular-nums text-right text-xs font-medium ${
                      row.label === 'TCGPlayer Market' ? 'text-blue-400/60'
                      : vsTcg == null ? 'text-muted-foreground/25'
                      : vsTcg > 5 ? 'text-orange-400' : vsTcg < -5 ? 'text-blue-400' : 'text-muted-foreground/45'
                    }`}>
                      {row.label === 'TCGPlayer Market' ? 'baseline' : vsTcg != null ? pct(vsTcg) : '—'}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      {/* PriceCharting add-key prompt */}
      {pcConfigured === false && (
        <p className="text-[10px] text-muted-foreground/20 flex items-center gap-1.5">
          <Info className="h-3 w-3 shrink-0" />
          Add <code className="bg-white/5 px-1 rounded text-white/20">PRICECHARTING_API_TOKEN</code> env var to enable PriceCharting data
        </p>
      )}
    </div>
  )
}
