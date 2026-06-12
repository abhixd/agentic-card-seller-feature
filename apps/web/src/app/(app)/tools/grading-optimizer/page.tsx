'use client'

/**
 * Grading Submission Optimizer (A1)
 *
 * Step 1 — Pick cards (inventory or search)
 * Step 2 — Set grade probabilities + expected values per card
 * Step 3 — Set constraints (budget, deadline, min ROI)
 * Step 4 — Run MIP solver → see ranked submission plan
 */

import { useState, useCallback, useEffect } from 'react'
import {
  Search, Loader2, X, Plus, Trash2, ChevronDown, ChevronUp,
  Sparkles, DollarSign, Clock, TrendingUp, CheckCircle2, XCircle,
  AlertCircle, RotateCcw,
} from 'lucide-react'
import Image from 'next/image'
import type { CardSearchResult } from '@/types/catalog'

// ── Types ──────────────────────────────────────────────────────────────────────

interface GradeProbs { g8: number; g9: number; g10: number }

interface CardRow {
  card:         CardSearchResult
  rawValue:     number
  gradeProbs:   GradeProbs
  grade8Value:  number
  grade9Value:  number
  grade10Value: number
  expanded:     boolean
  loadingComps: boolean
}

interface Constraints {
  budget:       string
  deadlineDays: string
  minRoi:       string
}

interface GraderTier {
  grader: 'psa' | 'bgs' | 'cgc'
  tier:   'economy' | 'standard' | 'express' | 'walkthrough'
  fee:    number
  days:   number
}

interface Decision {
  card_id:         string
  card_name:       string
  submit:          boolean
  grader?:         string
  tier?:           string
  fee?:            number
  expected_value:  number
  expected_profit: number
  reason:          string
}

interface OptResult {
  status:          string
  objective_value: number
  total_fee:       number
  cards_submitted: number
  decisions:       Decision[]
  solver_used:     string
  solve_time_ms:   number
}

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_TIERS: GraderTier[] = [
  { grader: 'psa', tier: 'economy',     fee: 18,  days: 60 },
  { grader: 'psa', tier: 'standard',    fee: 25,  days: 30 },
  { grader: 'psa', tier: 'express',     fee: 50,  days: 10 },
  { grader: 'psa', tier: 'walkthrough', fee: 150, days: 2  },
]

const DEFAULT_PROBS: GradeProbs = { g8: 0.30, g9: 0.50, g10: 0.20 }

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined) {
  if (n == null || isNaN(n)) return '—'
  return `$${n.toFixed(2)}`
}

function getBestPrice(meta: any): number | null {
  const prices = meta?.tcgplayer?.prices
  if (!prices) return null
  const band = prices.holofoil ?? prices['1stEditionHolofoil'] ??
    prices['1stEditionNormal'] ?? prices.normal ?? prices.reverseHolofoil ?? null
  return band?.market ?? band?.mid ?? null
}

function getImageUrl(card: CardSearchResult): string | null {
  const meta = card.metadata_json as any
  return meta?.images?.small ?? meta?.images?.large ?? card.canonical_image_url ?? null
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)) }

function probsValid(p: GradeProbs) {
  const sum = p.g8 + p.g9 + p.g10
  return Math.abs(sum - 1.0) < 0.01
}

// ── Card search ────────────────────────────────────────────────────────────────

