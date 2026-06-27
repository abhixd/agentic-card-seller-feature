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
import { RefreshCw, AlertTriangle, TrendingUp, Sparkles } from 'lucide-react'
import type { SalePoint } from '@/app/api/cards/sold-history/route'
import type { JustTcgPoint } from '@/lib/justtcg/justTcgApi'

// ── Types ─────────────────────────────────────────────────────────────────────

type DataSource      = 'ebay' | 'justtcg'
type MarketTab       = 'raw' | 'graded' | 'jp'
type GradeFilter     = 'all' | string
type TcgDuration     = '1m' | '3m' | '6m' | '1y' | 'all'
type ForecastHorizon = 7 | 30 | 90

interface ForecastPoint  { date: string; yhat: number; lower: number; upper: number }
interface ChangePoint    { date: string; delta: number }

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

// ── TCG daily price helpers ───────────────────────────────────────────────────

interface TcgChartDay {
  label:          string
  isoDay:         string
  price?:         number        // actual price (null in forecast-only rows)
  trend?:         number        // OLS trend line (historical only)
  forecast?:      number        // Prophet yhat (forecast rows only)
  forecastLower?: number        // 80% CI lower
  forecastUpper?: number        // 80% CI upper
  isChangepoint?: boolean
}

function buildTcgChartDays(points: JustTcgPoint[], days: number): TcgChartDay[] {
  if (!points.length) return []

  // Apply time-window filter (points are pre-filtered but guard here too)
  const cutoff = days >= 99999 ? 0 : Date.now() - days * 86_400_000
  const filtered = cutoff > 0
    ? points.filter((p) => new Date(p.date).getTime() >= cutoff)
    : points

  if (!filtered.length) return []

  // Use year in label when range spans multiple years
  const oldestYear = new Date(filtered[0].date).getFullYear()
  const newestYear = new Date(filtered[filtered.length - 1].date).getFullYear()
  const showYear   = oldestYear !== newestYear

  const rows: TcgChartDay[] = filtered.map((p) => ({
    label:  new Date(p.date.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', {
      month: 'short', day: 'numeric',
      ...(showYear ? { year: '2-digit' } : {}),
    }),
    isoDay: p.date.slice(0, 10),
    price:  Math.round(p.price * 100) / 100,
  }))

  const reg = linearRegression(rows.map((r, i) => ({ x: i, y: r.price! })))
  if (reg) {
    return rows.map((r, i) => ({
      ...r,
      trend: Math.round((reg.slope * i + reg.intercept) * 100) / 100,
    }))
  }
  return rows
}

