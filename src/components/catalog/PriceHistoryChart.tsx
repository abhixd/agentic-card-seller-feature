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
  ReferenceLine,
} from 'recharts'
import { Skeleton } from '@/components/ui/skeleton'
import type { SalePoint } from '@/app/api/cards/sold-history/route'

// ── Types ─────────────────────────────────────────────────────────────────────

type MarketTab = 'raw' | 'graded' | 'jp'
type GradeFilter = 'all' | string  // 'all' | 'PSA 10' | 'PSA 9' | 'BGS 9.5' etc.

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

// ── Palette ───────────────────────────────────────────────────────────────────

const PALETTE = {
  raw:    '#818cf8',   // indigo-400  — cool blue-purple
  jp:     '#fb7185',   // rose-400    — vivid red-pink
  graded: '#fbbf24',   // amber-400   — warm gold
  // per-grade overrides
  grades: {
    'PSA 10':  '#34d399',   // emerald-400
    'PSA 9.5': '#818cf8',   // indigo-400
    'PSA 9':   '#60a5fa',   // blue-400
    'PSA 8':   '#c084fc',   // purple-400
    'BGS 10':  '#fde68a',   // amber-200 (Black Label premium)
    'BGS 9.5': '#34d399',
    'BGS 9':   '#60a5fa',
    'CGC 10':  '#6ee7b7',   // emerald-300
    'CGC 9.5': '#818cf8',
    'CGC 9':   '#60a5fa',
  } as Record<string, string>,
}

function gradeColor(gradeKey: string): string {
  return PALETTE.grades[gradeKey] ?? '#94a3b8'
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
  const slope     = (n * sumXY - sumX * sumY) / denom
  const intercept = (sumY - slope * sumX) / n
  return { slope, intercept }
}

function buildChartDays(points: SalePoint[], days: number): ChartDay[] {
  const cutoff  = Date.now() - days * 86_400_000
  const inRange = points.filter((p) => new Date(p.date).getTime() >= cutoff)
  if (inRange.length === 0) return []

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
  const now   = Date.now()
  const ms30  = 30 * 86_400_000
  const ms14  = 14 * 86_400_000

  const last30      = points.filter((p) => now - new Date(p.date).getTime() <= ms30)
  const salesLast30 = last30.length
  const salesPerWeek = parseFloat((salesLast30 / 4.28).toFixed(1))

  const recent    = points.filter((p) => now - new Date(p.date).getTime() <= ms14)
  const prior     = points.filter((p) => { const age = now - new Date(p.date).getTime(); return age > ms14 && age <= ms30 })
  const avgRecent = recent.length ? recent.reduce((s, p) => s + p.price, 0) / recent.length : null
  const avgPrior  = prior.length  ? prior.reduce((s, p)  => s + p.price, 0) / prior.length  : null
  const priceMomentum = avgRecent && avgPrior && avgPrior > 0
    ? parseFloat(((avgRecent - avgPrior) / avgPrior * 100).toFixed(1))
    : null

  return { salesLast30, salesPerWeek, priceMomentum }
}

/** Collect all grade keys from graded points that have ≥3 sales */
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
      // Sort by grader then grade descending: PSA 10, PSA 9.5, PSA 9 ... BGS 10 ...
      const [ag, an] = a.split(' ')
      const [bg, bn] = b.split(' ')
      if (ag !== bg) return ag.localeCompare(bg)
      return parseFloat(bn) - parseFloat(an)
    })
    .map(([key]) => key)
}

