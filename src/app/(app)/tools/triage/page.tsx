'use client'

/**
 * A2 — Bulk Inventory Triage Optimizer
 *
 * Loads all owned inventory items, lets the user set global constraints
 * and per-card overrides (raw value, grading eligibility, etc.), then
 * runs the MIP assignment solver to produce an optimal work queue.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Layers2, Play, RefreshCw, CheckSquare, Square,
  TrendingUp, Star, Package, PauseCircle, ShoppingBag,
  ChevronDown, ChevronUp, Settings2, AlertCircle, Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

interface CardSummary {
  card_name:          string
  set_name:           string
  franchise_or_brand: string
  year:               number | null
  variant:            string | null
}

interface InventoryListItem {
  item_id:                string
  catalog_id:             string
  status:                 string
  acquisition_cost:       number
  estimated_market_value: number | null
  recommendation_type:    string | null
  card:                   CardSummary
}

interface TriageRow extends InventoryListItem {
  // optimizer inputs (editable)
  raw_value:             number
  bulk_value:            number
  grade_expected_profit: number
  liquidity_score:       number
  time_to_list_hrs:      number
  time_to_lot_hrs:       number
  lot_eligible:          boolean
  grade_eligible:        boolean
  selected:              boolean
}

interface TriageConstraints {
  labor_hours_budget: number
  grading_budget:     number
  min_list_margin:    number
  hourly_labor_rate:  number
}

interface TriageDecision {
  card_id:   string
  card_name: string
  action:    string
  net_value: number
  reason:    string
}

interface TriageResponse {
  status:          string
  objective_value: number
  decisions:       TriageDecision[]
  summary:         Record<string, number>
  total_net_value: number
  solver_used:     string
  solve_time_ms:   number
}

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

const ACTION_META: Record<string, {
  label: string; color: string; bg: string; border: string; icon: any; desc: string
}> = {
  list_individually: {
    label:  'List Individually',
    color:  'text-emerald-400',
    bg:     'bg-emerald-500/10',
    border: 'border-emerald-500/20',
    icon:   TrendingUp,
    desc:   'Photograph & list on eBay at full price',
  },
  grade: {
    label:  'Send to Grading',
    color:  'text-purple-400',
    bg:     'bg-purple-500/10',
    border: 'border-purple-500/20',
    icon:   Star,
    desc:   'Submit to PSA for potential grade uplift',
  },
  lot: {
    label:  'Add to Lot',
    color:  'text-amber-400',
    bg:     'bg-amber-500/10',
    border: 'border-amber-500/20',
    icon:   Package,
    desc:   'Bundle with similar cards for efficiency',
  },
  hold: {
    label:  'Hold',
    color:  'text-slate-400',
    bg:     'bg-slate-500/10',
    border: 'border-slate-500/20',
    icon:   PauseCircle,
    desc:   'Retain — insufficient margin or no clear path',
  },
  bulk_sell: {
    label:  'Bulk Sell',
    color:  'text-orange-400',
    bg:     'bg-orange-500/10',
    border: 'border-orange-500/20',
    icon:   ShoppingBag,
    desc:   'Sell to buylist / dealer at low value',
  },
}

const DEFAULT_CONSTRAINTS: TriageConstraints = {
  labor_hours_budget: 8,
  grading_budget:     200,
  min_list_margin:    0.15,
  hourly_labor_rate:  15,
}

function toTriageRow(item: InventoryListItem): TriageRow {
  const raw   = item.estimated_market_value ?? item.acquisition_cost ?? 0
  const acq   = item.acquisition_cost ?? 0
  // Grade eligibility: only if raw value > $10 and recommendation suggests grading
  const gradeRec  = item.recommendation_type === 'GRADE'
  const gradeElig = raw > 10
  // Rough grade expected profit: 30% uplift on raw, minus $25 PSA standard fee, minus 13.25% eBay fee
  const gradeUp   = raw * 1.30 * (1 - 0.1325) - 0.30 - 25 - acq
  return {
    ...item,
    raw_value:             raw,
    bulk_value:            parseFloat((raw * 0.40).toFixed(2)),
    grade_expected_profit: gradeElig ? parseFloat(gradeUp.toFixed(2)) : 0,
    liquidity_score:       raw > 50 ? 0.4 : raw > 10 ? 0.6 : 0.8,
    time_to_list_hrs:      0.25,
    time_to_lot_hrs:       0.05,
    lot_eligible:          true,
    grade_eligible:        gradeElig,
    selected:              item.status === 'owned',
  }
}

// ─────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────

function NumInput({
  value, onChange, min = 0, step = 0.01, prefix, suffix, className,
}: {
  value: number; onChange: (v: number) => void
  min?: number; step?: number; prefix?: string; suffix?: string; className?: string
}) {
  return (
    <label className={cn('relative flex items-center', className)}>
      {prefix && (
        <span className="absolute left-2 text-xs text-white/30 pointer-events-none">{prefix}</span>
      )}
      <input
        type="number"
        value={value}
        min={min}
        step={step}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        className={cn(
          'w-full rounded-lg border border-white/10 bg-white/5 text-white text-xs',
          'focus:outline-none focus:ring-1 focus:ring-indigo-500/60 focus:border-indigo-500/40',
          'py-1 transition-colors',
          prefix ? 'pl-5 pr-2' : 'px-2',
          suffix ? 'pr-7' : '',
        )}
      />
      {suffix && (
        <span className="absolute right-2 text-xs text-white/30 pointer-events-none">{suffix}</span>
      )}
    </label>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-4 w-7 flex-shrink-0 cursor-pointer rounded-full border-2 transition-colors duration-200',
        checked ? 'bg-indigo-500 border-indigo-500' : 'bg-white/10 border-white/10',
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-3 w-3 rounded-full bg-white shadow transition-transform duration-200',
          checked ? 'translate-x-3' : 'translate-x-0',
        )}
      />
    </button>
  )
}

function SummaryBadge({ action, count, netValue }: { action: string; count: number; netValue: number }) {
  const meta = ACTION_META[action]
  if (!meta || count === 0) return null
  const Icon = meta.icon
  return (
    <div className={cn('flex flex-col gap-1 rounded-xl border px-4 py-3', meta.bg, meta.border)}>
      <div className="flex items-center gap-2">
        <Icon className={cn('h-4 w-4', meta.color)} />
        <span className={cn('text-sm font-semibold', meta.color)}>{meta.label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold text-white">{count}</span>
        <span className="text-xs text-white/40">cards</span>
        <span className="ml-auto text-sm font-semibold text-white/70">
          ${netValue.toFixed(2)}
        </span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────

export default function TriagePage() {
  const [rows,        setRows]        = useState<TriageRow[]>([])
  const [constraints, setConstraints] = useState<TriageConstraints>(DEFAULT_CONSTRAINTS)
  const [result,      setResult]      = useState<TriageResponse | null>(null)
  const [loadingInv,  setLoadingInv]  = useState(true)
  const [running,     setRunning]     = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [showConfig,  setShowConfig]  = useState(false)
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

  // ── Load inventory ──────────────────────────────────────────────
  useEffect(() => {
    setLoadingInv(true)
    fetch('/api/inventory')
      .then(r => r.json())
      .then(({ items }: { items: InventoryListItem[] }) => {
        const owned = (items ?? []).filter(i => i.status === 'owned')
        setRows(owned.map(toTriageRow))
      })
      .catch(() => setError('Failed to load inventory'))
      .finally(() => setLoadingInv(false))
  }, [])

  // ── Derived stats ───────────────────────────────────────────────
  const selectedCount   = useMemo(() => rows.filter(r => r.selected).length, [rows])
  const totalRawValue   = useMemo(() =>
    rows.filter(r => r.selected).reduce((s, r) => s + r.raw_value, 0), [rows])

  // ── Helpers ─────────────────────────────────────────────────────
  function updateRow(itemId: string, patch: Partial<TriageRow>) {
    setRows(prev => prev.map(r => r.item_id === itemId ? { ...r, ...patch } : r))
  }

  function toggleAll() {
    const allSelected = rows.every(r => r.selected)
    setRows(prev => prev.map(r => ({ ...r, selected: !allSelected })))
  }

  function toggleExpand(id: string) {
    setExpandedRows(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function updateConstraint<K extends keyof TriageConstraints>(k: K, v: TriageConstraints[K]) {
    setConstraints(prev => ({ ...prev, [k]: v }))
  }

  // ── Run optimizer ───────────────────────────────────────────────
  async function runOptimizer() {
    const selected = rows.filter(r => r.selected)
    if (selected.length === 0) {
      setError('Select at least one card to triage.')
      return
    }
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const payload = {
        cards: selected.map(r => ({
          card_id:               r.item_id,
          card_name:             r.card.card_name,
          set_name:              r.card.set_name,
          raw_value:             r.raw_value,
          liquidity_score:       r.liquidity_score,
          time_to_list_hrs:      r.time_to_list_hrs,
          time_to_lot_hrs:       r.time_to_lot_hrs,
          grade_expected_profit: r.grade_expected_profit,
          bulk_value:            r.bulk_value,
          lot_eligible:          r.lot_eligible,
          grade_eligible:        r.grade_eligible,
        })),
        constraints: {
          labor_hours_budget: constraints.labor_hours_budget,
          grading_budget:     constraints.grading_budget,
          min_list_margin:    constraints.min_list_margin,
          hourly_labor_rate:  constraints.hourly_labor_rate,
        },
      }
      const res  = await fetch('/api/optimize/triage', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data?.detail ?? data?.error ?? 'Optimizer returned an error.')
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
    const m: Record<string, TriageDecision> = {}
    result?.decisions.forEach(d => { m[d.card_id] = d })
    return m
  }, [result])

  // ── Results grouped by action ───────────────────────────────────
  const groupedDecisions = useMemo(() => {
    if (!result) return {}
    const groups: Record<string, TriageDecision[]> = {}
    for (const action of Object.keys(ACTION_META)) {
      const decs = result.decisions.filter(d => d.action === action)
      if (decs.length) groups[action] = decs
    }
    return groups
  }, [result])

  const netByAction = useMemo(() => {
    const m: Record<string, number> = {}
    result?.decisions.forEach(d => {
      m[d.action] = (m[d.action] ?? 0) + d.net_value
    })
    return m
  }, [result])

  // ─────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen p-6 space-y-6"
      style={{ background: 'linear-gradient(135deg, #0d1117 0%, #0f1623 50%, #0d1117 100%)' }}>

      {/* ── Page header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl"
              style={{ background: 'linear-gradient(135deg, #f59e0b, #b45309)' }}>
              <Layers2 className="h-5 w-5 text-white" />
            </div>
            <h1 className="text-xl font-bold text-white">Bulk Inventory Triage</h1>
          </div>
          <p className="text-sm text-white/40 ml-12">
            Assign each card to its highest-value action within your labor & grading budget.
          </p>
        </div>
        <button
          onClick={() => setShowConfig(v => !v)}
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all',
            showConfig
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
              : 'border-white/10 bg-white/5 text-white/50 hover:text-white/80 hover:bg-white/8',
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs text-white/50">Labor hours budget</label>
              <NumInput
                value={constraints.labor_hours_budget}
                onChange={v => updateConstraint('labor_hours_budget', v)}
                min={0.5} step={0.5} suffix="hrs"
              />
              <p className="text-[10px] text-white/25">Total hrs available to process cards</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-white/50">Grading budget</label>
              <NumInput
                value={constraints.grading_budget}
                onChange={v => updateConstraint('grading_budget', v)}
                min={0} step={25} prefix="$"
              />
              <p className="text-[10px] text-white/25">Max total spend on PSA/BGS fees</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-white/50">Min list margin</label>
              <NumInput
                value={constraints.min_list_margin}
                onChange={v => updateConstraint('min_list_margin', Math.min(v, 0.99))}
                min={0} step={0.01} suffix="%"
              />
              <p className="text-[10px] text-white/25">Min net margin to list individually</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-white/50">Hourly labor rate</label>
              <NumInput
                value={constraints.hourly_labor_rate}
                onChange={v => updateConstraint('hourly_labor_rate', v)}
                min={1} step={1} prefix="$"
              />
              <p className="text-[10px] text-white/25">Your time opportunity cost per hour</p>
            </div>
          </div>
        </div>
      )}

      {/* ── Error banner ── */}
      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3">
          <AlertCircle className="h-4 w-4 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-300">{error}</p>
          <button onClick={() => setError(null)} className="ml-auto text-red-400/50 hover:text-red-400 text-xs">✕</button>
        </div>
      )}

      {/* ── Inventory table ── */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.02] overflow-hidden">
        {/* Table header */}
        <div className="flex items-center justify-between gap-4 px-4 py-3 border-b border-white/6">
          <div className="flex items-center gap-3">
            <button onClick={toggleAll}
              className="text-white/40 hover:text-white/70 transition-colors">
              {rows.every(r => r.selected)
                ? <CheckSquare className="h-4 w-4" />
                : <Square className="h-4 w-4" />}
            </button>
            <span className="text-xs font-semibold text-white/50 uppercase tracking-widest">
              {loadingInv ? 'Loading…' : `${selectedCount} / ${rows.length} cards selected`}
            </span>
          </div>
          {!loadingInv && (
            <span className="text-xs text-white/30">
              Total raw value: <span className="text-white/60 font-medium">${totalRawValue.toFixed(2)}</span>
            </span>
          )}
        </div>

        {/* Column headers */}
        {!loadingInv && rows.length > 0 && (
          <div className="hidden md:grid px-4 py-2 border-b border-white/6 text-[10px] font-semibold uppercase tracking-widest text-white/25"
            style={{ gridTemplateColumns: '2rem 1fr 5rem 5rem 5rem 4rem 4rem 4rem 4rem' }}>
            <span />
            <span>Card</span>
            <span>Raw $</span>
            <span>Bulk $</span>
            <span>Grade EV $</span>
            <span>List hrs</span>
            <span>Lot hrs</span>
            <span>Lot?</span>
            <span>Grade?</span>
          </div>
        )}

        {/* Rows */}
        {loadingInv ? (
          <div className="flex items-center justify-center py-16 gap-3 text-white/30">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading inventory…</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2 text-white/30">
            <Package className="h-8 w-8 opacity-40" />
            <p className="text-sm">No owned inventory found.</p>
            <p className="text-xs text-white/20">Add cards to inventory first.</p>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {rows.map(row => {
              const dec      = decisionMap[row.item_id]
              const expanded = expandedRows.has(row.item_id)
              const meta     = dec ? ACTION_META[dec.action] : null

              return (
                <div key={row.item_id}
                  className={cn(
                    'transition-colors',
                    row.selected ? '' : 'opacity-40',
                    dec ? (meta?.bg ?? '') : '',
                  )}>
                  {/* Main row */}
                  <div className="grid items-center gap-2 px-4 py-2.5"
                    style={{ gridTemplateColumns: '2rem 1fr 5rem 5rem 5rem 4rem 4rem 4rem 4rem' }}>

                    {/* Select */}
                    <button onClick={() => updateRow(row.item_id, { selected: !row.selected })}
                      className="text-white/40 hover:text-white/70 transition-colors justify-self-start">
                      {row.selected
                        ? <CheckSquare className="h-4 w-4 text-indigo-400" />
                        : <Square className="h-4 w-4" />}
                    </button>

                    {/* Card name + action badge */}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-white truncate">
                          {row.card.card_name}
                        </span>
                        {dec && meta && (
                          <span className={cn(
                            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border',
                            meta.color, meta.bg, meta.border,
                          )}>
                            <meta.icon className="h-2.5 w-2.5" />
                            {meta.label}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[11px] text-white/35 truncate">{row.card.set_name}</span>
                        {dec && (
                          <button onClick={() => toggleExpand(row.item_id)}
                            className="text-white/25 hover:text-white/50 transition-colors">
                            {expanded
                              ? <ChevronUp className="h-3 w-3" />
                              : <ChevronDown className="h-3 w-3" />}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Raw value */}
                    <NumInput value={row.raw_value} onChange={v => updateRow(row.item_id, { raw_value: v })} prefix="$" step={0.5} />

                    {/* Bulk value */}
                    <NumInput value={row.bulk_value} onChange={v => updateRow(row.item_id, { bulk_value: v })} prefix="$" step={0.5} />

                    {/* Grade EV */}
                    <NumInput value={row.grade_expected_profit} onChange={v => updateRow(row.item_id, { grade_expected_profit: v })} prefix="$" step={0.5} />

                    {/* Time to list */}
                    <NumInput value={row.time_to_list_hrs} onChange={v => updateRow(row.item_id, { time_to_list_hrs: v })} suffix="h" step={0.05} />

                    {/* Time to lot */}
                    <NumInput value={row.time_to_lot_hrs} onChange={v => updateRow(row.item_id, { time_to_lot_hrs: v })} suffix="h" step={0.05} />

                    {/* Lot eligible */}
                    <div className="flex justify-center">
                      <Toggle checked={row.lot_eligible} onChange={v => updateRow(row.item_id, { lot_eligible: v })} />
                    </div>

                    {/* Grade eligible */}
                    <div className="flex justify-center">
                      <Toggle checked={row.grade_eligible} onChange={v => updateRow(row.item_id, { grade_eligible: v })} />
                    </div>
                  </div>

                  {/* Expanded reason */}
                  {expanded && dec && (
                    <div className={cn(
                      'mx-4 mb-2.5 rounded-lg border px-3 py-2 text-xs',
                      meta?.border ?? 'border-white/10',
                      meta?.bg ?? 'bg-white/5',
                    )}>
                      <span className={cn('font-semibold', meta?.color)}>{meta?.label}: </span>
                      <span className="text-white/60">{dec.reason}</span>
                      <span className="ml-3 text-white/40">
                        Net value: <span className="text-white/70 font-medium">${dec.net_value.toFixed(2)}</span>
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Run button ── */}
      <div className="flex justify-center">
        <button
          onClick={runOptimizer}
          disabled={running || selectedCount === 0 || loadingInv}
          className={cn(
            'flex items-center gap-2.5 px-8 py-3 rounded-2xl text-sm font-semibold',
            'transition-all duration-200 shadow-lg',
            running || selectedCount === 0 || loadingInv
              ? 'bg-white/5 text-white/25 cursor-not-allowed'
              : 'text-white hover:scale-[1.02] active:scale-[0.98]',
          )}
          style={running || selectedCount === 0 || loadingInv ? {} : {
            background:  'linear-gradient(135deg, #f59e0b, #b45309)',
            boxShadow:   '0 4px 24px rgba(245,158,11,0.35)',
          }}
        >
          {running
            ? <><Loader2 className="h-4 w-4 animate-spin" /> Running optimizer…</>
            : <><Play className="h-4 w-4" /> Optimize {selectedCount} cards</>}
        </button>
      </div>

      {/* ── Results ── */}
      {result && (
        <div className="space-y-5">
          {/* Summary bar */}
          <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-semibold text-white/40 uppercase tracking-widest">
                Triage Results
              </p>
              <div className="flex items-center gap-3">
                <span className="text-xs text-white/30">
                  Solve: <span className="text-white/50">{result.solve_time_ms.toFixed(0)}ms</span>
                  {' · '}Solver: <span className="text-white/50">{result.solver_used}</span>
                </span>
                <button
                  onClick={() => setResult(null)}
                  className="text-white/25 hover:text-white/50 text-xs transition-colors"
                >
                  ✕ Clear
                </button>
              </div>
            </div>

            {/* Action summary grid */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
              {Object.keys(ACTION_META).map(action => (
                <SummaryBadge
                  key={action}
                  action={action}
                  count={result.summary[action] ?? 0}
                  netValue={netByAction[action] ?? 0}
                />
              ))}
            </div>

            {/* Total */}
            <div className="flex items-center justify-between rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3">
              <span className="text-sm text-white/50 font-medium">Total expected net value</span>
              <span className="text-xl font-bold text-white">
                ${result.total_net_value.toFixed(2)}
              </span>
            </div>
          </div>

          {/* Work queue grouped by action */}
          {Object.entries(groupedDecisions).map(([action, decisions]) => {
            const meta  = ACTION_META[action]
            const Icon  = meta.icon
            const total = decisions.reduce((s, d) => s + d.net_value, 0)

            return (
              <div key={action} className={cn(
                'rounded-2xl border p-5 space-y-3',
                meta.bg, meta.border,
              )}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon className={cn('h-4 w-4', meta.color)} />
                    <span className={cn('text-sm font-semibold', meta.color)}>{meta.label}</span>
                    <span className="text-xs text-white/30 ml-1">{meta.desc}</span>
                  </div>
                  <span className="text-xs font-medium text-white/50">
                    {decisions.length} cards · ${total.toFixed(2)} net
                  </span>
                </div>

                <div className="space-y-2">
                  {decisions.map(dec => (
                    <div key={dec.card_id}
                      className="flex items-start gap-3 rounded-lg border border-white/6 bg-black/20 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-white">{dec.card_name}</p>
                        <p className="text-xs text-white/40 mt-0.5">{dec.reason}</p>
                      </div>
                      <div className="flex-shrink-0 text-right">
                        <p className={cn('text-sm font-bold', meta.color)}>
                          ${dec.net_value.toFixed(2)}
                        </p>
                        <p className="text-[10px] text-white/25">net value</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
