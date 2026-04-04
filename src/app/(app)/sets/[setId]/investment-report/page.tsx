'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, TrendingUp, TrendingDown, Minus } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────────

interface TopCard {
  card_name:    string
  current_price: number | null
  cagr_1yr:     number | null
  price_1yr_ago: number | null
}

interface InvestmentMetrics {
  setName:     string
  releaseYear: number | null
  enrichment: {
    print_era:         string
    reprint_count:     number
    reprint_risk:      string
    print_run_size:    string | null
    collector_notes:   string | null
    last_reprint_year: number | null
  } | null
  investment: {
    cagr_1yr:         number | null
    cagr_3yr:         number | null
    cagr_5yr:         number | null
    investment_grade: string | null
    top_cards:        TopCard[]
  } | null
  psaPopulation: {
    latestSnapshotDate: string | null
    latestPsa10Total:   number
    growthThisMonth:    number
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function gradeColor(grade: string | null | undefined): string {
  if (!grade) return 'text-zinc-400'
  const g = grade.toUpperCase()
  if (g.startsWith('A')) return 'text-emerald-400'
  if (g.startsWith('B')) return 'text-sky-400'
  if (g.startsWith('C')) return 'text-amber-400'
  if (g.startsWith('D')) return 'text-red-400'
  return 'text-zinc-400'
}

function gradeBg(grade: string | null | undefined): string {
  if (!grade) return 'bg-zinc-400/10 border-zinc-400/20'
  const g = grade.toUpperCase()
  if (g.startsWith('A')) return 'bg-emerald-400/10 border-emerald-400/25'
  if (g.startsWith('B')) return 'bg-sky-400/10 border-sky-400/25'
  if (g.startsWith('C')) return 'bg-amber-400/10 border-amber-400/25'
  if (g.startsWith('D')) return 'bg-red-400/10 border-red-400/25'
  return 'bg-zinc-400/10 border-zinc-400/20'
}

function reprintRiskColor(risk: string | null | undefined): string {
  if (!risk) return 'text-zinc-400 bg-zinc-400/10 border-zinc-400/20'
  if (risk === 'none' || risk === 'low')  return 'text-emerald-400 bg-emerald-400/10 border-emerald-400/25'
  if (risk === 'medium') return 'text-amber-400 bg-amber-400/10 border-amber-400/25'
  if (risk === 'high')   return 'text-red-400 bg-red-400/10 border-red-400/25'
  return 'text-zinc-400 bg-zinc-400/10 border-zinc-400/20'
}

function printEraLabel(era: string | null | undefined): string {
  const map: Record<string, string> = {
    wotc:       'WOTC Era',
    early_ex:   'Early EX Era',
    sv_era:     'Scarlet & Violet Era',
    swsh_era:   'Sword & Shield Era',
    sm_era:     'Sun & Moon Era',
    xy_era:     'XY Era',
    bw_era:     'Black & White Era',
  }
  return era ? (map[era] ?? era) : 'Unknown Era'
}

function cagrArrow(cagr: number | null) {
  if (cagr == null) return <Minus className="h-4 w-4 text-white/30" />
  if (cagr > 0)     return <TrendingUp   className="h-4 w-4 text-emerald-400" />
  if (cagr < 0)     return <TrendingDown className="h-4 w-4 text-red-400" />
  return <Minus className="h-4 w-4 text-white/30" />
}

function cagrColor(cagr: number | null): string {
  if (cagr == null) return 'text-white/30'
  if (cagr > 15)  return 'text-emerald-400'
  if (cagr > 0)   return 'text-emerald-300'
  if (cagr < -10) return 'text-red-400'
  if (cagr < 0)   return 'text-red-300'
  return 'text-white/50'
}

function fmt$(val: number | null): string {
  if (val == null) return '—'
  return `$${val.toFixed(2)}`
}

function fmtPct(val: number | null): string {
  if (val == null) return '—'
  const sign = val > 0 ? '+' : ''
  return `${sign}${val.toFixed(1)}%`
}

function fmtNumber(val: number): string {
  return val.toLocaleString('en-US')
}

// ── Skeleton ───────────────────────────────────────────────────────────────────

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-white/8 ${className ?? ''}`} />
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function SetInvestmentReportPage() {
  const params = useParams()
  const setId  = params.setId as string

  const [data,    setData]    = useState<InvestmentMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    if (!setId) return
    setLoading(true)
    fetch(`/api/sets/${setId}/investment-metrics`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((json: InvestmentMetrics) => {
        setData(json)
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }, [setId])

  const setName = data?.setName ?? decodeURIComponent(setId)
  const grade   = data?.investment?.investment_grade ?? null

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">

        {/* Back link */}
        <Link
          href={`/sets/${setId}`}
          className="inline-flex items-center gap-1.5 text-sm text-white/40 hover:text-white/70 mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to {setName}
        </Link>

        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-4 mb-8">
          <div>
            {loading
              ? <Skeleton className="h-8 w-52 mb-2" />
              : <h1 className="text-2xl font-bold text-white">{setName}</h1>
            }
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              {loading ? (
                <Skeleton className="h-5 w-32" />
              ) : (
                <>
                  {data?.releaseYear && (
                    <span className="text-sm text-white/40">{data.releaseYear}</span>
                  )}
                  {data?.enrichment?.print_era && (
                    <>
                      <span className="text-white/20">·</span>
                      <span className="text-xs px-2 py-0.5 rounded-full border border-white/12 bg-white/5 text-white/50">
                        {printEraLabel(data.enrichment.print_era)}
                      </span>
                    </>
                  )}
                  {data?.enrichment?.print_run_size && (
                    <span className="text-xs px-2 py-0.5 rounded-full border border-white/12 bg-white/5 text-white/40 capitalize">
                      {data.enrichment.print_run_size.replace(/_/g, ' ')}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Investment grade badge */}
          <div className="flex-shrink-0">
            {loading ? (
              <Skeleton className="h-20 w-20 rounded-2xl" />
            ) : grade ? (
              <div className={`flex flex-col items-center justify-center w-20 h-20 rounded-2xl border-2 ${gradeBg(grade)}`}>
                <span className={`text-4xl font-black leading-none ${gradeColor(grade)}`}>{grade}</span>
                <span className="text-[9px] text-white/30 uppercase tracking-wider mt-1">grade</span>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center w-20 h-20 rounded-2xl border border-white/10 bg-white/3">
                <span className="text-2xl font-black text-white/20">—</span>
                <span className="text-[9px] text-white/20 uppercase tracking-wider mt-1">no data</span>
              </div>
            )}
          </div>
        </div>

        {/* ── CAGR Cards ─────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          {(['1yr', '3yr', '5yr'] as const).map(period => {
            const key   = `cagr_${period}` as 'cagr_1yr' | 'cagr_3yr' | 'cagr_5yr'
            const value = data?.investment?.[key] ?? null
            return (
              <div
                key={period}
                className="rounded-xl border border-white/8 bg-white/3 p-4 flex flex-col gap-1"
              >
                <span className="text-[11px] text-white/35 uppercase tracking-wider font-medium">{period} CAGR</span>
                {loading ? (
                  <Skeleton className="h-7 w-20 mt-1" />
                ) : (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {cagrArrow(value)}
                    <span className={`text-2xl font-black tabular-nums ${cagrColor(value)}`}>
                      {fmtPct(value)}
                    </span>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* ── Reprint Risk + PSA Supply row ──────────────────────────────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">

          {/* Reprint Risk */}
          <div className="rounded-xl border border-white/8 bg-white/3 p-4">
            <p className="text-[11px] text-white/35 uppercase tracking-wider font-medium mb-3">Reprint Risk</p>
            {loading ? (
              <Skeleton className="h-7 w-24" />
            ) : (
              <div className="flex items-center gap-3">
                <span className={`text-sm font-bold px-3 py-1.5 rounded-lg border capitalize ${reprintRiskColor(data?.enrichment?.reprint_risk)}`}>
                  {data?.enrichment?.reprint_risk ?? 'Unknown'}
                </span>
                {data?.enrichment?.reprint_count != null && data.enrichment.reprint_count > 0 && (
                  <span className="text-xs text-white/35">
                    {data.enrichment.reprint_count}× reprinted
                    {data.enrichment.last_reprint_year ? ` · last ${data.enrichment.last_reprint_year}` : ''}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* PSA Supply */}
          <div className="rounded-xl border border-white/8 bg-white/3 p-4">
            <p className="text-[11px] text-white/35 uppercase tracking-wider font-medium mb-3">PSA 10 Supply</p>
            {loading ? (
              <Skeleton className="h-7 w-28" />
            ) : (
              <div className="flex items-center gap-4">
                <div>
                  <span className="text-2xl font-black text-white tabular-nums">
                    {data ? fmtNumber(data.psaPopulation.latestPsa10Total) : '—'}
                  </span>
                  <p className="text-[10px] text-white/30 mt-0.5">
                    {data?.psaPopulation.latestSnapshotDate
                      ? `as of ${data.psaPopulation.latestSnapshotDate}`
                      : 'no snapshot data'}
                  </p>
                </div>
                {data && data.psaPopulation.growthThisMonth !== 0 && (
                  <div className={`text-sm font-semibold tabular-nums ${data.psaPopulation.growthThisMonth > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                    {data.psaPopulation.growthThisMonth > 0 ? '+' : ''}
                    {fmtNumber(data.psaPopulation.growthThisMonth)} this month
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Top Cards Table ────────────────────────────────────────────────── */}
        <div className="rounded-xl border border-white/8 bg-white/3 mb-6 overflow-hidden">
          <div className="px-4 py-3 border-b border-white/6">
            <p className="text-sm font-semibold text-white/70">Top Cards</p>
          </div>

          {loading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : !data?.investment?.top_cards?.length ? (
            <div className="px-4 py-8 text-center text-sm text-white/25">
              No top card data available yet.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/6">
                  <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-white/35 uppercase tracking-wider">Card</th>
                  <th className="text-right px-4 py-2.5 text-[11px] font-semibold text-white/35 uppercase tracking-wider">Price</th>
                  <th className="text-right px-4 py-2.5 text-[11px] font-semibold text-white/35 uppercase tracking-wider">1yr CAGR</th>
                  <th className="text-right px-4 py-2.5 text-[11px] font-semibold text-white/35 uppercase tracking-wider hidden sm:table-cell">1yr Ago</th>
                </tr>
              </thead>
              <tbody>
                {data.investment.top_cards.map((card, i) => (
                  <tr
                    key={i}
                    className="border-b border-white/4 last:border-0 hover:bg-white/3 transition-colors"
                  >
                    <td className="px-4 py-3 text-white/80 font-medium">{card.card_name}</td>
                    <td className="px-4 py-3 text-right font-bold tabular-nums" style={{ color: '#34d399' }}>
                      {fmt$(card.current_price)}
                    </td>
                    <td className={`px-4 py-3 text-right font-semibold tabular-nums ${cagrColor(card.cagr_1yr)}`}>
                      {fmtPct(card.cagr_1yr)}
                    </td>
                    <td className="px-4 py-3 text-right text-white/35 tabular-nums hidden sm:table-cell">
                      {fmt$(card.price_1yr_ago)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Collector Notes ────────────────────────────────────────────────── */}
        {(loading || data?.enrichment?.collector_notes) && (
          <div className="rounded-xl border border-white/8 bg-white/3 p-4">
            <p className="text-[11px] text-white/35 uppercase tracking-wider font-medium mb-2">Collector Notes</p>
            {loading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            ) : (
              <p className="text-sm text-white/60 leading-relaxed">
                {data?.enrichment?.collector_notes}
              </p>
            )}
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 mt-4">
            <p className="text-sm text-red-400">Failed to load investment data: {error}</p>
          </div>
        )}

      </div>
    </div>
  )
}