function mergeForecast(
  base: TcgChartDay[],
  forecast: ForecastPoint[],
  fitted: ForecastPoint[],
  changepoints: ChangePoint[],
): TcgChartDay[] {
  const cpSet = new Set(changepoints.map((c) => c.date))

  // Mark changepoints on existing rows
  const marked = base.map((r) => ({
    ...r,
    isChangepoint: cpSet.has(r.isoDay),
  }))

  // Overlay fitted values (Prophet's in-sample yhat) onto historical rows
  // We keep the actual `price` line and add a separate `forecast` track
  // so the two can be styled independently.
  const fittedByDay = new Map(fitted.map((f) => [f.date, f]))
  const withFitted = marked.map((r) => {
    const f = fittedByDay.get(r.isoDay)
    return f ? { ...r, forecast: f.yhat, forecastLower: f.lower, forecastUpper: f.upper } : r
  })

  // Append future forecast rows
  const lastActual = base.at(-1)?.isoDay ?? ''
  const futureRows: TcgChartDay[] = forecast
    .filter((f) => f.date > lastActual)
    .map((f) => ({
      label:          new Date(f.date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      isoDay:         f.date,
      // price intentionally absent — Recharts will gap the actual line here
      forecast:       Math.round(f.yhat * 100) / 100,
      forecastLower:  Math.round(f.lower * 100) / 100,
      forecastUpper:  Math.round(f.upper * 100) / 100,
      isChangepoint:  false,
    }))

  return [...withFitted, ...futureRows]
}

function TcgTooltip({ active, payload, label, color }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload as TcgChartDay
  if (!d) return null
  const isForecast = d.price == null
  return (
    <div className="rounded-xl border border-white/10 bg-black/75 backdrop-blur-md px-3.5 py-3 text-xs shadow-2xl min-w-[160px]">
      <div className="flex items-center gap-1.5 mb-2">
        <p className="font-semibold text-white/80 text-[11px] tracking-wide">{label}</p>
        {isForecast && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-300 font-medium">forecast</span>
        )}
        {d.isChangepoint && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-medium">changepoint</span>
        )}
      </div>
      {d.price != null && (
        <div className="flex justify-between gap-5">
          <span className="text-white/40">Market</span>
          <span className="tabular-nums font-bold" style={{ color }}>${d.price.toFixed(2)}</span>
        </div>
      )}
      {d.forecast != null && (
        <div className="space-y-0.5 mt-1">
          <div className="flex justify-between gap-5">
            <span className="text-white/40">{isForecast ? 'Forecast' : 'Fitted'}</span>
            <span className="tabular-nums font-bold text-violet-300">${d.forecast.toFixed(2)}</span>
          </div>
          {d.forecastLower != null && d.forecastUpper != null && (
            <div className="flex justify-between gap-5">
              <span className="text-white/40">80% CI</span>
              <span className="tabular-nums text-white/50">${d.forecastLower.toFixed(2)} – ${d.forecastUpper.toFixed(2)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Forecast evaluation panel ─────────────────────────────────────────────────

function ForecastPanel({
  chartData,
  changepoints,
  horizon,
  color,
}: {
  chartData:    TcgChartDay[]
  changepoints: ChangePoint[]
  horizon:      number
  color:        string
}) {
  // Compute MAE and MAPE on the historical fitted portion
  const historicalRows = chartData.filter((d) => d.price != null && d.forecast != null)
  const mae = historicalRows.length
    ? historicalRows.reduce((s, d) => s + Math.abs(d.price! - d.forecast!), 0) / historicalRows.length
    : null
  const mape = historicalRows.length
    ? historicalRows.reduce((s, d) => s + Math.abs((d.price! - d.forecast!) / d.price!), 0) / historicalRows.length * 100
    : null

  const futureRows = chartData.filter((d) => d.price == null && d.forecast != null)
  const lastForecast = futureRows.at(-1)
  const firstForecast = futureRows[0]
  const forecastDelta = (lastForecast && firstForecast)
    ? lastForecast.forecast! - firstForecast.forecast!
    : null

  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.02] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        <Sparkles className="h-3.5 w-3.5 text-violet-400/70" />
        <span className="text-[11px] font-semibold text-white/50 uppercase tracking-wider">
          Prophet Forecast Analysis
        </span>
        <span className="ml-auto text-[10px] text-white/20">+{horizon}d horizon</span>
      </div>

      <div className="divide-y divide-white/[0.04]">
        {/* Model fit quality */}
        <div className="grid grid-cols-3 divide-x divide-white/[0.04]">
          <div className="px-4 py-3 text-center">
            <p className="text-[10px] text-white/30 mb-1">MAE</p>
            <p className="text-[13px] font-semibold tabular-nums text-white/80">
              {mae != null ? `$${mae.toFixed(2)}` : '—'}
            </p>
          </div>
          <div className="px-4 py-3 text-center">
            <p className="text-[10px] text-white/30 mb-1">MAPE</p>
            <p className="text-[13px] font-semibold tabular-nums text-white/80">
              {mape != null ? `${mape.toFixed(1)}%` : '—'}
            </p>
          </div>
          <div className="px-4 py-3 text-center">
            <p className="text-[10px] text-white/30 mb-1">{horizon}d Δ</p>
            <p className={[
              'text-[13px] font-semibold tabular-nums',
              forecastDelta == null ? 'text-white/40'
                : forecastDelta > 0 ? 'text-emerald-400'
                : 'text-red-400',
            ].join(' ')}>
              {forecastDelta != null
                ? `${forecastDelta > 0 ? '+' : ''}$${forecastDelta.toFixed(2)}`
                : '—'}
            </p>
          </div>
        </div>

        {/* Changepoints */}
        {changepoints.length > 0 && (
          <div className="px-4 py-3">
            <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">
              Detected Changepoints
            </p>
            <div className="space-y-1.5">
              {changepoints.slice(0, 5).map((cp) => (
                <div key={cp.date} className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className={[
                      'w-1.5 h-1.5 rounded-full shrink-0',
                      cp.delta > 0 ? 'bg-emerald-400' : 'bg-red-400',
                    ].join(' ')} />
                    <span className="text-[11px] text-white/60 tabular-nums font-mono">{cp.date}</span>
                  </div>
                  <span className={[
                    'text-[11px] font-semibold tabular-nums',
                    cp.delta > 0 ? 'text-emerald-400' : 'text-red-400',
                  ].join(' ')}>
                    {cp.delta > 0 ? '↑' : '↓'} {Math.abs(cp.delta).toFixed(3)}/day
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Forecast range */}
        {futureRows.length > 0 && (
          <div className="px-4 py-3 flex items-center justify-between">
            <span className="text-[10px] text-white/30">Forecast range (80% CI)</span>
            <span className="text-[11px] tabular-nums text-white/60">
              ${Math.min(...futureRows.map(d => d.forecastLower!)).toFixed(2)}
              {' – '}
              ${Math.max(...futureRows.map(d => d.forecastUpper!)).toFixed(2)}
            </span>
          </div>
        )}
      </div>
    </div>
  )
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
  refreshing,
  onRefresh,
}: {
  gradeStats:  Map<string, GradeStat>
  rateLimited: boolean
  refreshing:  boolean
  onRefresh:   () => void
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
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="flex items-center gap-1 text-[10px] text-amber-400/60 hover:text-amber-400 transition-colors disabled:opacity-40"
          >
            <RefreshCw className={['h-3 w-3', refreshing ? 'animate-spin' : ''].join(' ')} />
            {refreshing ? 'Refreshing…' : 'Refresh eBay data'}
          </button>
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

/**
 * Local fallback forecast — a linear-trend projection with a widening band,
 * fit on the recent history. Used whenever the Prophet forecast service isn't
 * available, so the forecast line is always present when there's enough history.
 */
function localForecast(points: { date: string; price: number }[], horizonDays: number): ForecastPoint[] {
  const clean = [...points]
    .filter((p) => typeof p.price === 'number' && p.price > 0 && p.date)
    .sort((a, b) => a.date.localeCompare(b.date))
  if (clean.length < 3) return []

  const recent = clean.slice(-60)
  const t0 = new Date(recent[0].date).getTime()
  const xs = recent.map((p) => (new Date(p.date).getTime() - t0) / 86_400_000)
  const ys = recent.map((p) => p.price)
  const n = xs.length
  const sx = xs.reduce((s, v) => s + v, 0)
  const sy = ys.reduce((s, v) => s + v, 0)
  const sxx = xs.reduce((s, v) => s + v * v, 0)
  const sxy = xs.reduce((s, v, i) => s + v * ys[i], 0)
  const denom = n * sxx - sx * sx || 1
  const b = (n * sxy - sx * sy) / denom
  const a = (sy - b * sx) / n
  const resid = ys.map((y, i) => y - (a + b * xs[i]))
  const std = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / n) || ys[ys.length - 1] * 0.05

  const lastX = xs[xs.length - 1]
  const lastMs = new Date(recent[recent.length - 1].date).getTime()
  const step = Math.max(1, Math.round(horizonDays / 12))
  const out: ForecastPoint[] = []
  for (let d = step; d <= horizonDays; d += step) {
    const yhat = a + b * (lastX + d)
    const band = std * (1 + d / horizonDays) * 1.5
    out.push({
      date: new Date(lastMs + d * 86_400_000).toISOString().slice(0, 10),
      yhat: Math.max(0, yhat),
      lower: Math.max(0, yhat - band),
      upper: yhat + band,
    })
  }
  return out
}

export function PriceHistoryChart({ catalogId }: { catalogId: string }) {
  // ── Source selection ──────────────────────────────────────────────────────
  const [source,      setSource]      = useState<DataSource>('ebay')

  // ── eBay state ────────────────────────────────────────────────────────────
  const [enPoints,    setEnPoints]    = useState<SalePoint[]>([])
  const [jpPoints,    setJpPoints]    = useState<SalePoint[]>([])
  const [tab,         setTab]         = useState<MarketTab>('raw')
  const [grade,       setGrade]       = useState<GradeFilter>('all')

  // ── JustTCG state ─────────────────────────────────────────────────────────
  // tcgPoints holds ALL accumulated history returned by the API.
  // tcgDuration is the view window; filtering happens client-side.
  const [tcgPoints,     setTcgPoints]    = useState<JustTcgPoint[]>([])
  const [tcgDuration,   setTcgDuration]  = useState<TcgDuration>('6m')
  const [tcgConfigured, setTcgConfigured] = useState(true)

  // ── Forecast state ────────────────────────────────────────────────────────
  const [showForecast,     setShowForecast]     = useState(true)
  const [forecastHorizon,  setForecastHorizon]  = useState<ForecastHorizon>(30)
  const [forecastPoints,   setForecastPoints]   = useState<ForecastPoint[]>([])
  const [fittedPoints,     setFittedPoints]     = useState<ForecastPoint[]>([])
  const [changepoints,     setChangepoints]     = useState<ChangePoint[]>([])
  const [forecastLoading,  setForecastLoading]  = useState(false)
  const [forecastError,    setForecastError]    = useState<string | null>(null)

  // ── Shared state ──────────────────────────────────────────────────────────
  const [loading,     setLoading]     = useState(true)
  const [refreshing,  setRefreshing]  = useState(false)
  const [rateLimited, setRateLimited] = useState(false)
  const [tcgNotFound, setTcgNotFound] = useState(false)
  const [rangeDays,   setRangeDays]   = useState(90)

  // ── eBay fetch ────────────────────────────────────────────────────────────
  function loadEbayData(force = false) {
    const qs = force ? '&force=1' : ''
    return Promise.all([
      fetch(`/api/cards/sold-history?catalogId=${catalogId}&lang=en${qs}`).then(r => r.json()),
      fetch(`/api/cards/sold-history?catalogId=${catalogId}&lang=jp${qs}`).then(r => r.json()),
    ])
  }

  // ── JustTCG fetch ─────────────────────────────────────────────────────────
  // Always fetch all accumulated history — duration is a client-side view filter.
  function loadTcgData(force = false) {
    const qs = force ? '&force=1' : ''
    return fetch(`/api/cards/tcg-price-history?catalogId=${catalogId}${qs}`).then(r => r.json())
  }

  // ── Initial load (eBay) ───────────────────────────────────────────────────
  useEffect(() => {
    if (source !== 'ebay') return
    let cancelled = false
    setLoading(true)
    setRateLimited(false)

    loadEbayData()
      .then(([en, jp]) => {
        if (cancelled) return
        setEnPoints(en.points ?? [])
        setJpPoints(jp.points ?? [])
        if (en.rateLimited && jp.rateLimited) setRateLimited(true)
        setLoading(false)
      })
      .catch(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogId, source])

  // ── Initial load (JustTCG) ────────────────────────────────────────────────
  // Only re-fetch from the server when the card/source changes — duration
  // changes are handled purely client-side via tcgVisiblePoints.
  useEffect(() => {
    if (source !== 'justtcg') return
    let cancelled = false
    setLoading(true)
    setRateLimited(false)
    setTcgNotFound(false)

    loadTcgData()
      .then((res) => {
        if (cancelled) return
        setTcgPoints(res.points ?? [])
        setTcgConfigured(res.configured !== false)
        if (res.rateLimited) setRateLimited(true)
        if (res.notFound) setTcgNotFound(true)
        setLoading(false)
      })
      .catch(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogId, source])

  // ── Source switch resets ──────────────────────────────────────────────────
  useEffect(() => {
    setRateLimited(false)
    setLoading(true)
  }, [source])

  async function handleForceRefresh() {
    setRefreshing(true)
    try {
      if (source === 'ebay') {
        const [en, jp] = await loadEbayData(true)
        setEnPoints(en.points ?? [])
        setJpPoints(jp.points ?? [])
        setRateLimited(en.rateLimited && jp.rateLimited)
      } else {
        const res = await loadTcgData(true)
        setTcgPoints(res.points ?? [])
        setRateLimited(!!res.rateLimited)
        setTcgNotFound(!!res.notFound)
      }
    } finally {
      setRefreshing(false)
    }
  }

  // ── Forecast fetch ────────────────────────────────────────────────────────
  function loadForecast(horizon: ForecastHorizon = forecastHorizon, force = false) {
    const qs = force ? '&force=1' : ''
    return fetch(
      `/api/cards/forecast?catalogId=${catalogId}&source=${source}&horizon=${horizon}${qs}`
    ).then((r) => r.json())
  }

  useEffect(() => {
    if (!showForecast) return
    let cancelled = false
    setForecastLoading(true)
    setForecastError(null)

    loadForecast(forecastHorizon)
      .then((res) => {
        if (cancelled) return
        // On any service error/empty, leave forecastPoints empty so the LOCAL
        // trend fallback (below) draws the line instead. No hard error surfaced.
        if (res.error || !res.forecast?.length) {
          setForecastPoints([]); setFittedPoints([]); setChangepoints([])
          return
        }
        setForecastPoints(res.forecast)
        setFittedPoints(res.fitted ?? [])
        setChangepoints(res.changepoints ?? [])
      })
      .catch(() => { if (!cancelled) setForecastPoints([]) })
      .finally(() => { if (!cancelled) setForecastLoading(false) })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogId, source, showForecast, forecastHorizon])

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

  // ── TCG-specific derived values ───────────────────────────────────────────
  // Map view labels to cutoff days (99999 = "All" = show everything stored)
  const TCG_DURATION_DAYS: Record<TcgDuration, number> = {
    '1m': 30, '3m': 90, '6m': 180, '1y': 365, 'all': 99999,
  }
  const TCG_DURATION_LABELS: Record<TcgDuration, string> = {
    '1m': '1M', '3m': '3M', '6m': '6M', '1y': '1Y', 'all': 'All',
  }

  // Filter accumulated history to the selected window (client-side, no re-fetch)
  const tcgVisiblePoints = useMemo(() => {
    const days = TCG_DURATION_DAYS[tcgDuration]
    if (days >= 99999) return tcgPoints
    const cutoff = Date.now() - days * 86_400_000
    return tcgPoints.filter((p) => new Date(p.date).getTime() >= cutoff)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tcgPoints, tcgDuration])

  const tcgBaseData   = source === 'justtcg' ? buildTcgChartDays(tcgVisiblePoints, TCG_DURATION_DAYS[tcgDuration]) : []
  // Prefer the Prophet service forecast; fall back to a local trend projection so
  // the purple forecast line is always present when there's enough history.
  const forecastIsLocal = showForecast && forecastPoints.length === 0
  const effectiveForecast = (source === 'justtcg' && showForecast)
    ? (forecastPoints.length ? forecastPoints : localForecast(tcgVisiblePoints, forecastHorizon))
    : []
  const tcgChartData  = (source === 'justtcg' && showForecast && effectiveForecast.length)
    ? mergeForecast(tcgBaseData, effectiveForecast, fittedPoints, changepoints)
    : tcgBaseData
  const tcgColor      = '#a78bfa'
  const tcgHasTrend   = tcgChartData.length >= 4 && tcgChartData[0].trend != null
  const tcgTrendDelta = tcgHasTrend ? (tcgChartData.at(-1)!.trend! - tcgChartData[0].trend!) : 0
  const tcgTrendUp    = tcgTrendDelta > 0.5
  const tcgPrices     = tcgChartData.flatMap(d => [
    d.price,
    d.forecastLower,
    d.forecastUpper,
  ].filter((v): v is number => v != null))
  const tcgYMin       = tcgPrices.length ? Math.max(0, Math.floor(Math.min(...tcgPrices) * 0.85)) : 0
  const tcgYMax       = tcgPrices.length ? Math.ceil(Math.max(...tcgPrices) * 1.10) : 100
  const tcgGradId     = `grad-tcg-${catalogId.slice(0, 8)}`

  const gradId = `grad-${catalogId.slice(0, 8)}-${tab}-${grade.replace(/[\s.]/g, '')}`

  if (loading) return <Skeleton className="h-64 w-full rounded-2xl" />

  return (
    <div className="space-y-4">

      {/* ── Data source toggle + refresh ── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1 bg-white/5 rounded-xl p-1 w-fit">
          {([
            { key: 'ebay',     label: 'eBay Sales',       color: '#818cf8' },
            { key: 'justtcg',  label: 'TCGPlayer Market',  color: '#a78bfa' },
          ] as { key: DataSource; label: string; color: string }[]).map(({ key, label, color }) => (
            <button
              key={key}
              onClick={() => setSource(key)}
              className={[
                'text-xs px-3 py-1.5 rounded-lg font-medium transition-all',
                source === key ? 'text-black shadow' : 'text-white/40 hover:text-white/70',
              ].join(' ')}
              style={source === key ? { backgroundColor: color } : undefined}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          onClick={handleForceRefresh}
          disabled={refreshing}
          title="Force-reload price data from external sources"
          className={[
            'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-medium transition-all border',
            refreshing
              ? 'border-white/10 text-white/30 cursor-not-allowed'
              : 'border-white/15 text-white/50 hover:border-white/30 hover:text-white/80 hover:bg-white/[0.04]',
          ].join(' ')}
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing…' : 'Refresh data'}
        </button>
      </div>

      {/* ── JustTCG not configured notice ── */}
      {source === 'justtcg' && !tcgConfigured && (
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-3">
          <AlertTriangle className="h-3.5 w-3.5 text-white/30 shrink-0" />
          <p className="text-[11px] text-white/40">
            Add a <code className="text-white/60">JUSTTCG_API_KEY</code> environment variable to enable TCGPlayer price history.
            Get a free key at <span className="text-violet-400">justtcg.com</span>.
          </p>
        </div>
      )}

      {/* ── JustTCG chart ── */}
      {source === 'justtcg' && tcgConfigured && (
        <div className="space-y-4">
          {/* Raw NM condition badge */}
          <div className="flex items-center gap-2 rounded-xl border border-violet-500/15 bg-violet-500/5 px-3 py-2">
            <span className="text-[10px] font-semibold text-violet-300/80 uppercase tracking-wide">Raw · Near Mint (NM)</span>
            <span className="text-white/20">·</span>
            <span className="text-[10px] text-white/40">Ungraded cards only. For graded (PSA/BGS) prices, see eBay Sales tab.</span>
          </div>
          {/* Duration selector + trend badge */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-0.5 bg-white/5 rounded-xl p-1">
                {(['1m', '3m', '6m', '1y', 'all'] as TcgDuration[]).map((d) => {
                  const days    = TCG_DURATION_DAYS[d]
                  const cutoff  = Date.now() - days * 86_400_000
                  const hasData = d === 'all'
                    ? tcgPoints.length > 0
                    : tcgPoints.some((p) => new Date(p.date).getTime() >= cutoff)
                  return (
                    <button
                      key={d}
                      onClick={() => setTcgDuration(d)}
                      className={[
                        'text-[11px] px-2.5 py-1 rounded-lg font-medium transition-all relative',
                        tcgDuration === d ? 'bg-white/12 text-white' : 'text-white/35 hover:text-white/60',
                        !hasData ? 'opacity-40' : '',
                      ].join(' ')}
                      title={!hasData ? 'No data for this period yet' : undefined}
                    >
                      {TCG_DURATION_LABELS[d]}
                    </button>
                  )
                })}
              </div>
              {/* Coverage indicator: oldest stored data point */}
              {tcgPoints.length > 0 && (
                <p className="text-[9px] text-white/20 px-1">
                  History from {new Date(tcgPoints[0].date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  {' · '}{tcgPoints.length} data points
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {tcgHasTrend && (
                <span className={[
                  'text-[11px] font-semibold tabular-nums px-2 py-1 rounded-lg',
                  Math.abs(tcgTrendDelta) < 0.5 ? 'text-white/40 bg-white/5'
                    : tcgTrendUp ? 'text-emerald-400 bg-emerald-400/10'
                    : 'text-red-400 bg-red-400/10',
                ].join(' ')}>
                  {Math.abs(tcgTrendDelta) < 0.5 ? '→ Flat' : tcgTrendUp ? `↑ +$${tcgTrendDelta.toFixed(2)}` : `↓ −$${Math.abs(tcgTrendDelta).toFixed(2)}`}
                </span>
              )}
              <span className="text-[10px] text-white/20">{tcgBaseData.length} data pts</span>
            </div>
          </div>

          {/* ── Forecast controls ── */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setShowForecast((v) => !v)}
              className={[
                'flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg font-medium transition-all',
                showForecast
                  ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                  : 'bg-white/5 text-white/40 hover:text-white/70 border border-transparent',
              ].join(' ')}
            >
              <Sparkles className="h-3 w-3" />
              {forecastLoading ? 'Computing…' : 'Prophet Forecast'}
            </button>

            {showForecast && (
              <div className="flex items-center gap-0.5 bg-white/5 rounded-xl p-1">
                {([7, 30, 90] as ForecastHorizon[]).map((h) => (
                  <button key={h} onClick={() => setForecastHorizon(h)}
                    className={[
                      'text-[11px] px-2.5 py-1 rounded-lg font-medium transition-all',
                      forecastHorizon === h ? 'bg-violet-500/25 text-violet-200' : 'text-white/35 hover:text-white/60',
                    ].join(' ')}>
                    +{h}d
                  </button>
                ))}
              </div>
            )}

            {showForecast && changepoints.length > 0 && (
              <span className="text-[10px] text-amber-300/60 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400/60 inline-block" />
                {changepoints.length} changepoint{changepoints.length !== 1 ? 's' : ''} detected
              </span>
            )}

            {forecastError && (
              <span className="text-[10px] text-red-400/70">{forecastError}</span>
            )}
          </div>

          {/* Rate limited notice */}
          {rateLimited && (
            <div className="flex items-center gap-2 rounded-xl border border-amber-500/15 bg-amber-500/5 px-3.5 py-2.5">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-400/60 shrink-0" />
              <p className="text-[11px] text-amber-300/60 flex-1">{tcgNotFound ? 'No TCGPlayer price history found for this card' : 'TCGPlayer price data temporarily unavailable'}</p>
              <button onClick={handleForceRefresh} disabled={refreshing}
                className="shrink-0 flex items-center gap-1 text-[11px] text-amber-400/60 hover:text-amber-400 transition-colors disabled:opacity-40">
                <RefreshCw className={['h-3 w-3', refreshing ? 'animate-spin' : ''].join(' ')} />
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          )}

          {/* Chart */}
          {tcgBaseData.length === 0 ? (
            <div className="h-24 flex flex-col items-center justify-center rounded-2xl bg-white/[0.02] border border-white/5 gap-2">
              <TrendingUp className="h-4 w-4 text-white/15" />
              <span className="text-xs text-white/30">No TCGPlayer price data for this period</span>
              {!rateLimited && (
                <button
                  onClick={handleForceRefresh}
                  disabled={refreshing}
                  className="flex items-center gap-1 text-[10px] text-white/25 hover:text-white/50 transition-colors disabled:opacity-40"
                >
                  <RefreshCw className={['h-3 w-3', refreshing ? 'animate-spin' : ''].join(' ')} />
                  {refreshing ? 'Fetching…' : 'Try fetching data'}
                </button>
              )}
            </div>
          ) : (
            <div className="rounded-2xl overflow-hidden bg-white/[0.02] border border-white/5 p-3 pb-2">
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={tcgChartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id={tcgGradId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%"   stopColor={tcgColor} stopOpacity={0.22} />
                      <stop offset="100%" stopColor={tcgColor} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id={`${tcgGradId}-fc`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%"   stopColor="#8b5cf6" stopOpacity={0.18} />
                      <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0.04} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
                  <XAxis dataKey="label"
                    tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.25)', fontFamily: 'ui-monospace,monospace' }}
                    tickLine={false} axisLine={false} interval="preserveStartEnd" dy={4} />
                  <YAxis domain={[tcgYMin, tcgYMax]}
                    tickFormatter={(v) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`}
                    tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.25)', fontFamily: 'ui-monospace,monospace' }}
                    tickLine={false} axisLine={false} width={46} dx={-4} />
                  <Tooltip content={(props: any) => <TcgTooltip {...props} color={tcgColor} />} />

                  {/* Actual price area + line */}
                  <Area type="monotone" dataKey="price" stroke="none" fill={`url(#${tcgGradId})`}
                    connectNulls={false} legendType="none" activeDot={false} isAnimationActive={false} />
                  <Line type="monotoneX" dataKey="price" stroke={tcgColor} strokeWidth={2.5} dot={false}
                    connectNulls={false}
                    activeDot={{ r: 5, fill: tcgColor, stroke: 'rgba(0,0,0,0.4)', strokeWidth: 2 }}
                    isAnimationActive animationDuration={700} />

                  {/* OLS trend */}
                  {tcgHasTrend && !showForecast && (
                    <Line type="linear" dataKey="trend" stroke="rgba(255,255,255,0.15)"
                      strokeWidth={1.5} strokeDasharray="5 4" dot={false} activeDot={false}
                      isAnimationActive={false} />
                  )}

                  {/* Prophet forecast CI band */}
                  {showForecast && (
                    <Area type="monotone" dataKey="forecastUpper" stroke="none"
                      fill={`url(#${tcgGradId}-fc)`} legendType="none"
                      activeDot={false} isAnimationActive={false} connectNulls={false} />
                  )}
                  {showForecast && (
                    <Area type="monotone" dataKey="forecastLower" stroke="none"
                      fill="transparent" legendType="none"
                      activeDot={false} isAnimationActive={false} connectNulls={false} />
                  )}

                  {/* Prophet forecast line (fitted + future) */}
                  {showForecast && (
                    <Line type="monotone" dataKey="forecast"
                      stroke="#8b5cf6" strokeWidth={2} strokeDasharray="6 3"
                      dot={(props: any) => {
                        if (!props.payload?.isChangepoint) return <g key={props.key} />
                        return (
                          <circle key={props.key} cx={props.cx} cy={props.cy}
                            r={4} fill="#f59e0b" stroke="rgba(0,0,0,0.4)" strokeWidth={1.5} />
                        )
                      }}
                      activeDot={{ r: 4, fill: '#8b5cf6', stroke: 'rgba(0,0,0,0.4)', strokeWidth: 2 }}
                      connectNulls={false} isAnimationActive={false} />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-4 px-1 mt-1.5 text-[10px] text-white/25 flex-wrap">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-5 h-0.5 rounded" style={{ backgroundColor: tcgColor }} />
                  Market price (NM)
                </span>
                {tcgHasTrend && !showForecast && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-5 border-t border-dashed border-white/20" />
                    Trend
                  </span>
                )}
                {showForecast && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-5 border-t-2 border-dashed border-violet-400/50" />
                    Prophet forecast
                  </span>
                )}
                {showForecast && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-3 h-3 rounded-sm bg-violet-500/15" />
                    80% CI
                  </span>
                )}
                {showForecast && changepoints.length > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-2 h-2 rounded-full bg-amber-400/70" />
                    Changepoint
                  </span>
                )}
              </div>
            </div>
          )}
          {/* ── Forecast evaluation panel ── */}
          {showForecast && !forecastLoading && tcgChartData.some(d => d.forecast != null) && (
            <ForecastPanel
              chartData={tcgChartData}
              changepoints={changepoints}
              horizon={forecastHorizon}
              color={tcgColor}
            />
          )}

          <p className="text-[9px] text-white/15 text-right">
            Data via JustTCG · TCGPlayer market price · NM condition
            {showForecast && (forecastIsLocal ? ' · Forecast: local trend model' : ' · Forecast via Prophet (Meta)')}
          </p>
        </div>
      )}

      {/* ── eBay section (only shown when eBay source is active) ── */}
      {source === 'ebay' && (
        <>

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
            refreshing={refreshing}
            onRefresh={handleForceRefresh}
          />
        </>
      )}

      {/* ── Non-graded rate limited notice ── */}
      {tab !== 'graded' && rateLimited && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/15 bg-amber-500/5 px-3.5 py-2.5">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-400/60 shrink-0" />
          <p className="text-[11px] text-amber-300/60 flex-1">eBay price data temporarily unavailable — check back in a few hours</p>
          <button
            onClick={handleForceRefresh}
            disabled={refreshing}
            className="shrink-0 flex items-center gap-1 text-[11px] text-amber-400/60 hover:text-amber-400 transition-colors disabled:opacity-40"
          >
            <RefreshCw className={['h-3 w-3', refreshing ? 'animate-spin' : ''].join(' ')} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
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

        </> // close eBay section fragment
      )} {/* close source === 'ebay' */}

    </div>
  )
}
