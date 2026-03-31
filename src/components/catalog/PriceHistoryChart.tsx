'use client'

import { useState, useEffect } from 'react'
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
import type { SalePoint } from '@/app/api/cards/sold-history/route'

// ── Types ─────────────────────────────────────────────────────────────────────

type EbayTab = 'raw' | 'graded' | 'jp'

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
  salesLast30: number
  salesPerWeek: number
  priceMomentum: number | null  // % change recent vs prior period
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function linearRegression(pts: { x: number; y: number }[]): { slope: number; intercept: number } | null {
  if (pts.length < 3) return null
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
  const now       = Date.now()
  const ms30      = 30 * 86_400_000
  const ms14      = 14 * 86_400_000

  const last30    = points.filter((p) => now - new Date(p.date).getTime() <= ms30)
  const salesLast30  = last30.length
  const salesPerWeek = parseFloat((salesLast30 / 4.28).toFixed(1))

  // Price momentum: avg of last 14 days vs prior 14 days
  const recent  = points.filter((p) => now - new Date(p.date).getTime() <= ms14)
  const prior   = points.filter((p) => {
    const age = now - new Date(p.date).getTime()
    return age > ms14 && age <= ms30
  })
  const avgRecent = recent.length ? recent.reduce((s, p) => s + p.price, 0) / recent.length : null
  const avgPrior  = prior.length  ? prior.reduce((s, p) => s + p.price, 0) / prior.length   : null
  const priceMomentum = avgRecent && avgPrior && avgPrior > 0
    ? parseFloat(((avgRecent - avgPrior) / avgPrior * 100).toFixed(1))
    : null

  return { salesLast30, salesPerWeek, priceMomentum }
}

// ── Tooltip ────────────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload as ChartDay
  if (!d) return null
  return (
    <div className="bg-popover border border-border rounded-xl px-3 py-2.5 text-xs shadow-lg min-w-[130px]">
      <p className="font-semibold text-foreground mb-1.5">{label}</p>
      <div className="space-y-0.5">
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Avg sale</span>
          <span className="tabular-nums font-medium">${d.avg.toFixed(2)}</span>
        </div>
        {d.count > 1 && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Range</span>
            <span className="tabular-nums">${d.low.toFixed(2)}–${d.high.toFixed(2)}</span>
          </div>
        )}
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Sales</span>
          <span className="tabular-nums">{d.count}</span>
        </div>
      </div>
    </div>
  )
}

// ── Tab config ────────────────────────────────────────────────────────────────

const TAB_CONFIG: Record<EbayTab, { label: string; color: string; note: string }> = {
  raw:    { label: 'EN Raw',   color: 'hsl(var(--primary))', note: 'Ungraded English cards' },
  graded: { label: 'Graded',   color: '#f59e0b',             note: 'PSA / BGS / CGC slabs'  },
  jp:     { label: '🇯🇵 JP',   color: '#ef4444',             note: 'Japanese cards'          },
}

// ── Main component ─────────────────────────────────────────────────────────────

