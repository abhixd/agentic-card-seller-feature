'use client'

/**
 * GradingAdvisor
 *
 * Derives grading intelligence entirely from eBay sold listings
 * (which already capture grader + grade per sale).
 *
 * Shows:
 *  · Grade price ladder  (Raw → PSA 8 → PSA 9 → PSA 10 → BGS …)
 *  · Observational gem rate  (% of graded eBay sales that were PSA 10)
 *  · ROI calculator at four PSA submission tiers
 *  · Grading score (0–100)
 *
 * PSA official pop-report (grade-level population counts) is NOT included
 * here — that requires a PSA API key. The observational gem rate from eBay
 * is a useful proxy: cards that gem often appear on eBay as PSA 10; cards
 * that don't are under-represented.
 */

import { useState, useEffect, useMemo } from 'react'
import { Loader2, Award, TrendingUp, Calculator, Info } from 'lucide-react'
import type { SalePoint } from '@/app/api/cards/sold-history/route'

// ── PSA submission tiers (current approximate pricing) ────────────────────────
const PSA_TIERS = [
  { name: 'Value',   cost: 18,  turnaround: '~100 days' },
  { name: 'Economy', cost: 25,  turnaround: '~65 days'  },
  { name: 'Regular', cost: 50,  turnaround: '~20 days'  },
  { name: 'Express', cost: 150, turnaround: '~10 days'  },
] as const

// ── Maths helpers ─────────────────────────────────────────────────────────────
function median(prices: number[]): number | null {
  if (!prices.length) return null
  const s = [...prices].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]
}

function fmt(n: number | null | undefined) {
  if (n == null) return '—'
  return `$${n.toFixed(2)}`
}

// ── Stat computation ──────────────────────────────────────────────────────────
interface GradeStats {
  grade:   number
  grader:  string
  median:  number
  count:   number
}

interface GradingStats {
  rawMedian:     number | null
  rawCount:      number
  grades:        GradeStats[]
  gemRate:       number | null   // PSA 10 / all PSA  (null if < 3 PSA sales)
  psaCount:      number
  psa10:         GradeStats | undefined
  psa9:          GradeStats | undefined
  psa8:          GradeStats | undefined
}

function computeStats(points: SalePoint[]): GradingStats {
  const rawPrices: number[] = []
  const gradeMap = new Map<string, number[]>()

  for (const p of points) {
    if (p.graded && p.grader && p.grade != null) {
      const key = `${p.grader.toUpperCase()}|${p.grade}`
      if (!gradeMap.has(key)) gradeMap.set(key, [])
      gradeMap.get(key)!.push(p.price)
    } else if (!p.graded) {
      rawPrices.push(p.price)
    }
  }

  const grades: GradeStats[] = []
  for (const [key, prices] of gradeMap.entries()) {
    const [grader, gradeStr] = key.split('|')
    grades.push({ grade: parseFloat(gradeStr), grader, median: median(prices)!, count: prices.length })
  }
  grades.sort((a, b) => b.grade - a.grade || a.grader.localeCompare(b.grader))

  const psaPoints  = points.filter(p => p.graded && p.grader?.toUpperCase() === 'PSA')
  const psa10Pts   = psaPoints.filter(p => p.grade === 10)
  const gemRate    = psaPoints.length >= 3 ? psa10Pts.length / psaPoints.length : null

  return {
    rawMedian:  median(rawPrices),
    rawCount:   rawPrices.length,
    grades,
    gemRate,
    psaCount:   psaPoints.length,
    psa10:      grades.find(g => g.grader === 'PSA' && g.grade === 10),
    psa9:       grades.find(g => g.grader === 'PSA' && g.grade === 9),
    psa8:       grades.find(g => g.grader === 'PSA' && g.grade === 8),
  }
}

// ── Grading score (0–100) ─────────────────────────────────────────────────────
// Premium score  (max 60): how much more is PSA 10 vs raw?
// Gem score      (max 20): how often does it gem?
// Value score    (max 20): is the raw card expensive enough to justify fixed fees?
function calcScore(stats: GradingStats): number | null {
  const { psa10, rawMedian, gemRate } = stats
  if (!psa10 || !rawMedian || rawMedian === 0) return null
  const premiumRatio  = psa10.median / rawMedian
  const premiumScore  = Math.min(60, Math.max(0, (premiumRatio - 1) * 10))
  const gemScore      = gemRate != null ? gemRate * 20 : 10  // unknown → assume mid
  const valueScore    = Math.min(20, rawMedian / 2.5)        // $50 raw → full 20
  return Math.round(Math.min(100, premiumScore + gemScore + valueScore))
}