// ── Tooltip ────────────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label, color }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload as ChartDay
  if (!d) return null
  return (
    <div className="rounded-xl border border-white/10 bg-black/70 backdrop-blur-md px-3.5 py-3 text-xs shadow-xl min-w-[140px]">
      <p className="font-semibold text-white/90 mb-2 text-[11px]">{label}</p>
      <div className="space-y-1">
        <div className="flex justify-between gap-5">
          <span className="text-white/50">Avg</span>
          <span className="tabular-nums font-semibold" style={{ color }}>${d.avg.toFixed(2)}</span>
        </div>
        {d.count > 1 && (
          <div className="flex justify-between gap-5">
            <span className="text-white/50">Range</span>
            <span className="tabular-nums text-white/70">${d.low.toFixed(2)}–${d.high.toFixed(2)}</span>
          </div>
        )}
        <div className="flex justify-between gap-5">
          <span className="text-white/50">Sales</span>
          <span className="tabular-nums text-white/70">{d.count}</span>
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
        active
          ? 'text-black shadow-sm'
          : 'text-white/40 hover:text-white/70 bg-white/5 hover:bg-white/8',
      ].join(' ')}
      style={active ? { backgroundColor: color ?? '#818cf8' } : undefined}
    >
      {children}
    </button>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function PriceHistoryChart({ catalogId }: { catalogId: string }) {
  const [enPoints,  setEnPoints]  = useState<SalePoint[]>([])
  const [jpPoints,  setJpPoints]  = useState<SalePoint[]>([])
  const [loading,   setLoading]   = useState(true)
  const [tab,       setTab]       = useState<MarketTab>('raw')
  const [rangeDays, setRangeDays] = useState(90)
  const [grade,     setGrade]     = useState<GradeFilter>('all')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      fetch(`/api/cards/sold-history?catalogId=${catalogId}&lang=en`).then(r => r.json()),
      fetch(`/api/cards/sold-history?catalogId=${catalogId}&lang=jp`).then(r => r.json()),
    ])
      .then(([en, jp]) => {
        if (!cancelled) {
          setEnPoints(en.points ?? [])
          setJpPoints(jp.points ?? [])
          setLoading(false)
        }
      })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [catalogId])

  const rawPoints    = enPoints.filter((p) => !p.graded)
  const gradedPoints = enPoints.filter((p) => p.graded)
  const availGrades  = useMemo(() => collectGrades(gradedPoints), [gradedPoints])

  // Reset grade filter when switching tabs or when available grades change
  useEffect(() => { setGrade('all') }, [tab])

  // Active points based on tab + grade filter
  const basePoints = tab === 'raw' ? rawPoints : tab === 'jp' ? jpPoints : gradedPoints
  const activePoints = tab === 'graded' && grade !== 'all'
    ? gradedPoints.filter((p) => p.grader && p.grade != null && `${p.grader} ${p.grade}` === grade)
    : basePoints

  const chartData = buildChartDays(activePoints, rangeDays)
  const signals   = computeSignals(activePoints)

  // Determine chart color
  const chartColor = tab === 'raw' ? PALETTE.raw
    : tab === 'jp'     ? PALETTE.jp
    : grade !== 'all'  ? gradeColor(grade)
    : PALETTE.graded

  // Count per market tab (90d)
  const counts90 = {
    raw:    rawPoints.filter(p => Date.now() - new Date(p.date).getTime() <= 90 * 86_400_000).length,
    graded: gradedPoints.filter(p => Date.now() - new Date(p.date).getTime() <= 90 * 86_400_000).length,
    jp:     jpPoints.filter(p => Date.now() - new Date(p.date).getTime() <= 90 * 86_400_000).length,
  }

  const totalCount = activePoints.filter(
    (p) => Date.now() - new Date(p.date).getTime() <= rangeDays * 86_400_000,
  ).length

  const hasTrend   = chartData.length >= 4 && chartData[0].trend != null
  const trendDelta = hasTrend ? (chartData.at(-1)!.trend! - chartData[0].trend!) : 0
  const trendLabel = Math.abs(trendDelta) < 0.5 ? 'Flat'
    : trendDelta > 0 ? `+$${trendDelta.toFixed(2)}`
    : `−$${Math.abs(trendDelta).toFixed(2)}`
  const trendUp = trendDelta > 0.5

  const allPrices = chartData.flatMap((d) => [d.low, d.high])
  const yMin = chartData.length ? Math.max(0, Math.floor(Math.min(...allPrices) * 0.85)) : 0
  const yMax = chartData.length ? Math.ceil(Math.max(...allPrices) * 1.10) : 100

  if (loading) return <Skeleton className="h-60 w-full rounded-2xl" />

  const gradId = `grad-${catalogId}-${tab}-${grade.replace(/\s/g,'')}`

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

        {/* Range + trend */}
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
            <span className={['text-[11px] font-semibold tabular-nums px-2 py-1 rounded-lg',
              Math.abs(trendDelta) < 0.5
                ? 'text-white/40 bg-white/5'
                : trendUp
                ? 'text-emerald-400 bg-emerald-400/10'
                : 'text-red-400 bg-red-400/10',
            ].join(' ')}>
              {Math.abs(trendDelta) < 0.5 ? '→ Flat' : trendUp ? `↑ ${trendLabel}` : `↓ ${trendLabel}`}
            </span>
          )}
        </div>
      </div>

      {/* ── Grade sub-filter (Graded tab only) ── */}
      {tab === 'graded' && availGrades.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <Pill active={grade === 'all'} onClick={() => setGrade('all')} color={PALETTE.graded}>
            All Grades
          </Pill>
          {availGrades.map((g) => (
            <Pill key={g} active={grade === g} onClick={() => setGrade(g)} color={gradeColor(g)}>
              {g}
            </Pill>
          ))}
        </div>
      )}

      {/* ── Signals row ── */}
      {activePoints.length > 0 && (
        <div className="flex items-center gap-4 flex-wrap text-[11px]">
          <span className="text-white/40">
            Sales (30d)
            <span className="ml-1.5 font-semibold text-white/80 tabular-nums">{signals.salesLast30}</span>
          </span>
          <span className="text-white/20">·</span>
          <span className="text-white/40">
            Velocity
            <span className="ml-1.5 font-semibold text-white/80 tabular-nums">{signals.salesPerWeek}/wk</span>
          </span>
          {signals.priceMomentum != null && (
            <>
              <span className="text-white/20">·</span>
              <span className="text-white/40">
                Momentum
                <span className={[
                  'ml-1.5 font-semibold tabular-nums',
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

      {/* ── Empty state ── */}
      {chartData.length === 0 ? (
        <div className="h-24 flex flex-col items-center justify-center rounded-2xl bg-white/3 border border-white/5 gap-1">
          <span className="text-xs text-white/30">No sales data in the last {rangeDays} days</span>
          {tab === 'graded' && grade !== 'all' && (
            <button onClick={() => setGrade('all')} className="text-[11px] text-white/20 hover:text-white/50 underline underline-offset-2">
              Show all grades
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-2xl overflow-hidden bg-white/[0.02] border border-white/5 p-3">
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor={chartColor} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={chartColor} stopOpacity={0}    />
                </linearGradient>
              </defs>

              <CartesianGrid
                strokeDasharray="0"
                stroke="rgba(255,255,255,0.04)"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.25)', fontFamily: 'var(--font-geist-mono, monospace)' }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                dy={4}
              />
              <YAxis
                domain={[yMin, yMax]}
                tickFormatter={(v) => `$${v >= 1000 ? `${(v/1000).toFixed(1)}k` : v}`}
                tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.25)', fontFamily: 'var(--font-geist-mono, monospace)' }}
                tickLine={false}
                axisLine={false}
                width={46}
                dx={-4}
              />
              <Tooltip content={(props: any) => <ChartTooltip {...props} color={chartColor} />} />

              {/* Range band */}
              <Area
                type="monotone"
                dataKey="high"
                stroke="none"
                fill={`url(#${gradId})`}
                legendType="none"
                activeDot={false}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="low"
                stroke="none"
                fill="transparent"
                legendType="none"
                activeDot={false}
                isAnimationActive={false}
              />

              {/* Main price line */}
              <Line
                type="monotoneX"
                dataKey="avg"
                stroke={chartColor}
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 5, fill: chartColor, stroke: 'rgba(0,0,0,0.5)', strokeWidth: 2 }}
                isAnimationActive={true}
                animationDuration={600}
              />

              {/* Trend line */}
              {hasTrend && (
                <Line
                  type="linear"
                  dataKey="trend"
                  stroke="rgba(255,255,255,0.18)"
                  strokeWidth={1.5}
                  strokeDasharray="5 4"
                  dot={false}
                  activeDot={false}
                  isAnimationActive={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>

          {/* Mini legend */}
          <div className="flex items-center gap-4 px-1 mt-2 text-[10px] text-white/30">
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
              Hi/Lo range
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
