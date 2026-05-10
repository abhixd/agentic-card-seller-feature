'use client'

/**
 * A3 — Buy Basket Optimizer
 *
 * Card-show / shop scenario: manually enter cards you're considering buying,
 * set a capital budget, and let the MIP solver pick the optimal basket
 * (including whether to grade each card after purchase).
 */

import { useState, useMemo, useId } from 'react'
import {
  ShoppingCart, Plus, Trash2, Play, Loader2,
  TrendingUp, Star, XCircle, ChevronDown, ChevronUp,
  AlertCircle, Settings2, CheckCircle2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

interface GradeProbs {
  grade_8: number
  grade_9: number
  grade_10: number
}

interface BuyCard {
  card_id:           string
  card_name:         string
  set_name:          string
  ask_price:         number
  raw_resale_value:  number
  grading_cost:      number
  marketplace_fee:   number
  grade_9_value:     number
  grade_10_value:    number
  grade_probs:       GradeProbs | null
}

interface BuyConstraints {
  capital_budget: number
  min_roi_pct:    number
  max_per_set:    number | null
}

interface BuyDecision {
  card_id:         string
  card_name:       string
  buy:             boolean
  grade_after:     boolean
  ask_price:       number
  expected_return: number
  expected_roi:    number
  reason:          string
}

interface BuyBasketResponse {
  status:                string
  objective_value:       number
  total_spend:           number
  total_expected_return: number
  portfolio_roi:         number
  decisions:             BuyDecision[]
  solver_used:           string
  solve_time_ms:         number
}

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

const DEFAULT_CONSTRAINTS: BuyConstraints = {
  capital_budget: 500,
  min_roi_pct:    0.20,
  max_per_set:    null,
}

const EMPTY_CARD_FORM = {
  card_name:        '',
  set_name:         '',
  ask_price:        '',
  raw_resale_value: '',
  grading_cost:     '25',
  grade_9_value:    '',
  grade_10_value:   '',
  grade_8_pct:      '10',
  grade_9_pct:      '60',
  grade_10_pct:     '30',
  include_grade:    false,
}

// ─────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────

function pct(v: number) { return `${(v * 100).toFixed(0)}%` }
function usd(v: number) { return `$${v.toFixed(2)}` }

function roiColor(roi: number) {
  if (roi >= 0.30) return 'text-emerald-400'
  if (roi >= 0.15) return 'text-amber-400'
  if (roi >= 0)    return 'text-white/60'
  return 'text-red-400'
}

// ─────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────

function Field({
  label, children, hint,
}: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-white/50">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-white/25">{hint}</p>}
    </div>
  )
}

function TextInput({
  value, onChange, placeholder, className,
}: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      className={cn(
        'w-full rounded-lg border border-white/10 bg-white/5 text-white text-xs px-2.5 py-1.5',
        'placeholder:text-white/20 focus:outline-none focus:ring-1 focus:ring-indigo-500/60',
        'focus:border-indigo-500/40 transition-colors',
        className,
      )}
    />
  )
}

function NumField({
  value, onChange, placeholder, prefix, suffix, className,
}: {
  value: string; onChange: (v: string) => void
  placeholder?: string; prefix?: string; suffix?: string; className?: string
}) {
  return (
    <label className={cn('relative flex items-center', className)}>
      {prefix && (
        <span className="absolute left-2.5 text-xs text-white/30 pointer-events-none">{prefix}</span>
      )}
      <input
        type="number"
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        className={cn(
          'w-full rounded-lg border border-white/10 bg-white/5 text-white text-xs py-1.5',
          'placeholder:text-white/20 focus:outline-none focus:ring-1 focus:ring-indigo-500/60',
          'focus:border-indigo-500/40 transition-colors',
          prefix ? 'pl-5 pr-2.5' : 'px-2.5',
          suffix ? 'pr-6' : '',
        )}
      />
      {suffix && (
        <span className="absolute right-2.5 text-xs text-white/30 pointer-events-none">{suffix}</span>
      )}
    </label>
  )
}