export function PriceHistoryChart({ catalogId }: { catalogId: string }) {
  const [enPoints, setEnPoints] = useState<SalePoint[]>([])
  const [jpPoints, setJpPoints] = useState<SalePoint[]>([])
  const [loading,  setLoading]  = useState(true)
  const [tab,      setTab]      = useState<EbayTab>('raw')
  const [rangeDays, setRangeDays] = useState(90)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    // Fetch EN and JP in parallel
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

  if (loading) return <Skeleton className="h-52 w-full rounded-xl" />

  const rawPoints    = enPoints.filter((p) => !p.graded)
  const gradedPoints = enPoints.filter((p) => p.graded)

  const pointsByTab: Record<EbayTab, SalePoint[]> = {
    raw:    rawPoints,
    graded: gradedPoints,
    jp:     jpPoints,
  }

  const activePoints = pointsByTab[tab]
  const chartData    = buildChartDays(activePoints, rangeDays)
  const signals      = computeSignals(activePoints)
  const tabCfg       = TAB_CONFIG[tab]

  const totalCount = activePoints.filter(
    (p) => Date.now() - new Date(p.date).getTime() <= rangeDays * 86_400_000,
  ).length

  // Trend delta
  const hasTrend   = chartData.length >= 3 && chartData[0].trend != null
  const trendDelta = hasTrend ? (chartData.at(-1)!.trend! - chartData[0].trend!) : 0
  const trendLabel = Math.abs(trendDelta) < 0.5 ? '→ Flat'
    : trendDelta > 0 ? `↑ +$${trendDelta.toFixed(2)}`
    : `↓ −$${Math.abs(trendDelta).toFixed(2)}`
  const trendColor = Math.abs(trendDelta) < 0.5 ? 'text-muted-foreground'
    : trendDelta > 0 ? 'text-emerald-400' : 'text-red-400'

  // Chart bounds
  const allPrices = chartData.flatMap((d) => [d.low, d.high])
  const yMin = chartData.length ? Math.max(0, Math.floor(Math.min(...allPrices) * 0.88)) : 0
  const yMax = chartData.length ? Math.ceil(Math.max(...allPrices) * 1.08) : 100

  return (
    <div className="space-y-3">

      {/* ── Tab row ── */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex bg-muted/50 rounded-lg p-0.5 gap-0.5">
          {(Object.keys(TAB_CONFIG) as EbayTab[]).map((t) => {
            const count = pointsByTab[t].filter(
              (p) => Date.now() - new Date(p.date).getTime() <= 90 * 86_400_000,
            ).length
            return (
              <button key={t} onClick={() => setTab(t)}
                className={[
                  'text-xs px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5',
                  tab === t ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                ].join(' ')}>
                {TAB_CONFIG[t].label}
                {count > 0 && (
                  <span className={['text-[10px] px-1 py-0.5 rounded-full font-normal',
                    tab === t ? 'bg-primary/15 text-primary' : 'bg-muted/60 text-muted-foreground/70'].join(' ')}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <div className="flex items-center gap-2">
          {/* Range buttons */}
          <div className="flex bg-muted/50 rounded-lg p-0.5 gap-0.5">
            {([30, 60, 90] as const).map((d) => (
              <button key={d} onClick={() => setRangeDays(d)}
                className={['text-[11px] px-2 py-1 rounded-md font-medium transition-all',
                  rangeDays === d ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'].join(' ')}>
                {d}d
              </button>
            ))}
          </div>
          {hasTrend && (
            <span className={`text-[11px] font-semibold tabular-nums ${trendColor}`}>{trendLabel}</span>
          )}
        </div>
      </div>

      {/* ── Market signals row ── */}
      {activePoints.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 text-[11px]">
            <span className="text-muted-foreground/60">Sales (30d)</span>
            <span className="tabular-nums font-semibold text-foreground">{signals.salesLast30}</span>
          </div>
          <span className="text-muted-foreground/30">·</span>
          <div className="flex items-center gap-1.5 text-[11px]">
            <span className="text-muted-foreground/60">Velocity</span>
            <span className="tabular-nums font-semibold text-foreground">{signals.salesPerWeek}/wk</span>
          </div>
          {signals.priceMomentum != null && (
            <>
              <span className="text-muted-foreground/30">·</span>
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="text-muted-foreground/60">Momentum</span>
                <span className={['tabular-nums font-semibold',
                  Math.abs(signals.priceMomentum) < 2 ? 'text-muted-foreground'
                  : signals.priceMomentum > 0 ? 'text-emerald-400' : 'text-red-400'].join(' ')}>
                  {signals.priceMomentum > 0 ? '+' : ''}{signals.priceMomentum}%
                </span>
              </div>
            </>
          )}
          <span className="text-[10px] text-muted-foreground/30 ml-auto">{tabCfg.note}</span>
        </div>
      )}

      {/* ── Empty state ── */}
      {chartData.length === 0 ? (
        <div className="h-20 flex items-center justify-center rounded-xl bg-muted/20 text-xs text-muted-foreground">
          No {tabCfg.label} sales found in the last {rangeDays} days
        </div>
      ) : (
        <>
          {/* ── Chart ── */}
          <ResponsiveContainer width="100%" height={192}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={`pg-${catalogId}-${tab}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={tabCfg.color} stopOpacity={0.18} />
                  <stop offset="95%" stopColor={tabCfg.color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.35} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis domain={[yMin, yMax]} tickFormatter={(v) => `$${v}`}
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                tickLine={false} axisLine={false} width={44} />
              <Tooltip content={<ChartTooltip />} />

              <Area type="monotone" dataKey="high" stroke="none"
                fill={`url(#pg-${catalogId}-${tab})`} legendType="none" activeDot={false} />
              <Area type="monotone" dataKey="low" stroke="none"
                fill="hsl(var(--background))" legendType="none" activeDot={false} />

              <Line type="monotone" dataKey="avg"
                stroke={tabCfg.color}
                strokeWidth={2}
                dot={{ r: 3, fill: tabCfg.color, strokeWidth: 0 }}
                activeDot={{ r: 5 }} />

              {hasTrend && (
                <Line type="linear" dataKey="trend"
                  stroke="hsl(var(--muted-foreground))"
                  strokeWidth={1.5} strokeDasharray="4 3" dot={false} activeDot={false} />
              )}
            </ComposedChart>
          </ResponsiveContainer>

          {/* ── Legend ── */}
          <div className="flex items-center gap-4 text-[10px] text-muted-foreground/70 px-1">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-6 border-t-2" style={{ borderColor: tabCfg.color }} />
              Daily avg
            </span>
            {hasTrend && (
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-6 border-t border-dashed border-muted-foreground" />
                Trend
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: tabCfg.color + '28' }} />
              Daily range
            </span>
            <span className="ml-auto text-muted-foreground/50">{totalCount} sales shown</span>
          </div>
        </>
      )}
    </div>
  )
}