function CardSearch({ onAdd, addedIds }: {
  onAdd:    (card: CardSearchResult) => void
  addedIds: Set<string>
}) {
  const [query, setQuery]     = useState('')
  const [results, setResults] = useState<CardSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen]       = useState(false)

  const search = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); setOpen(false); return }
    setLoading(true)
    try {
      const res  = await fetch(`/api/catalog/search?q=${encodeURIComponent(q)}`)
      const data = await res.json()
      setResults(data.results?.slice(0, 8) ?? [])
      setOpen(true)
    } catch { setResults([]) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => search(query), 300)
    return () => clearTimeout(t)
  }, [query, search])

  return (
    <div className="relative">
      <div className="relative">
        {loading
          ? <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/30 animate-spin" />
          : <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/30" />
        }
        <input
          type="text" value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Search card name to add…"
          className="w-full rounded-xl border border-white/10 bg-white/[0.04] pl-10 pr-10 py-3 text-sm text-white placeholder:text-white/25 focus:outline-none focus:border-white/25 transition-colors"
        />
        {query && (
          <button onClick={() => { setQuery(''); setResults([]); setOpen(false) }}
            className="absolute right-3 top-1/2 -translate-y-1/2">
            <X className="h-3.5 w-3.5 text-white/30 hover:text-white/60" />
          </button>
        )}
      </div>

      {open && results.length > 0 && (
        <div className="absolute top-full mt-1 left-0 right-0 rounded-xl border border-white/10 bg-[#0f0a28] overflow-hidden z-50 shadow-2xl">
          {results.map(card => {
            const price   = getBestPrice(card.metadata_json as any)
            const img     = getImageUrl(card)
            const already = addedIds.has(card.catalog_id)
            return (
              <button key={card.catalog_id}
                onClick={() => { if (!already) { onAdd(card); setQuery(''); setOpen(false) } }}
                disabled={already}
                className={[
                  'w-full flex items-center gap-3 px-3 py-2.5 border-b border-white/5 last:border-0 text-left transition-colors',
                  already ? 'opacity-40 cursor-not-allowed' : 'hover:bg-white/[0.05]',
                ].join(' ')}
              >
                {img
                  ? <img src={img} alt={card.card_name} className="h-10 w-7 object-contain rounded shrink-0" />
                  : <div className="h-10 w-7 bg-white/5 rounded shrink-0" />
                }
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{card.card_name}</p>
                  <p className="text-[11px] text-white/40 truncate">{card.set_name}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {price != null && <span className="text-xs text-emerald-400">{fmt(price)}</span>}
                  {already
                    ? <span className="text-[10px] text-white/30">added</span>
                    : <Plus className="h-3.5 w-3.5 text-white/40" />
                  }
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Prob slider row ────────────────────────────────────────────────────────────

function ProbRow({ label, value, color, onChange }: {
  label: string; value: number; color: string; onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-[10px] font-semibold w-14 shrink-0 ${color}`}>{label}</span>
      <input type="range" min={0} max={100} step={5}
        value={Math.round(value * 100)}
        onChange={e => onChange(parseInt(e.target.value) / 100)}
        className="flex-1 accent-indigo-500 h-1"
      />
      <span className="text-[11px] text-white/60 w-9 text-right tabular-nums">{Math.round(value * 100)}%</span>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function GradingOptimizerPage() {
  const [rows,        setRows]        = useState<CardRow[]>([])
  const [constraints, setConstraints] = useState<Constraints>({
    budget: '200', deadlineDays: '30', minRoi: '0',
  })
  const [tiers,      setTiers]        = useState<GraderTier[]>([DEFAULT_TIERS[1]]) // standard default
  const [running,    setRunning]      = useState(false)
  const [result,     setResult]       = useState<OptResult | null>(null)
  const [error,      setError]        = useState<string | null>(null)

  // ── Add a card ─────────────────────────────────────────────────────────────
  const addCard = useCallback(async (card: CardSearchResult) => {
    const meta     = card.metadata_json as any
    const rawValue = getBestPrice(meta) ?? 0
    const row: CardRow = {
      card,
      rawValue,
      gradeProbs:   { ...DEFAULT_PROBS },
      grade8Value:  0,
      grade9Value:  0,
      grade10Value: 0,
      expanded:     true,
      loadingComps: true,
    }
    setRows(prev => [...prev, row])

    // Fetch eBay graded comps to auto-fill grade values
    try {
      const res  = await fetch(`/api/cards/sold-history?catalogId=${card.catalog_id}&lang=en`)
      const data = await res.json()
      const pts  = (data.points ?? []) as Array<{ price: number; graded: boolean; grader?: string; grade?: number }>

      const median = (arr: number[]) => {
        if (!arr.length) return 0
        const s = [...arr].sort((a, b) => a - b)
        const m = Math.floor(s.length / 2)
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
      }

      const psaGrade = (g: number) =>
        median(pts.filter(p => p.graded && p.grader?.toUpperCase() === 'PSA' && p.grade === g).map(p => p.price))

      const g8  = psaGrade(8)
      const g9  = psaGrade(9)
      const g10 = psaGrade(10)

      setRows(prev => prev.map(r =>
        r.card.catalog_id === card.catalog_id
          ? { ...r, grade8Value: g8, grade9Value: g9, grade10Value: g10, loadingComps: false }
          : r
      ))
    } catch {
      setRows(prev => prev.map(r =>
        r.card.catalog_id === card.catalog_id ? { ...r, loadingComps: false } : r
      ))
    }
  }, [])

  const removeCard = (id: string) => setRows(prev => prev.filter(r => r.card.catalog_id !== id))

  const updateRow = (id: string, patch: Partial<CardRow>) =>
    setRows(prev => prev.map(r => r.card.catalog_id === id ? { ...r, ...patch } : r))

  const updateProb = (id: string, key: keyof GradeProbs, val: number) => {
    setRows(prev => prev.map(r => {
      if (r.card.catalog_id !== id) return r
      const p    = { ...r.gradeProbs, [key]: val }
      const rest = 1 - val
      // redistribute remaining probability proportionally to the other two
      const others  = (['g8', 'g9', 'g10'] as (keyof GradeProbs)[]).filter(k => k !== key)
      const sumOther = others.reduce((s, k) => s + r.gradeProbs[k], 0)
      if (sumOther > 0) {
        others.forEach(k => { p[k] = clamp(r.gradeProbs[k] / sumOther * rest, 0, 1) })
      } else {
        others.forEach(k => { p[k] = rest / 2 })
      }
      // normalise to ensure sum = 1
      const total = p.g8 + p.g9 + p.g10
      if (total > 0) { p.g8 /= total; p.g9 /= total; p.g10 /= total }
      return { ...r, gradeProbs: p }
    }))
  }

  const toggleTier = (tier: GraderTier) => {
    setTiers(prev => {
      const exists = prev.find(t => t.grader === tier.grader && t.tier === tier.tier)
      return exists
        ? prev.filter(t => !(t.grader === tier.grader && t.tier === tier.tier))
        : [...prev, tier]
    })
  }

  // ── Run optimizer ──────────────────────────────────────────────────────────
  const run = async () => {
    if (!rows.length || !tiers.length) return
    setRunning(true); setError(null); setResult(null)

    const payload = {
      cards: rows.map(r => ({
        card_id:         r.card.catalog_id,
        card_name:       r.card.card_name,
        raw_value:       r.rawValue || 1,
        grade_probs:     { grade_8: r.gradeProbs.g8, grade_9: r.gradeProbs.g9, grade_10: r.gradeProbs.g10 },
        grade_8_value:   r.grade8Value,
        grade_9_value:   r.grade9Value,
        grade_10_value:  r.grade10Value,
        marketplace_fee: 0.1325,
        shipping_cost:   5.00,
      })),
      grader_tiers: tiers.map(t => ({
        grader:      t.grader,
        tier:        t.tier,
        fee:         t.fee,
        turnaround:  t.days,
        min_batch:   1,
      })),
      constraints: {
        budget:           parseFloat(constraints.budget) || 200,
        deadline_days:    parseInt(constraints.deadlineDays) || null,
        min_expected_roi: parseFloat(constraints.minRoi) || 0,
      },
    }

    try {
      const res  = await fetch('/api/optimize/grading-submission', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Optimizer error')
      setResult(data)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setRunning(false)
    }
  }

  const addedIds = new Set(rows.map(r => r.card.catalog_id))
  const canRun   = rows.length > 0 && tiers.length > 0 && !running

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-12">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Grading Optimizer</h1>
        <p className="text-sm text-white/40 mt-1">
          Add cards, set grade estimates, and let the MIP solver pick the optimal submission.
        </p>
      </div>

      {/* ── Step 1: Add cards ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">1 · Add cards</p>
        <CardSearch onAdd={addCard} addedIds={addedIds} />

        {rows.length === 0 && (
          <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-8 text-center">
            <Sparkles className="h-8 w-8 text-white/15 mx-auto mb-3" />
            <p className="text-sm text-white/40">Search for cards above to build your submission list.</p>
          </div>
        )}

        {/* Card rows */}
        <div className="space-y-2">
          {rows.map(row => {
            const img      = getImageUrl(row.card)
            const probsOk  = probsValid(row.gradeProbs)
            return (
              <div key={row.card.catalog_id}
                className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">

                {/* Row header */}
                <div className="flex items-center gap-3 p-3">
                  {img
                    ? <div className="relative h-12 w-8 shrink-0 rounded overflow-hidden border border-white/10">
                        <Image src={img} alt={row.card.card_name} fill className="object-contain" sizes="32px" unoptimized />
                      </div>
                    : <div className="h-12 w-8 bg-white/5 rounded shrink-0" />
                  }
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-white truncate">{row.card.card_name}</p>
                    <p className="text-[11px] text-white/35 truncate">{row.card.set_name}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {row.loadingComps && <Loader2 className="h-3.5 w-3.5 text-white/30 animate-spin" />}
                    {!probsOk && <AlertCircle className="h-3.5 w-3.5 text-amber-400" />}
                    <button onClick={() => updateRow(row.card.catalog_id, { expanded: !row.expanded })}
                      className="text-white/30 hover:text-white/60 transition-colors">
                      {row.expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                    <button onClick={() => removeCard(row.card.catalog_id)}
                      className="text-white/20 hover:text-red-400 transition-colors">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Expanded inputs */}
                {row.expanded && (
                  <div className="border-t border-white/8 p-3 space-y-4">

                    {/* Raw value */}
                    <div className="flex items-center gap-3">
                      <label className="text-[10px] uppercase tracking-widest text-white/30 font-medium w-24 shrink-0">Raw value</label>
                      <div className="relative flex-1">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 text-sm">$</span>
                        <input type="number" min="0" step="1" value={row.rawValue || ''}
                          onChange={e => updateRow(row.card.catalog_id, { rawValue: parseFloat(e.target.value) || 0 })}
                          className="w-full rounded-lg border border-white/10 bg-white/[0.04] pl-7 pr-3 py-1.5 text-sm text-white focus:outline-none focus:border-white/25"
                        />
                      </div>
                    </div>

                    {/* Grade probabilities */}
                    <div className="space-y-2">
                      <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">
                        Grade probabilities {!probsOk && <span className="text-amber-400 ml-1">(must sum to 100%)</span>}
                      </p>
                      <ProbRow label="PSA 8" value={row.gradeProbs.g8} color="text-amber-400"
                        onChange={v => updateProb(row.card.catalog_id, 'g8', v)} />
                      <ProbRow label="PSA 9" value={row.gradeProbs.g9} color="text-sky-400"
                        onChange={v => updateProb(row.card.catalog_id, 'g9', v)} />
                      <ProbRow label="PSA 10" value={row.gradeProbs.g10} color="text-emerald-400"
                        onChange={v => updateProb(row.card.catalog_id, 'g10', v)} />
                    </div>

                    {/* Grade values */}
                    <div className="space-y-2">
                      <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">
                        Expected sale price per grade
                        {row.loadingComps && <span className="text-white/30 ml-1">(loading comps…)</span>}
                      </p>
                      <div className="grid grid-cols-3 gap-2">
                        {([
                          { label: 'PSA 8', key: 'grade8Value' as const,  color: 'text-amber-400' },
                          { label: 'PSA 9', key: 'grade9Value' as const,  color: 'text-sky-400'   },
                          { label: 'PSA 10', key: 'grade10Value' as const, color: 'text-emerald-400' },
                        ]).map(({ label, key, color }) => (
                          <div key={key}>
                            <p className={`text-[10px] font-semibold mb-1 ${color}`}>{label}</p>
                            <div className="relative">
                              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-white/30 text-xs">$</span>
                              <input type="number" min="0" step="1" value={(row[key] as number) || ''}
                                onChange={e => updateRow(row.card.catalog_id, { [key]: parseFloat(e.target.value) || 0 })}
                                placeholder="0"
                                className="w-full rounded-lg border border-white/10 bg-white/[0.04] pl-5 pr-2 py-1.5 text-xs text-white focus:outline-none focus:border-white/25"
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* ── Step 2: Grader tiers ─────────────────────────────────────────── */}
      {rows.length > 0 && (
        <section className="space-y-3">
          <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">2 · Grader tiers to consider</p>
          <div className="grid grid-cols-2 gap-2">
            {DEFAULT_TIERS.map(t => {
              const active = tiers.some(x => x.grader === t.grader && x.tier === t.tier)
              return (
                <button key={`${t.grader}-${t.tier}`} onClick={() => toggleTier(t)}
                  className={[
                    'rounded-xl border p-3 text-left transition-all',
                    active
                      ? 'bg-indigo-600/20 border-indigo-500/40'
                      : 'bg-white/[0.02] border-white/8 hover:border-white/20',
                  ].join(' ')}>
                  <p className={`text-xs font-bold ${active ? 'text-indigo-300' : 'text-white/50'}`}>
                    PSA {t.tier.charAt(0).toUpperCase() + t.tier.slice(1)}
                  </p>
                  <p className="text-[11px] text-white/30 mt-0.5">${t.fee} · ~{t.days}d</p>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {/* ── Step 3: Constraints ───────────────────────────────────────────── */}
      {rows.length > 0 && (
        <section className="space-y-3">
          <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">3 · Constraints</p>
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-4">

            <div className="grid grid-cols-3 gap-3">
              {/* Budget */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <DollarSign className="h-3 w-3 text-white/30" />
                  <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">Budget</p>
                </div>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 text-sm">$</span>
                  <input type="number" min="0" step="10" value={constraints.budget}
                    onChange={e => setConstraints(c => ({ ...c, budget: e.target.value }))}
                    className="w-full rounded-xl border border-white/10 bg-white/[0.04] pl-7 pr-3 py-2 text-sm text-white focus:outline-none focus:border-white/25"
                  />
                </div>
              </div>

              {/* Deadline */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3 w-3 text-white/30" />
                  <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">Deadline</p>
                </div>
                <div className="relative">
                  <input type="number" min="1" step="1" value={constraints.deadlineDays}
                    onChange={e => setConstraints(c => ({ ...c, deadlineDays: e.target.value }))}
                    className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white focus:outline-none focus:border-white/25"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 text-xs">days</span>
                </div>
              </div>

              {/* Min ROI */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <TrendingUp className="h-3 w-3 text-white/30" />
                  <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">Min profit</p>
                </div>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 text-sm">$</span>
                  <input type="number" min="0" step="5" value={constraints.minRoi}
                    onChange={e => setConstraints(c => ({ ...c, minRoi: e.target.value }))}
                    className="w-full rounded-xl border border-white/10 bg-white/[0.04] pl-7 pr-3 py-2 text-sm text-white focus:outline-none focus:border-white/25"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ── Run button ────────────────────────────────────────────────────── */}
      {rows.length > 0 && (
        <button onClick={run} disabled={!canRun}
          className={[
            'w-full py-3.5 rounded-2xl font-bold text-sm transition-all flex items-center justify-center gap-2',
            canRun
              ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20'
              : 'bg-white/5 text-white/20 cursor-not-allowed',
          ].join(' ')}>
          {running ? <><Loader2 className="h-4 w-4 animate-spin" /> Running optimizer…</> : <><Sparkles className="h-4 w-4" /> Run Grading Optimizer</>}
        </button>
      )}

      {/* ── Error ─────────────────────────────────────────────────────────── */}
      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* ── Step 4: Results ───────────────────────────────────────────────── */}
      {result && (
        <section className="space-y-4">
          <p className="text-[10px] uppercase tracking-widest text-white/30 font-medium">4 · Submission plan</p>

          {/* Summary bar */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 grid grid-cols-3 gap-4">
            <div className="text-center">
              <p className="text-2xl font-black text-white">{result.cards_submitted}</p>
              <p className="text-[10px] text-white/30 mt-0.5">Cards to submit</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-black text-emerald-400">{fmt(result.objective_value)}</p>
              <p className="text-[10px] text-white/30 mt-0.5">Expected profit</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-black text-white">{fmt(result.total_fee)}</p>
              <p className="text-[10px] text-white/30 mt-0.5">Total grading fee</p>
            </div>
          </div>

          {/* Decision cards */}
          <div className="space-y-2">
            {result.decisions.map(d => (
              <div key={d.card_id}
                className={[
                  'rounded-xl border p-4 flex gap-3 items-start transition-all',
                  d.submit
                    ? 'bg-emerald-500/8 border-emerald-500/25'
                    : 'bg-white/[0.02] border-white/8',
                ].join(' ')}>
                <div className="mt-0.5 shrink-0">
                  {d.submit
                    ? <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                    : <XCircle className="h-5 w-5 text-white/20" />
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-white">{d.card_name}</p>
                    {d.submit && d.grader && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 shrink-0">
                        {d.grader.toUpperCase()} {d.tier} · {fmt(d.fee)}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-white/40 mt-1 leading-relaxed">{d.reason}</p>
                  <div className="flex gap-4 mt-2">
                    <span className="text-[11px] text-white/30">
                      EV: <span className="text-white/60 font-medium">{fmt(d.expected_value)}</span>
                    </span>
                    <span className="text-[11px] text-white/30">
                      Profit: <span className={`font-medium ${d.expected_profit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {fmt(d.expected_profit)}
                      </span>
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <p className="text-[10px] text-white/20 text-center">
            Solved with {result.solver_used} in {result.solve_time_ms.toFixed(0)}ms
          </p>

          <button onClick={() => setResult(null)}
            className="w-full flex items-center justify-center gap-1.5 py-2 text-[11px] text-white/25 hover:text-white/50 transition-colors">
            <RotateCcw className="h-3 w-3" /> Adjust and re-run
          </button>
        </section>
      )}
    </div>
  )
}