function GradeProbRow({
  label, value, onChange,
}: { label: string; value: string; onChange: (v: string) => void }) {
  const num = parseFloat(value) || 0
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-white/40 w-12 flex-shrink-0">{label}</span>
      <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-indigo-500/60 transition-all"
          style={{ width: `${Math.min(num, 100)}%` }}
        />
      </div>
      <input
        type="number"
        value={value}
        min={0} max={100} step={5}
        onChange={e => onChange(e.target.value)}
        className="w-12 rounded border border-white/10 bg-white/5 text-white text-[10px] px-1.5 py-0.5 text-right focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
      />
      <span className="text-[10px] text-white/25 w-2">%</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────

export default function BuyBasketPage() {
  const uid = useId()

  const [cards,       setCards]       = useState<BuyCard[]>([])
  const [constraints, setConstraints] = useState<BuyConstraints>(DEFAULT_CONSTRAINTS)
  const [form,        setForm]        = useState({ ...EMPTY_CARD_FORM })
  const [showForm,    setShowForm]    = useState(true)
  const [showConfig,  setShowConfig]  = useState(false)
  const [result,      setResult]      = useState<BuyBasketResponse | null>(null)
  const [running,     setRunning]     = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [expanded,    setExpanded]    = useState<Set<string>>(new Set())

  // ── Add card ────────────────────────────────────────────────────
  function addCard() {
    if (!form.card_name || !form.ask_price || !form.raw_resale_value) {
      setError('Card name, asking price, and resale value are required.')
      return
    }
    const gradeProbs: GradeProbs | null = form.include_grade && form.grade_9_value ? {
      grade_8:  (parseFloat(form.grade_8_pct)  || 0) / 100,
      grade_9:  (parseFloat(form.grade_9_pct)  || 0) / 100,
      grade_10: (parseFloat(form.grade_10_pct) || 0) / 100,
    } : null

    const card: BuyCard = {
      card_id:          `${uid}-${Date.now()}`,
      card_name:        form.card_name.trim(),
      set_name:         form.set_name.trim(),
      ask_price:        parseFloat(form.ask_price)        || 0,
      raw_resale_value: parseFloat(form.raw_resale_value) || 0,
      grading_cost:     parseFloat(form.grading_cost)     || 25,
      marketplace_fee:  0.1325,
      grade_9_value:    parseFloat(form.grade_9_value)    || 0,
      grade_10_value:   parseFloat(form.grade_10_value)   || 0,
      grade_probs:      gradeProbs,
    }
    setCards(prev => [...prev, card])
    setForm({ ...EMPTY_CARD_FORM })
    setError(null)
    setResult(null)
  }

  function removeCard(id: string) {
    setCards(prev => prev.filter(c => c.card_id !== id))
    setResult(null)
  }

  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function setF<K extends keyof typeof EMPTY_CARD_FORM>(k: K, v: (typeof EMPTY_CARD_FORM)[K]) {
    setForm(prev => ({ ...prev, [k]: v }))
  }

  // ── Run optimizer ───────────────────────────────────────────────
  async function runOptimizer() {
    if (cards.length === 0) {
      setError('Add at least one card to optimize.')
      return
    }
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const payload = {
        cards,
        constraints: {
          capital_budget: constraints.capital_budget,
          min_roi_pct:    constraints.min_roi_pct,
          max_per_set:    constraints.max_per_set,
        },
      }
      const res  = await fetch('/api/optimize/buy-basket', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data?.detail ?? data?.error ?? 'Optimizer error.')
      } else {
        setResult(data)
      }
    } catch (e: any) {
      setError(e?.message ?? 'Network error')
    } finally {
      setRunning(false)
    }
  }

  // ── Decision lookup ─────────────────────────────────────────────
  const decisionMap = useMemo(() => {
    const m: Record<string, BuyDecision> = {}
    result?.decisions.forEach(d => { m[d.card_id] = d })
    return m
  }, [result])

  const buyCards  = result?.decisions.filter(d => d.buy  && !d.grade_after) ?? []
  const gradeCards = result?.decisions.filter(d => d.buy &&  d.grade_after) ?? []
  const skipCards  = result?.decisions.filter(d => !d.buy) ?? []

  // ─────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen p-6 space-y-6"
      style={{ background: 'linear-gradient(135deg, #0d1117 0%, #0f1623 50%, #0d1117 100%)' }}>

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl"
              style={{ background: 'linear-gradient(135deg, #10b981, #047857)' }}>
              <ShoppingCart className="h-5 w-5 text-white" />
            </div>
            <h1 className="text-xl font-bold text-white">Buy Basket Optimizer</h1>
          </div>
          <p className="text-sm text-white/40 ml-12">
            At a show or shop? Add cards you're considering and find the optimal buy list within your budget.
          </p>
        </div>
        <button
          onClick={() => setShowConfig(v => !v)}
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all',
            showConfig
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : 'border-white/10 bg-white/5 text-white/50 hover:text-white/80',
          )}
        >
          <Settings2 className="h-3.5 w-3.5" />
          Constraints
        </button>
      </div>

      {/* ── Constraints panel ── */}
      {showConfig && (
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <p className="text-xs font-semibold text-white/40 uppercase tracking-widest mb-4">
            Optimization Constraints
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <Field label="Capital budget" hint="Total cash available to spend today">
              <NumField
                value={String(constraints.capital_budget)}
                onChange={v => setConstraints(p => ({ ...p, capital_budget: parseFloat(v) || 0 }))}
                prefix="$" placeholder="500"
              />
            </Field>
            <Field label="Minimum ROI" hint="Cards below this threshold are filtered out">
              <NumField
                value={String((constraints.min_roi_pct * 100).toFixed(0))}
                onChange={v => setConstraints(p => ({ ...p, min_roi_pct: (parseFloat(v) || 0) / 100 }))}
                suffix="%" placeholder="20"
              />
            </Field>
            <Field label="Max cards per set" hint="Concentration limit — leave blank for no limit">
              <NumField
                value={constraints.max_per_set === null ? '' : String(constraints.max_per_set)}
                onChange={v => setConstraints(p => ({
                  ...p, max_per_set: v === '' ? null : parseInt(v) || null,
                }))}
                placeholder="No limit"
              />
            </Field>
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3">
          <AlertCircle className="h-4 w-4 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-300">{error}</p>
          <button onClick={() => setError(null)} className="ml-auto text-red-400/50 hover:text-red-400 text-xs">✕</button>
        </div>
      )}

      {/* ── Add card form ── */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.02] overflow-hidden">
        <button
          onClick={() => setShowForm(v => !v)}
          className="flex items-center justify-between w-full px-5 py-3.5 text-left hover:bg-white/[0.02] transition-colors"
        >
          <div className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-emerald-400" />
            <span className="text-sm font-semibold text-white">Add Card</span>
          </div>
          {showForm
            ? <ChevronUp className="h-4 w-4 text-white/30" />
            : <ChevronDown className="h-4 w-4 text-white/30" />}
        </button>

        {showForm && (
          <div className="px-5 pb-5 space-y-4 border-t border-white/6">
            {/* Row 1: card identity */}
            <div className="grid grid-cols-2 gap-3 pt-4">
              <Field label="Card name *">
                <TextInput
                  value={form.card_name}
                  onChange={v => setF('card_name', v)}
                  placeholder="e.g. Charizard Base Set Holo"
                />
              </Field>
              <Field label="Set name">
                <TextInput
                  value={form.set_name}
                  onChange={v => setF('set_name', v)}
                  placeholder="e.g. Base Set"
                />
              </Field>
            </div>

            {/* Row 2: pricing */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Field label="Asking price *" hint="What the seller wants">
                <NumField value={form.ask_price} onChange={v => setF('ask_price', v)} prefix="$" placeholder="0.00" />
              </Field>
              <Field label="Raw resale value *" hint="What you can sell it for ungraded">
                <NumField value={form.raw_resale_value} onChange={v => setF('raw_resale_value', v)} prefix="$" placeholder="0.00" />
              </Field>
              <Field label="Grading fee" hint="PSA/BGS cost if graded">
                <NumField value={form.grading_cost} onChange={v => setF('grading_cost', v)} prefix="$" placeholder="25" />
              </Field>
              <div className="flex flex-col justify-end">
                <label className="flex items-center gap-2 cursor-pointer group">
                  <div
                    onClick={() => setF('include_grade', !form.include_grade)}
                    className={cn(
                      'relative inline-flex h-4 w-7 flex-shrink-0 rounded-full border-2 transition-colors cursor-pointer',
                      form.include_grade ? 'bg-indigo-500 border-indigo-500' : 'bg-white/10 border-white/10',
                    )}
                  >
                    <span className={cn(
                      'inline-block h-3 w-3 rounded-full bg-white shadow transition-transform',
                      form.include_grade ? 'translate-x-3' : 'translate-x-0',
                    )} />
                  </div>
                  <span className="text-xs text-white/50 group-hover:text-white/70 transition-colors">
                    Grade analysis
                  </span>
                </label>
              </div>
            </div>

            {/* Grade section (conditional) */}
            {form.include_grade && (
              <div className="rounded-xl border border-indigo-500/15 bg-indigo-500/5 p-4 space-y-3">
                <p className="text-xs font-semibold text-indigo-300/70 uppercase tracking-widest">
                  Grade Analysis
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="PSA 9 value" hint="Expected sale price at PSA 9">
                    <NumField value={form.grade_9_value} onChange={v => setF('grade_9_value', v)} prefix="$" placeholder="0.00" />
                  </Field>
                  <Field label="PSA 10 value" hint="Expected sale price at PSA 10">
                    <NumField value={form.grade_10_value} onChange={v => setF('grade_10_value', v)} prefix="$" placeholder="0.00" />
                  </Field>
                </div>
                <div className="space-y-2">
                  <p className="text-[10px] text-white/30 uppercase tracking-widest">Grade probability distribution</p>
                  <GradeProbRow label="PSA 8"  value={form.grade_8_pct}  onChange={v => setF('grade_8_pct',  v)} />
                  <GradeProbRow label="PSA 9"  value={form.grade_9_pct}  onChange={v => setF('grade_9_pct',  v)} />
                  <GradeProbRow label="PSA 10" value={form.grade_10_pct} onChange={v => setF('grade_10_pct', v)} />
                  {(() => {
                    const total = (parseFloat(form.grade_8_pct) || 0) +
                                  (parseFloat(form.grade_9_pct) || 0) +
                                  (parseFloat(form.grade_10_pct) || 0)
                    return total !== 100 ? (
                      <p className="text-[10px] text-amber-400">Probabilities sum to {total}% — should be 100%</p>
                    ) : null
                  })()}
                </div>
              </div>
            )}

            <button
              onClick={addCard}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all hover:scale-[1.02] active:scale-[0.98]"
              style={{ background: 'linear-gradient(135deg, #10b981, #047857)', boxShadow: '0 2px 12px rgba(16,185,129,0.3)' }}
            >
              <Plus className="h-4 w-4" />
              Add to basket
            </button>
          </div>
        )}
      </div>

      {/* ── Card list ── */}
      {cards.length > 0 && (
        <div className="rounded-2xl border border-white/8 bg-white/[0.02] overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/6">
            <span className="text-xs font-semibold text-white/50 uppercase tracking-widest">
              {cards.length} card{cards.length !== 1 ? 's' : ''} in basket
            </span>
            <span className="text-xs text-white/30">
              Total ask: <span className="text-white/60 font-medium">
                ${cards.reduce((s, c) => s + c.ask_price, 0).toFixed(2)}
              </span>
              {' '}·{' '}Budget: <span className="text-white/60 font-medium">
                ${constraints.capital_budget.toFixed(2)}
              </span>
            </span>
          </div>

          <div className="divide-y divide-white/[0.04]">
            {cards.map(card => {
              const dec     = decisionMap[card.card_id]
              const isExpand = expanded.has(card.card_id)
              const rawRoi  = card.ask_price > 0
                ? (card.raw_resale_value * (1 - 0.1325) - 0.30 - card.ask_price) / card.ask_price
                : 0

              return (
                <div key={card.card_id}>
                  <div className={cn(
                    'flex items-center gap-3 px-5 py-3 transition-colors',
                    dec?.buy ? 'bg-emerald-500/5' : '',
                  )}>
                    {/* Decision badge */}
                    <div className="flex-shrink-0 w-7 h-7 flex items-center justify-center">
                      {dec?.buy && dec.grade_after && (
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center"
                          style={{ background: 'linear-gradient(135deg,#a855f7,#7e22ce)' }}>
                          <Star className="h-3.5 w-3.5 text-white" />
                        </div>
                      )}
                      {dec?.buy && !dec.grade_after && (
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center"
                          style={{ background: 'linear-gradient(135deg,#10b981,#047857)' }}>
                          <CheckCircle2 className="h-3.5 w-3.5 text-white" />
                        </div>
                      )}
                      {dec && !dec.buy && (
                        <XCircle className="h-5 w-5 text-white/20" />
                      )}
                      {!dec && (
                        <div className="w-2 h-2 rounded-full bg-white/15" />
                      )}
                    </div>

                    {/* Card info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white truncate">{card.card_name}</span>
                        {card.grade_probs && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300">
                            Grade data
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5">
                        {card.set_name && (
                          <span className="text-[11px] text-white/35">{card.set_name}</span>
                        )}
                        <span className="text-[11px] text-white/35">
                          Ask {usd(card.ask_price)} · Resale {usd(card.raw_resale_value)} · Raw ROI <span className={roiColor(rawRoi)}>{pct(rawRoi)}</span>
                        </span>
                      </div>
                    </div>

                    {/* Decision detail */}
                    {dec && (
                      <div className="flex-shrink-0 text-right mr-2">
                        {dec.buy ? (
                          <>
                            <p className={cn('text-sm font-bold', dec.grade_after ? 'text-purple-400' : 'text-emerald-400')}>
                              {dec.grade_after ? 'Buy + Grade' : 'Buy Raw'}
                            </p>
                            <p className="text-[10px] text-white/40">
                              ROI <span className={roiColor(dec.expected_roi)}>{pct(dec.expected_roi)}</span>
                            </p>
                          </>
                        ) : (
                          <p className="text-xs text-white/25">Skip</p>
                        )}
                      </div>
                    )}

                    {/* Expand / delete */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {dec && (
                        <button onClick={() => toggleExpand(card.card_id)}
                          className="p-1 text-white/25 hover:text-white/50 transition-colors">
                          {isExpand ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        </button>
                      )}
                      <button onClick={() => removeCard(card.card_id)}
                        className="p-1 text-white/20 hover:text-red-400 transition-colors">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Expanded reason */}
                  {isExpand && dec && (
                    <div className={cn(
                      'mx-5 mb-3 rounded-lg border px-3 py-2 text-xs',
                      dec.buy
                        ? dec.grade_after
                          ? 'border-purple-500/20 bg-purple-500/5 text-purple-200/70'
                          : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-200/70'
                        : 'border-white/8 bg-white/3 text-white/40',
                    )}>
                      {dec.reason}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Run button ── */}
      {cards.length > 0 && (
        <div className="flex justify-center">
          <button
            onClick={runOptimizer}
            disabled={running}
            className={cn(
              'flex items-center gap-2.5 px-8 py-3 rounded-2xl text-sm font-semibold',
              'transition-all duration-200 shadow-lg',
              running
                ? 'bg-white/5 text-white/25 cursor-not-allowed'
                : 'text-white hover:scale-[1.02] active:scale-[0.98]',
            )}
            style={running ? {} : {
              background: 'linear-gradient(135deg, #10b981, #047857)',
              boxShadow:  '0 4px 24px rgba(16,185,129,0.35)',
            }}
          >
            {running
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Optimizing…</>
              : <><Play className="h-4 w-4" /> Optimize {cards.length} card{cards.length !== 1 ? 's' : ''}</>}
          </button>
        </div>
      )}

      {/* ── Results ── */}
      {result && (
        <div className="space-y-4">
          {/* Portfolio summary */}
          <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-semibold text-white/40 uppercase tracking-widest">
                Optimal Buy Basket
              </p>
              <span className="text-xs text-white/30">
                {result.solve_time_ms.toFixed(0)}ms · {result.solver_used}
              </span>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: 'Total spend',    value: usd(result.total_spend),           color: 'text-white' },
                { label: 'Expected return', value: usd(result.total_spend + result.total_expected_return), color: 'text-emerald-400' },
                { label: 'Expected profit', value: usd(result.total_expected_return), color: result.total_expected_return >= 0 ? 'text-emerald-400' : 'text-red-400' },
                { label: 'Portfolio ROI',   value: pct(result.portfolio_roi),         color: roiColor(result.portfolio_roi) },
              ].map(({ label, value, color }) => (
                <div key={label} className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3">
                  <p className="text-[10px] text-white/40 uppercase tracking-widest mb-1">{label}</p>
                  <p className={cn('text-xl font-bold', color)}>{value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Buy + Grade */}
          {gradeCards.length > 0 && (
            <DecisionGroup
              title="Buy & Grade"
              subtitle="Submit to PSA after purchase"
              icon={Star}
              color="text-purple-400"
              bg="bg-purple-500/10"
              border="border-purple-500/20"
              decisions={gradeCards}
            />
          )}

          {/* Buy Raw */}
          {buyCards.length > 0 && (
            <DecisionGroup
              title="Buy Raw"
              subtitle="List ungraded"
              icon={TrendingUp}
              color="text-emerald-400"
              bg="bg-emerald-500/10"
              border="border-emerald-500/20"
              decisions={buyCards}
            />
          )}

          {/* Skip */}
          {skipCards.length > 0 && (
            <DecisionGroup
              title="Skip"
              subtitle="Below ROI threshold or budget allocated elsewhere"
              icon={XCircle}
              color="text-white/30"
              bg="bg-white/[0.02]"
              border="border-white/8"
              decisions={skipCards}
              muted
            />
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Decision group component
// ─────────────────────────────────────────────────────────────────

function DecisionGroup({
  title, subtitle, icon: Icon, color, bg, border, decisions, muted = false,
}: {
  title: string; subtitle: string; icon: any
  color: string; bg: string; border: string
  decisions: BuyDecision[]; muted?: boolean
}) {
  return (
    <div className={cn('rounded-2xl border p-5 space-y-3', bg, border)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className={cn('h-4 w-4', color)} />
          <span className={cn('text-sm font-semibold', color)}>{title}</span>
          <span className="text-xs text-white/30">{subtitle}</span>
        </div>
        <span className="text-xs text-white/40">
          {decisions.length} card{decisions.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="space-y-2">
        {decisions.map(dec => (
          <div key={dec.card_id}
            className="flex items-start gap-3 rounded-lg border border-white/6 bg-black/20 px-3 py-2.5">
            <div className="flex-1 min-w-0">
              <p className={cn('text-sm font-medium', muted ? 'text-white/40' : 'text-white')}>
                {dec.card_name}
              </p>
              <p className="text-xs text-white/35 mt-0.5">{dec.reason}</p>
            </div>
            {!muted && (
              <div className="flex-shrink-0 text-right space-y-0.5">
                <p className={cn('text-sm font-bold', color)}>
                  {pct(dec.expected_roi)} ROI
                </p>
                <p className="text-[10px] text-white/30">ask ${dec.ask_price.toFixed(2)}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