function scoreStyle(score: number) {
  if (score >= 70) return { ring: 'border-emerald-400/40 bg-emerald-400/8',  text: 'text-emerald-400',  label: 'Strong candidate' }
  if (score >= 50) return { ring: 'border-amber-400/40 bg-amber-400/8',    text: 'text-amber-400',    label: 'Worth considering' }
  if (score >= 30) return { ring: 'border-orange-400/40 bg-orange-400/8',  text: 'text-orange-400',   label: 'Marginal upside' }
  return              { ring: 'border-red-400/40 bg-red-400/8',        text: 'text-red-400',      label: 'Not recommended' }
}

// ── Static grading thresholds (shown when live data unavailable) ─────────────
const GRADING_RULES = [
  { label: 'Raw card value', threshold: '≥ $20', why: 'Fixed PSA fees eat into margins below this' },
  { label: 'Condition', threshold: 'NM or better', why: 'Anything below NM rarely grades PSA 9+' },
  { label: 'Demand', threshold: 'Active comps', why: 'Graded cards need buyers — niche cards may sit' },
  { label: 'Gem premium', threshold: '2× raw or more', why: 'PSA 10 should be worth at least 2× raw to justify risk' },
]

// ── Component ─────────────────────────────────────────────────────────────────
export function GradingAdvisor({ catalogId }: { catalogId: string }) {
  const [points,      setPoints]      = useState<SalePoint[] | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [rateLimited, setRateLimited] = useState(false)
  const [tierIdx,     setTierIdx]     = useState(1)   // Economy by default

  useEffect(() => {
    fetch(`/api/cards/sold-history?catalogId=${catalogId}&lang=en`)
      .then(r => r.json())
      .then(d => {
        setPoints(d.points ?? [])
        setRateLimited(!!d.rateLimited)
        setLoading(false)
      })
      .catch(() => { setPoints([]); setLoading(false) })
  }, [catalogId])

  const stats = useMemo(() => points ? computeStats(points) : null, [points])
  const score = useMemo(() => stats ? calcScore(stats) : null, [stats])
  const tier  = PSA_TIERS[tierIdx]

  // ── Loading ────────────────────────────────────────────────────────────────
  if (loading) return (
    <div className="flex items-center gap-2 text-sm text-white/30 py-4">
      <Loader2 className="h-4 w-4 animate-spin" />
      Loading grading data…
    </div>
  )

  // ── Static fallback — eBay rate limited or no graded comps ────────────────
  if (!stats || stats.grades.length === 0) {
    return (
      <div className="space-y-4">
        {/* Context banner */}
        <div className={[
          'rounded-xl border px-4 py-3 flex items-start gap-3',
          rateLimited
            ? 'border-amber-400/20 bg-amber-400/[0.04]'
            : 'border-white/10 bg-white/[0.02]',
        ].join(' ')}>
          <Award className={`h-4 w-4 shrink-0 mt-0.5 ${rateLimited ? 'text-amber-400/60' : 'text-white/20'}`} />
          <div>
            <p className={`text-xs font-semibold ${rateLimited ? 'text-amber-300/80' : 'text-white/50'}`}>
              {rateLimited
                ? 'eBay data temporarily unavailable'
                : 'No graded sale data found'}
            </p>
            <p className="text-[10px] text-white/30 mt-0.5 leading-relaxed">
              {rateLimited
                ? 'Grading intelligence uses eBay sold comps. Showing general guidance until data loads.'
                : 'No graded sales found for this card. Showing general grading guidance below.'}
            </p>
          </div>
        </div>

        {/* PSA Fee Reference */}
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium flex items-center gap-1.5">
            <Calculator className="h-3 w-3" />
            PSA Submission Fees
          </p>
          <div className="rounded-xl overflow-hidden border border-white/8">
            {PSA_TIERS.map((t, i) => (
              <div key={t.name}
                className={`flex items-center justify-between px-3 py-2.5 text-sm ${i < PSA_TIERS.length - 1 ? 'border-b border-white/5' : ''}`}
                style={{ background: '#080c10' }}
              >
                <div>
                  <p className="text-xs font-medium text-white/70">{t.name}</p>
                  <p className="text-[10px] text-white/25">{t.turnaround}</p>
                </div>
                <span className="text-sm font-bold text-white/60 tabular-nums">${t.cost}</span>
              </div>
            ))}
          </div>
        </div>

        {/* General grading rules */}
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium flex items-center gap-1.5">
            <Info className="h-3 w-3" />
            When Grading Makes Sense
          </p>
          <div className="rounded-xl overflow-hidden border border-white/8 divide-y divide-white/[0.04]">
            {GRADING_RULES.map(r => (
              <div key={r.label} className="flex items-start justify-between gap-3 px-3 py-2.5"
                style={{ background: '#080c10' }}>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-white/65">{r.label}</p>
                  <p className="text-[10px] text-white/30 leading-snug mt-0.5">{r.why}</p>
                </div>
                <span className="text-[11px] font-semibold text-indigo-300/80 shrink-0 tabular-nums mt-0.5">{r.threshold}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="text-[10px] text-white/20 leading-relaxed">
          Live grading intelligence (gem rate, grade premium, ROI scenarios) will appear automatically
          once eBay sold history loads for this card.
        </p>
      </div>
    )
  }

  // ── ROI maths ──────────────────────────────────────────────────────────────
  const gr             = stats.gemRate ?? 0.15        // assume 15% if unknown
  const psa10Price     = stats.psa10?.median ?? null
  const psa9Price      = stats.psa9?.median  ?? (psa10Price ? psa10Price * 0.55 : null)
  const psa8Price      = stats.psa8?.median  ?? (psa9Price  ? psa9Price  * 0.65 : null)
  const rawPrice       = stats.rawMedian
  const belowTen       = psa9Price ?? psa8Price ?? (psa10Price ? psa10Price * 0.5 : null)
  const expectedValue  = psa10Price && belowTen ? gr * psa10Price + (1 - gr) * belowTen : null
  const netGain        = expectedValue && rawPrice != null ? expectedValue - rawPrice - tier.cost : null
  const isWorthIt      = netGain != null && netGain > 0

  const style = score != null ? scoreStyle(score) : null

  return (
    <div className="space-y-5">

      {/* ── Header + Score ──────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium flex items-center gap-1.5">
            <Award className="h-3 w-3 text-amber-400/70" />
            Grading Intelligence
          </p>
          {style && (
            <p className={`text-[11px] mt-0.5 font-medium ${style.text}`}>{style.label}</p>
          )}
        </div>
        {score != null && style && (
          <div className={`text-center rounded-2xl border px-4 py-2.5 min-w-[72px] ${style.ring}`}>
            <p className={`text-3xl font-bold tabular-nums leading-none ${style.text}`}>{score}</p>
            <p className="text-[9px] uppercase tracking-wider text-white/25 mt-0.5">/ 100</p>
          </div>
        )}
      </div>

      {/* ── Grade Price Ladder ───────────────────────────────────────────────── */}
      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">
          Market Prices by Grade
          <span className="normal-case tracking-normal font-normal text-white/20 ml-1.5">
            · eBay sold listings
          </span>
        </p>
        <div className="rounded-xl overflow-hidden border border-white/8">
          {/* Raw row */}
          {stats.rawMedian != null && (
            <div className="flex items-center gap-3 px-3 py-2.5 border-b border-white/5" style={{ background: '#080c10' }}>
              <span className="w-[4.5rem] text-xs font-medium text-white/40 shrink-0">Raw</span>
              <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden">
                <div className="h-full bg-white/15 rounded-full w-full" />
              </div>
              <span className="tabular-nums font-semibold text-sm w-16 text-right shrink-0 text-white/80">{fmt(stats.rawMedian)}</span>
              <span className="text-[10px] text-white/25 w-14 text-right shrink-0">{stats.rawCount} sales</span>
            </div>
          )}
          {/* Graded rows */}
          {stats.grades.map((g, i) => {
            const maxPrice  = stats.grades[0]?.median ?? 1
            const barPct    = Math.max(4, Math.round((g.median / maxPrice) * 100))
            const premium   = stats.rawMedian && stats.rawMedian > 0
              ? ((g.median / stats.rawMedian - 1) * 100).toFixed(0)
              : null
            const graderCls = g.grader === 'PSA'
              ? 'text-blue-400'
              : g.grader === 'BGS' ? 'text-purple-400' : 'text-slate-300'
            const isPsa10   = g.grader === 'PSA' && g.grade === 10
            return (
              <div key={`${g.grader}-${g.grade}`}
                className={['flex items-center gap-3 px-3 py-2.5 text-sm',
                  i < stats.grades.length - 1 ? 'border-b border-white/5' : ''].join(' ')}
                style={{ background: '#080c10' }}
              >
                <span className={`w-[4.5rem] text-xs font-bold font-mono shrink-0 ${graderCls}`}>
                  {g.grader} {g.grade}
                </span>
                <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${isPsa10 ? 'bg-emerald-400/60' : 'bg-indigo-400/40'}`}
                    style={{ width: `${barPct}%` }}
                  />
                </div>
                <span className="tabular-nums font-semibold text-sm w-16 text-right shrink-0 text-white/80">
                  {fmt(g.median)}
                </span>
                {premium != null ? (
                  <span className="text-[10px] text-emerald-400/70 w-10 text-right shrink-0">
                    +{premium}%
                  </span>
                ) : (
                  <span className="w-10 shrink-0" />
                )}
                <span className="text-[10px] text-white/25 w-14 text-right shrink-0">
                  {g.count} sales
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Gem Rate ────────────────────────────────────────────────────────── */}
      {stats.gemRate != null && (
        <div className="flex items-center gap-3 px-3 py-3 rounded-xl border border-white/8" style={{ background: '#080c10' }}>
          <TrendingUp className="h-4 w-4 text-amber-400/70 shrink-0" />
          <div className="flex-1">
            <p className="text-xs font-medium text-white/70">Observational Gem Rate</p>
            <p className="text-[10px] text-white/30 leading-snug mt-0.5">
              {Math.round(stats.gemRate * 100)}% of {stats.psaCount} PSA-graded eBay sales were PSA 10
            </p>
          </div>
          <span className="text-2xl font-bold tabular-nums text-amber-400 shrink-0">
            {Math.round(stats.gemRate * 100)}%
          </span>
        </div>
      )}

      {/* ── ROI Calculator ───────────────────────────────────────────────────── */}
      {rawPrice != null && psa10Price != null && (
        <div className="space-y-3">
          <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium flex items-center gap-1.5">
            <Calculator className="h-3 w-3" />
            Grading ROI Calculator
          </p>

          {/* Tier selector */}
          <div className="flex rounded-lg p-0.5 gap-0.5 border border-white/8" style={{ background: '#080c10' }}>
            {PSA_TIERS.map((t, i) => (
              <button key={t.name} onClick={() => setTierIdx(i)}
                className={['flex-1 rounded-md py-1.5 transition-all',
                  tierIdx === i
                    ? 'bg-indigo-600/30 border border-indigo-500/40 text-indigo-300'
                    : 'text-white/30 hover:text-white/60'].join(' ')}>
                <span className="block text-[11px] font-medium">{t.name}</span>
                <span className="block text-[10px] opacity-50">${t.cost}</span>
              </button>
            ))}
          </div>

          {/* Assumption row */}
          <div className="flex items-center gap-2 text-[10px] text-white/25 px-1">
            <Info className="h-3 w-3 shrink-0" />
            Assumes raw card at {fmt(rawPrice)} · gem rate {stats.gemRate != null ? `${Math.round(stats.gemRate * 100)}%` : '~15% (estimated)'} · {tier.turnaround} turnaround
          </div>

          {/* Scenarios */}
          <div className="rounded-xl overflow-hidden border border-white/8 divide-y divide-white/5">
            {([
              {
                label: 'Best case',
                sub:   `PSA 10 — ${Math.round(gr * 100)}% probability`,
                value: psa10Price - rawPrice - tier.cost,
              },
              {
                label: 'Expected value',
                sub:   `Weighted at ${Math.round(gr * 100)}% gem rate`,
                value: netGain,
              },
              {
                label: 'Worst case',
                sub:   'PSA 8 or lower',
                value: psa8Price != null ? psa8Price - rawPrice - tier.cost : null,
              },
            ] as const).map(({ label, sub, value }) => (
              <div key={label} className="flex items-center justify-between px-3 py-3" style={{ background: '#080c10' }}>
                <div>
                  <p className="text-xs font-medium text-white/70">{label}</p>
                  <p className="text-[10px] text-white/30">{sub}</p>
                </div>
                <span className={`tabular-nums font-bold text-sm ${
                  value == null ? 'text-white/20'
                  : value > 0 ? 'text-emerald-400'
                  : 'text-red-400'
                }`}>
                  {value == null ? '—' : value > 0 ? `+${fmt(value)}` : fmt(value)}
                </span>
              </div>
            ))}
          </div>

          {/* Verdict */}
          <div className={`rounded-xl border px-4 py-3 ${
            isWorthIt
              ? 'border-emerald-400/25 bg-emerald-400/5'
              : 'border-red-400/25 bg-red-400/5'
          }`}>
            <p className={`text-sm font-semibold ${isWorthIt ? 'text-emerald-400' : 'text-red-400'}`}>
              {isWorthIt ? '✓' : '✗'} {isWorthIt ? 'Worth grading' : 'Not worth grading'} at {tier.name} tier
            </p>
            <p className="text-[10px] text-white/30 mt-0.5 leading-snug">
              Expected net {netGain != null ? (netGain > 0 ? `+${fmt(netGain)}` : fmt(netGain)) : '—'} after
              card cost, ${tier.cost} PSA fee · based on {stats.psaCount} graded eBay sales
            </p>
          </div>

          {/* PSA pop note */}
          <div className="flex gap-2 px-1">
            <Info className="h-3 w-3 text-white/20 mt-0.5 shrink-0" />
            <p className="text-[10px] text-white/20 leading-relaxed">
              Gem rate is observational (% of graded eBay sales that were PSA 10) — not PSA&apos;s
              official pop-report ratio. Prices are medians from recent sold listings and may vary.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
