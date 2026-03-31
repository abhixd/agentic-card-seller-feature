'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts'
import { Skeleton } from '@/components/ui/skeleton'
import { RefreshCw, AlertTriangle, TrendingUp } from 'lucide-react'
import type { SalePoint } from '@/app/api/cards/sold-history/route'

// ── Types ─────────────────────────────────────────────────────────────────────

type MarketTab   = 'raw' | 'graded' | 'jp'
type GradeFilter = 'all' | string

interface ChartDay {
  label:  string
  isoDay: string
  avg:    number
  low:    number
  high:   number
  count:  number
  trend?: number
}

interface MarketSignals {
  salesLast30:   number
  salesPerWeek:  number
  priceMomentum: number | null
}

interface GradeStat {
  label:    string   // 'PSA 10'
  count:    number
  avgPrice: number
  maxPrice: number
  minPrice: number
  color:    string
}

// ── Grade definitions (always shown even with no eBay data) ─────────────────

const PSA_GRADES = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1] as const

const PSA_COLORS: Record<number, string> = {
  10: '#34d399',  // emerald
  9:  '#60a5fa',  // blue
  8:  '#818cf8',  // indigo
  7:  '#c084fc',  // purple
  6:  '#f472b6',  // pink
  5:  '#fb923c',  // orange
  4:  '#fbbf24',  // amber
  3:  '#a78bfa',  // violet
  2:  '#94a3b8',  // slate
  1:  '#64748b',  // slate-dim
}

// ── Palette ───────────────────────────────────────────────────────────────────

const PALETTE = {
  raw:    '#818cf8',
  jp:     '#fb7185',
  graded: '#fbbf24',
  grades: {
    'PSA 10':  PSA_COLORS[10],
    'PSA 9.5': '#818cf8',
    'PSA 9':   PSA_COLORS[9],
    'PSA 8':   PSA_COLORS[8],
    'PSA 7':   PSA_COLORS[7],
    'PSA 6':   PSA_COLORS[6],
    'PSA 5':   PSA_COLORS[5],
    'PSA 4':   PSA_COLORS[4],
    'PSA 3':   PSA_COLORS[3],
    'PSA 2':   PSA_COLORS[2],
    'PSA 1':   PSA_COLORS[1],
    'BGS 10':  '#fde68a',
    'BGS 9.5': '#34d399',
    'BGS 9':   '#60a5fa',
    'CGC 10':  '#6ee7b7',
    'CGC 9.5': '#818cf8',
    'CGC 9':   '#60a5fa',
  } as Record<string, string>,
}

function gradeColor(g: string): string {
  return PALETTE.grades[g] ?? '#94a3b8'
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function linearRegression(pts: { x: number; y: number }[]): { slope: number; intercept: number } | null {
  if (pts.length < 4) return null
  const n     = pts.length
  const sumX  = pts.reduce((s, p) => s + p.x, 0)
  const sumY  = pts.reduce((s, p) => s + p.y, 0)
  const sumXY = pts.reduce((s, p) => s + p.x * p.y, 0)
  const sumXX = pts.reduce((s, p) => s + p.x * p.x, 0)
  const denom = n * sumXX - sumX * sumX
  if (denom === 0) return null
  return {
    slope:     (n * sumXY - sumX * sumY) / denom,
    intercept: (sumY - pts.reduce((s, p) => s + p.x, 0) * ((n * sumXY - sumX * sumY) / denom)) / n,
  }
}

function buildChartDays(points: SalePoint[], days: number): ChartDay[] {
  const cutoff  = Date.now() - days * 86_400_000
  const inRange = points.filter((p) => new Date(p.date).getTime() >= cutoff)
  if (!inRange.length) return []

  const byDay = new Map<string, number[]>()
  for (const p of inRange) {
    const day = p.date.slice(0, 10)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day)!.push(p.price)
  }

  const rows: ChartDay[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([isoDay, prices]) => ({
      label:  new Date(isoDay + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      isoDay,
      avg:    Math.round((prices.reduce((s, p) => s + p, 0) / prices.length) * 100) / 100,
      low:    Math.min(...prices),
      high:   Math.max(...prices),
      count:  prices.length,
    }))

  const reg = linearRegression(rows.map((r, i) => ({ x: i, y: r.avg })))
  if (reg) {
    return rows.map((r, i) => ({
      ...r,
      trend: Math.round((reg.slope * i + reg.intercept) * 100) / 100,
    }))
  }
  return rows
}

function computeSignals(points: SalePoint[]): MarketSignals {
  const now  = Date.now()
  const ms30 = 30 * 86_400_000
  const ms14 = 14 * 86_400_000

  const last30      = points.filter((p) => now - new Date(p.date).getTime() <= ms30)
  const salesLast30 = last30.length
  const salesPerWeek = parseFloat((salesLast30 / 4.28).toFixed(1))

  const recent    = points.filter((p) => now - new Date(p.date).getTime() <= ms14)
  const prior     = points.filter((p) => { const a = now - new Date(p.date).getTime(); return a > ms14 && a <= ms30 })
  const avgRecent = recent.length ? recent.reduce((s, p) => s + p.price, 0) / recent.length : null
  const avgPrior  = prior.length  ? prior.reduce((s,  p) => s + p.price, 0) / prior.length  : null
  const priceMomentum = avgRecent && avgPrior && avgPrior > 0
    ? parseFloat(((avgRecent - avgPrior) / avgPrior * 100).toFixed(1)) : null

  return { salesLast30, salesPerWeek, priceMomentum }
}

function collectGrades(points: SalePoint[]): string[] {
  const counts = new Map<string, number>()
  for (const p of points) {
    if (p.grader && p.grade != null) {
      const key = `${p.grader} ${p.grade}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort(([a], [b]) => {
      const [ag, an] = a.split(' '), [bg, bn] = b.split(' ')
      if (ag !== bg) return ag.localeCompare(bg)
      return parseFloat(bn) - parseFloat(an)
    })
    .map(([k]) => k)
}

function buildGradeStats(points: SalePoint[]): Map<string, GradeStat> {
  const map = new Map<string, number[]>()
  for (const p of points) {
    if (!p.grader || p.grade == null) continue
    const key = `${p.grader} ${p.grade}`
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(p.price)
  }

  const result = new Map<string, GradeStat>()
  for (const [label, prices] of map.entries()) {
    result.set(label, {
      label,
      count:    prices.length,
      avgPrice: Math.round(prices.reduce((s, p) => s + p, 0) / prices.length * 100) / 100,
      maxPrice: Math.max(...prices),
      minPrice: Math.min(...prices),
      color:    gradeColor(label),
    })
  }
  return result
}

// ── Tooltips ───────────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label, color }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload as ChartDay
  if (!d) return null
  return (
    <div className="rounded-xl border border-white/10 bg-black/75 backdrop-blur-md px-3.5 py-3 text-xs shadow-2xl min-w-[148px]">
      <p className="font-semibold text-white/80 mb-2 text-[11px] tracking-wide">{label}</p>
      <div className="space-y-1">
        <div className="flex justify-between gap-5">
          <span className="text-white/40">Avg</span>
          <span className="tabular-nums font-bold" style={{ color }}>${d.avg.toFixed(2)}</span>
        </div>
        {d.count > 1 && (
          <div className="flex justify-between gap-5">
            <span className="text-white/40">Range</span>
            <span className="tabular-nums text-white/60">${d.low.toFixed(2)} – ${d.high.toFixed(2)}</span>
          </div>
        )}
        <div className="flex justify-between gap-5">
          <span className="text-white/40">Sales</span>
          <span className="tabular-nums text-white/60">{d.count}</span>
        </div>
      </div>
    </div>
  )
}

// ── Pill button ────────────────────────────────────────────────────────────────

function Pill({ active, onClick, children, color }: {
  active: boolean; onClick: () => void; children: React.ReactNode; color?: string
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'text-[11px] px-2.5 py-1 rounded-full font-medium transition-all whitespace-nowrap',
        active ? 'text-black shadow-sm' : 'text-white/40 hover:text-white/70 bg-white/5',
      ].join(' ')}
      style={active ? { backgroundColor: color ?? '#818cf8' } : undefined}
    >
      {children}
    </button>
  )
}

// ── PSA Grade Panel — always visible on Graded tab ────────────────────────────

function GradePanel({
  gradeStats,
  rateLimited,
  catalogId,
}: {
  gradeStats: Map<string, GradeStat>
  rateLimited: boolean
  catalogId:   string
}) {
  const topGrade = PSA_GRADES.find((g) => gradeStats.get(`PSA ${g}`)?.count ?? 0 > 0) ?? 10
  const maxCount = Math.max(1, ...PSA_GRADES.map((g) => gradeStats.get(`PSA ${g}`)?.count ?? 0))

  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.02] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-wider">
            PSA Grade Prices
          </span>
          <span className="text-[10px] text-white/20 font-normal">90-day eBay sales</span>
        </div>
        {rateLimited && (
          <a
            href={`/api/cards/sold-history?catalogId=${catalogId}&lang=en&force=1`}
            className="flex items-center gap-1 text-[10px] text-amber-400/60 hover:text-amber-400 transition-colors"
            target="_blank" rel="noreferrer"
          >
            <AlertTriangle className="h-3 w-3" />
            Refresh eBay data
          </a>
        )}
      </div>

      {/* Rate limited banner */}
      {rateLimited && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-500/8 border-b border-amber-500/15">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-400/60 shrink-0" />
          <p className="text-[11px] text-amber-300/60">
            eBay price data temporarily unavailable — showing last known prices where cached
          </p>
        </div>
      )}

      {/* Grade rows */}
      <div className="divide-y divide-white/[0.04]">
        {PSA_GRADES.map((num) => {
          const key  = `PSA ${num}`
          const stat = gradeStats.get(key)
          const col  = PSA_COLORS[num]
          const isTop = num === topGrade && !!stat

          return (
            <div
              key={num}
              className={[
                'flex items-center gap-3 px-4 py-2.5 transition-colors',
                isTop ? 'bg-white/[0.025]' : 'hover:bg-white/[0.015]',
              ].join(' ')}
            >
              {/* Color dot + label */}
              <div className="flex items-center gap-2 w-[56px] shrink-0">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: col }}
                />
                <span className="text-[12px] font-semibold tabular-nums" style={{ color: col }}>
                  {key}
                </span>
              </div>

              {/* Population bar */}
              <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden">
                {stat ? (
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${(stat.count / maxCount) * 100}%`,
                      backgroundColor: col,
                      opacity: 0.5,
                    }}
                  />
                ) : (
                  <div className="h-full w-0" />
                )}
              </div>

              {/* Sales count */}
              <span className="w-10 text-right text-[11px] tabular-nums text-white/35 shrink-0">
                {stat ? `${stat.count} sold` : <span className="text-white/15">—</span>}
              </span>

              {/* Avg price — main emphasis */}
              <span className={[
                'w-20 text-right tabular-nums font-semibold text-[13px] shrink-0',
                stat ? 'text-white/85' : 'text-white/15',
              ].join(' ')}>
                {stat ? `$${stat.avgPrice.toFixed(2)}` : '—'}
              </span>

              {/* Range — subtle */}
              <span className="w-28 text-right text-[10px] tabular-nums text-white/25 shrink-0 hidden sm:block">
                {stat && stat.count > 1
                  ? `$${stat.minPrice.toFixed(0)} – $${stat.maxPrice.toFixed(0)}`
                  : ''}
              </span>
            </div>
          )
        })}
      </div>

      <div className="px-4 py-2.5 border-t border-white/5">
        <p className="text-[9px] text-white/20">
          Based on completed eBay sales. For official PSA graded population counts visit psacard.com.
        </p>
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function PriceHistoryChart({ catalogId }: { catalogId: string }) {
  const [enPoints,    setEnPoints]    = useState<SalePoint[]>([])
  const [jpPoints,    setJpPoints]    = useState<SalePoint[]>([])
  const [loading,     setLoading]     = useState(true)
  const [rateLimited, setRateLimited] = useState(false)
  const [tab,         setTab]         = useState<MarketTab>('raw')
  const [rangeDays,   setRangeDays]   = useState(90)
  const [grade,       setGrade]       = useState<GradeFilter>('all')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setRateLimited(false)

    Promise.all([
      fetch(`/api/cards/sold-history?catalogId=${catalogId}&lang=en`).then(r => r.json()),
      fetch(`/api/cards/sold-history?catalogId=${catalogId}&lang=jp`).then(r => r.json()),
    ])
      .then(([en, jp]) => {
        if (cancelled) return
        setEnPoints(en.points ?? [])
        setJpPoints(jp.points ?? [])
        // Rate limited if BOTH return empty with rateLimited flag
        if (en.rateLimited && jp.rateLimited) setRateLimited(true)
        setLoading(false)
      })
      .catch(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [catalogId])

  useEffect(() => { setGrade('all') }, [tab])

  const rawPoints    = enPoints.filter((p) => !p.graded)
  const gradedPoints = enPoints.filter((p) => p.graded)
  const availGrades  = useMemo(() => collectGrades(gradedPoints), [gradedPoints])
  const gradeStats   = useMemo(() => buildGradeStats(gradedPoints), [gradedPoints])

  const basePoints   = tab === 'raw' ? rawPoints : tab === 'jp' ? jpPoints : gradedPoints
  const activePoints = tab === 'graded' && grade !== 'all'
    ? gradedPoints.filter((p) => p.grader && p.grade != null && `${p.grader} ${p.grade}` === grade)
    : basePoints

  const chartData  = buildChartDays(activePoints, rangeDays)
  const signals    = computeSignals(activePoints)
  const chartColor = tab === 'raw' ? PALETTE.raw : tab === 'jp' ? PALETTE.jp : grade !== 'all' ? gradeColor(grade) : PALETTE.graded

  const counts90 = {
    raw:    rawPoints.filter(p => Date.now() - new Date(p.date).getTime() <= 90 * 86_400_000).length,
    graded: gradedPoints.filter(p => Date.now() - new Date(p.date).getTime() <= 90 * 86_400_000).length,
    jp:     jpPoints.filter(p => Date.now() - new Date(p.date).getTime() <= 90 * 86_400_000).length,
  }

  const totalCount = activePoints.filter(p => Date.now() - new Date(p.date).getTime() <= rangeDays * 86_400_000).length
  const hasTrend   = chartData.length >= 4 && chartData[0].trend != null
  const trendDelta = hasTrend ? (chartData.at(-1)!.trend! - chartData[0].trend!) : 0
  const trendUp    = trendDelta > 0.5

  const allPrices = chartData.flatMap((d) => [d.low, d.high])
  const yMin = chartData.length ? Math.max(0, Math.floor(Math.min(...allPrices) * 0.85)) : 0
  const yMax = chartData.length ? Math.ceil(Math.max(...allPrices) * 1.10) : 100

  const gradId = `grad-${catalogId.slice(0, 8)}-${tab}-${grade.replace(/[\s.]/g, '')}`

  if (loading) return <Skeleton className="h-64 w-full rounded-2xl" />

  return (
    <div className="space-y-4">

      {/* ── Market tabs ── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1 bg-white/5 rounded-xl p-1">
          {(['raw', 'graded', 'jp'] as MarketTab[]).map((t) => {
            const labels: Record<MarketTab, string> = { raw: 'EN Raw', graded: 'Graded', jp: '🇯🇵 JP' }
            const colors: Record<MarketTab, string> = { raw: PALETTE.raw, graded: PALETTE.graded, jp: PALETTE.jp }
            const n = counts90[t]
            return (
              <button key={t} onClick={() => setTab(t)}
                className={[
                  'text-xs px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5',
                  tab === t ? 'text-black shadow' : 'text-white/40 hover:text-white/70',
                ].join(' ')}
                style={tab === t ? { backgroundColor: colors[t] } : undefined}
              >
                {labels[t]}
                {n > 0 && (
                  <span className={[
                    'text-[10px] px-1.5 py-0.5 rounded-full',
                    tab === t ? 'bg-black/20 text-black/70' : 'bg-white/8 text-white/30',
                  ].join(' ')}>
                    {n}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 bg-white/5 rounded-xl p-1">
            {([30, 60, 90] as const).map((d) => (
              <button key={d} onClick={() => setRangeDays(d)}
                className={[
                  'text-[11px] px-2.5 py-1 rounded-lg font-medium transition-all',
                  rangeDays === d ? 'bg-white/12 text-white' : 'text-white/35 hover:text-white/60',
                ].join(' ')}>
                {d}d
              </button>
            ))}
          </div>
          {hasTrend && (
            <span className={[
              'text-[11px] font-semibold tabular-nums px-2 py-1 rounded-lg',
              Math.abs(trendDelta) < 0.5 ? 'text-white/40 bg-white/5'
                : trendUp ? 'text-emerald-400 bg-emerald-400/10'
                : 'text-red-400 bg-red-400/10',
            ].join(' ')}>
              {Math.abs(trendDelta) < 0.5 ? '→ Flat' : trendUp ? `↑ +$${trendDelta.toFixed(2)}` : `↓ −$${Math.abs(trendDelta).toFixed(2)}`}
            </span>
          )}
        </div>
      </div>

      {/* ── Graded tab: grade pills + always-visible PSA panel ── */}
      {tab === 'graded' && (
        <>
          {/* Grade pills (only when eBay data exists) */}
          {availGrades.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <Pill active={grade === 'all'} onClick={() => setGrade('all')} color={PALETTE.graded}>All Grades</Pill>
              {availGrades.map((g) => (
                <Pill key={g} active={grade === g} onClick={() => setGrade(g)} color={gradeColor(g)}>{g}</Pill>
              ))}
            </div>
          )}

          {/* PSA Grade Panel — always rendered regardless of eBay data */}
          <GradePanel
            gradeStats={gradeStats}
            rateLimited={rateLimited}
            catalogId={catalogId}
          />
        </>
      )}

      {/* ── Non-graded rate limited notice ── */}
      {tab !== 'graded' && rateLimited && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/15 bg-amber-500/5 px-3.5 py-2.5">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-400/60 shrink-0" />
          <p className="text-[11px] text-amber-300/60 flex-1">eBay price data temporarily unavailable — check back in a few hours</p>
          <a
            href={`/api/cards/sold-history?catalogId=${catalogId}&lang=en&force=1`}
            className="shrink-0 flex items-center gap-1 text-[11px] text-amber-400/60 hover:text-amber-400 transition-colors"
            target="_blank" rel="noreferrer"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </a>
        </div>
      )}

      {/* ── Signals ── */}
      {activePoints.length > 0 && (
        <div className="flex items-center gap-4 flex-wrap text-[11px]">
          <span className="text-white/40">
            Sales (30d) <span className="ml-1 font-semibold text-white/80 tabular-nums">{signals.salesLast30}</span>
          </span>
          <span className="text-white/20">·</span>
          <span className="text-white/40">
            Velocity <span className="ml-1 font-semibold text-white/80 tabular-nums">{signals.salesPerWeek}/wk</span>
          </span>
          {signals.priceMomentum != null && (
            <>
              <span className="text-white/20">·</span>
              <span className="text-white/40">
                Momentum{' '}
                <span className={[
                  'ml-1 font-semibold tabular-nums',
                  Math.abs(signals.priceMomentum) < 2 ? 'text-white/50'
                    : signals.priceMomentum > 0 ? 'text-emerald-400' : 'text-red-400',
                ].join(' ')}>
                  {signals.priceMomentum > 0 ? '+' : ''}{signals.priceMomentum}%
                </span>
              </span>
            </>
          )}
          <span className="ml-auto text-white/25 text-[10px]">{totalCount} sales</span>
        </div>
      )}

      {/* ── Chart (hidden on graded tab when no data) ── */}
      {!(tab === 'graded' && chartData.length === 0) && (
        chartData.length === 0 ? (
          <div className="h-24 flex flex-col items-center justify-center rounded-2xl bg-white/[0.02] border border-white/5 gap-1.5">
            <TrendingUp className="h-4 w-4 text-white/15" />
            <span className="text-xs text-white/30">No sales data for this period</span>
          </div>
        ) : (
          <div className="rounded-2xl overflow-hidden bg-white/[0.02] border border-white/5 p-3 pb-2">
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor={chartColor} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={chartColor} stopOpacity={0}    />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} strokeDasharray="0" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.25)', fontFamily: 'ui-monospace,monospace' }}
                  tickLine={false} axisLine={false} interval="preserveStartEnd" dy={4}
                />
                <YAxis
                  domain={[yMin, yMax]}
                  tickFormatter={(v) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`}
                  tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.25)', fontFamily: 'ui-monospace,monospace' }}
                  tickLine={false} axisLine={false} width={46} dx={-4}
                />
                <Tooltip content={(props: any) => <ChartTooltip {...props} color={chartColor} />} />

                <Area type="monotone" dataKey="high" stroke="none" fill={`url(#${gradId})`}
                  legendType="none" activeDot={false} isAnimationActive={false} />
                <Area type="monotone" dataKey="low"  stroke="none" fill="transparent"
                  legendType="none" activeDot={false} isAnimationActive={false} />

                <Line type="monotoneX" dataKey="avg" stroke={chartColor} strokeWidth={2.5} dot={false}
                  activeDot={{ r: 5, fill: chartColor, stroke: 'rgba(0,0,0,0.4)', strokeWidth: 2 }}
                  isAnimationActive animationDuration={700} />

                {hasTrend && (
                  <Line type="linear" dataKey="trend" stroke="rgba(255,255,255,0.15)"
                    strokeWidth={1.5} strokeDasharray="5 4" dot={false} activeDot={false}
                    isAnimationActive={false} />
                )}
              </ComposedChart>
            </ResponsiveContainer>

            <div className="flex items-center gap-4 px-1 mt-1.5 text-[10px] text-white/25">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-5 h-0.5 rounded" style={{ backgroundColor: chartColor }} />
                Daily avg
              </span>
              {hasTrend && (
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-5 border-t border-dashed border-white/20" />
                  Trend
                </span>
              )}
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: chartColor + '30' }} />
                Hi / Lo range
              </span>
            </div>
          </div>
        )
      )}
    </div>
  )
}
