'use client'

/**
 * A4 — Portfolio Rebalancing Optimizer
 *
 * Loads owned inventory, lets the user review per-holding data
 * (cost basis, current value, liquidity, sentimental hold), then runs
 * the MIP solver to select which cards to sell for maximum realized profit
 * while respecting concentration limits and sell-count constraints.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  PieChart, Play, Loader2, Settings2, AlertCircle,
  TrendingUp, TrendingDown, Lock, CheckCircle2, MinusCircle,
  ChevronDown, ChevronUp, Heart,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

interface InventoryListItem {
  item_id:                string
  catalog_id:             string
  status:                 string
  acquisition_cost:       number
  estimated_market_value: number | null
  created_at:             string
  card: {
    card_name:          string
    set_name:           string
    franchise_or_brand: string
    year:               number | null
  }
}

interface HoldingRow {
  card_id:         string
  card_name:       string
  set_name:        string
  cost_basis:      number
  current_value:   number
  liquidity_score: number
  days_held:       number
  sentimental_hold: boolean
}

interface RebalanceConstraints {
  max_sell_count:        number | null
  min_liquidity_to_sell: number
  max_concentration_pct: number
  target_realize_profit: number | null
}

interface RebalanceDecision {
  card_id:       string
  card_name:     string
  action:        'sell' | 'hold'
  current_value: number
  cost_basis:    number
  profit:        number
  roi_pct:       number
  reason:        string
}

interface RebalanceResponse {
  status:                string
  cards_to_sell:         number
  cards_to_hold:         number
  total_realized_value:  number
  total_realized_profit: number
  decisions:             RebalanceDecision[]
  solver_used:           string
  solve_time_ms:         number
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
}

function toHolding(item: InventoryListItem): HoldingRow {
  const cost  = item.acquisition_cost ?? 0
  const value = item.estimated_market_value ?? cost
  const days  = daysSince(item.created_at)
  // Liquidity estimate: lower value = more liquid (commons trade fast)
  const liq   = value > 100 ? 0.3 : value > 25 ? 0.55 : 0.75
  return {
    card_id:          item.item_id,
    card_name:        item.card.card_name,
    set_name:         item.card.set_name,
    cost_basis:       cost,
    current_value:    value,
    liquidity_score:  liq,
    days_held:        days,
    sentimental_hold: false,
  }
}

function pct(v: number, decimals = 0) {
  return `${(v * 100).toFixed(decimals)}%`
}
function usd(v: number) { return `$${v.toFixed(2)}` }

function profitColor(p: number) {
  if (p > 0)  return 'text-emerald-400'
  if (p < 0)  return 'text-red-400'
  return 'text-white/50'
}

const DEFAULT_CONSTRAINTS: RebalanceConstraints = {
  max_sell_count:        null,
  min_liquidity_to_sell: 0.3,
  max_concentration_pct: 0.30,
  target_realize_profit: null,
}

// ─────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────

function NumInput({
  value, onChange, min = 0, step = 1, prefix, suffix, placeholder, className,
}: {
  value: string; onChange: (v: string) => void
  min?: number; step?: number; prefix?: string; suffix?: string
  placeholder?: string; className?: string
}) {
  return (
    <label className={cn('relative flex items-center', className)}>
      {prefix && (
        <span className="absolute left-2.5 text-xs text-white/30 pointer-events-none">{prefix}</span>
      )}
      <input
        type="number"
        value={value}
        min={min}
        step={step}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        className={cn(
          'w-full rounded-lg border border-white/10 bg-white/5 text-white text-xs py-1.5',
          'placeholder:text-white/20 focus:outline-none focus:ring-1 focus:ring-indigo-500/60',
          'focus:border-indigo-500/40 transition-colors',
          prefix ? 'pl-5 pr-2' : 'px-2.5',
          suffix ? 'pr-8' : '',
        )}
      />
      {suffix && (
        <span className="absolute right-2.5 text-xs text-white/30 pointer-events-none">{suffix}</span>
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
        'relative inline-flex h-4 w-7 flex-shrink-0 rounded-full border-2 transition-colors',
        checked ? 'bg-pink-500 border-pink-500' : 'bg-white/10 border-white/10',
      )}
    >
      <span className={cn(
        'inline-block h-3 w-3 rounded-full bg-white shadow transition-transform',
        checked ? 'translate-x-3' : 'translate-x-0',
      )} />
    </button>
  )
}

// Concentration bar — shows each set as a colored segment
function ConcentrationBar({ rows }: { rows: HoldingRow[] }) {
  const total = rows.reduce((s, r) => s + r.current_value, 0) || 1
  const sets  = Array.from(new Set(rows.map(r => r.set_name)))
  const palette = ['#6366f1','#10b981','#f59e0b','#ef4444','#a855f7','#06b6d4','#ec4899']

  return (
    <div className="space-y-2">
      <div className="flex h-2 rounded-full overflow-hidden gap-0.5">
        {sets.map((set, i) => {
          const w = rows.filter(r => r.set_name === set).reduce((s, r) => s + r.current_value, 0) / total
          return (
            <div key={set} className="h-full rounded-sm transition-all"
              style={{ width: `${w * 100}%`, background: palette[i % palette.length] }} />
          )
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {sets.map((set, i) => {
          const w = rows.filter(r => r.set_name === set).reduce((s, r) => s + r.current_value, 0) / total
          return (
            <div key={set} className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm flex-shrink-0"
                style={{ background: palette[i % palette.length] }} />
              <span className="text-[10px] text-white/40 truncate max-w-[120px]">{set || 'Unknown'}</span>
              <span className="text-[10px] text-white/25">{pct(w)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────

export default function RebalancePage() {
  const [rows,        setRows]        = useState<HoldingRow[]>([])
  const [constraints, setConstraints] = useState<RebalanceConstraints>(DEFAULT_CONSTRAINTS)
  const [result,      setResult]      = useState<RebalanceResponse | null>(null)
  const [loadingInv,  setLoadingInv]  = useState(true)
  const [running,     setRunning]     = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [showConfig,  setShowConfig]  = useState(false)
  const [expanded,    setExpanded]    = useState<Set<string>>(new Set())

  // ── Load inventory ──────────────────────────────────────────────
  useEffect(() => {
    setLoadingInv(true)
    fetch('/api/inventory')
      .then(r => r.json())
      .then(({ items }: { items: InventoryListItem[] }) => {
        const owned = (items ?? []).filter(i => i.status === 'owned')
        setRows(owned.map(toHolding))
      })
      .catch(() => setError('Failed to load inventory'))
      .finally(() => setLoadingInv(false))
  }, [])

  // ── Portfolio stats ─────────────────────────────────────────────
  const totalValue  = useMemo(() => rows.reduce((s, r) => s + r.current_value, 0), [rows])
  const totalCost   = useMemo(() => rows.reduce((s, r) => s + r.cost_basis,    0), [rows])
  const totalProfit = totalValue - totalCost

  // ── Helpers ─────────────────────────────────────────────────────
  function updateRow(id: string, patch: Partial<HoldingRow>) {
    setRows(prev => prev.map(r => r.card_id === id ? { ...r, ...patch } : r))
    setResult(null)
  }

  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function setC<K extends keyof RebalanceConstraints>(k: K, v: RebalanceConstraints[K]) {
    setConstraints(prev => ({ ...prev, [k]: v }))
  }

  // ── Run optimizer ───────────────────────────────────────────────
  async function runOptimizer() {
    if (rows.length === 0) {
      setError('No holdings to rebalance.')
      return
    }
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const payload = {
        holdings:    rows,
        constraints: {
          max_sell_count:        constraints.max_sell_count,
          min_liquidity_to_sell: constraints.min_liquidity_to_sell,
          max_concentration_pct: constraints.max_concentration_pct,
          target_realize_profit: constraints.target_realize_profit,
        },
      }
      const res  = await fetch('/api/optimize/rebalance', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) setError(data?.detail ?? data?.error ?? 'Optimizer error.')
      else setResult(data)
    } catch (e: any) {
      setError(e?.message ?? 'Network error')
    } finally {
      setRunning(false)
    }
  }

  const decisionMap = useMemo(() => {
    const m: Record<string, RebalanceDecision> = {}
    result?.decisions.forEach(d => { m[d.card_id] = d })
    return m
  }, [result])

  const sellDecisions = result?.decisions.filter(d => d.action === 'sell') ?? []
  const holdDecisions = result?.decisions.filter(d => d.action === 'hold') ?? []

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
              style={{ background: 'linear-gradient(135deg, #6366f1, #4338ca)' }}>
              <PieChart className="h-5 w-5 text-white" />
            </div>
            <h1 className="text-xl font-bold text-white">Portfolio Rebalancing</h1>
          </div>
          <p className="text-sm text-white/40 ml-12">
            Identify which holdings to sell to maximize realized profit while reducing set concentration.
          </p>
        </div>
        <button
          onClick={() => setShowConfig(v => !v)}
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all',
            showConfig
              ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
              : 'border-white/10 bg-white/5 text-white/50 hover:text-white/80',
          )}
        >
          <Settings2 className="h-3.5 w-3.5" />
          Constraints
        </button>
      </div>

      {/* ── Portfolio overview ── */}
      {!loadingInv && rows.length > 0 && (
        <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-5 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Holdings',       value: String(rows.length),      sub: 'owned cards' },
              { label: 'Portfolio value', value: usd(totalValue),          sub: 'current est.' },
              { label: 'Total cost',      value: usd(totalCost),           sub: 'acquisition' },
              {
                label: 'Unrealized P&L',
                value: `${totalProfit >= 0 ? '+' : ''}${usd(totalProfit)}`,
                sub:   totalCost > 0 ? pct(totalProfit / totalCost) + ' ROI' : '',
                color: profitColor(totalProfit),
              },
            ].map(({ label, value, sub, color }) => (
              <div key={label} className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3">
                <p className="text-[10px] text-white/40 uppercase tracking-widest mb-1">{label}</p>
                <p className={cn('text-lg font-bold', color ?? 'text-white')}>{value}</p>
                {sub && <p className="text-[10px] text-white/30 mt-0.5">{sub}</p>}
              </div>
            ))}
          </div>
          {rows.length > 0 && (
            <div>
              <p className="text-[10px] text-white/30 uppercase tracking-widest mb-2">Set concentration</p>
              <ConcentrationBar rows={rows} />
            </div>
          )}
        </div>
      )}

      {/* ── Constraints panel ── */}
      {showConfig && (
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <p className="text-xs font-semibold text-white/40 uppercase tracking-widest mb-4">
            Rebalancing Constraints
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs text-white/50">Max cards to sell</label>
              <NumInput
                value={constraints.max_sell_count === null ? '' : String(constraints.max_sell_count)}
                onChange={v => setC('max_sell_count', v === '' ? null : parseInt(v) || null)}
                placeholder="No limit" min={1}
              />
              <p className="text-[10px] text-white/25">Sell session cap</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-white/50">Min liquidity to sell</label>
              <NumInput
                value={String((constraints.min_liquidity_to_sell * 100).toFixed(0))}
                onChange={v => setC('min_liquidity_to_sell', Math.min((parseFloat(v) || 0) / 100, 1))}
                suffix="%" step={5}
              />
              <p className="text-[10px] text-white/25">0 = illiquid, 100 = very liquid</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-white/50">Max concentration per set</label>
              <NumInput
                value={String((constraints.max_concentration_pct * 100).toFixed(0))}
                onChange={v => setC('max_concentration_pct', Math.min((parseFloat(v) || 0) / 100, 1))}
                suffix="%" step={5}
              />
              <p className="text-[10px] text-white/25">Sell overweight sets first</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-white/50">Target profit to realize</label>
              <NumInput
                value={constraints.target_realize_profit === null ? '' : String(constraints.target_realize_profit)}
                onChange={v => setC('target_realize_profit', v === '' ? null : parseFloat(v) || null)}
                placeholder="Optional" prefix="$"
              />
              <p className="text-[10px] text-white/25">Hard profit floor</p>
            </div>
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

      {/* ── Holdings table ── */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.02] overflow-hidden">
        {/* Column headers */}
        {!loadingInv && rows.length > 0 && (
          <>
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/6">
              <span className="text-xs font-semibold text-white/50 uppercase tracking-widest">
                {loadingInv ? 'Loading…' : `${rows.length} holdings`}
              </span>
              <span className="text-xs text-white/30">
                Adjust cost basis, value, or liquidity — toggle{' '}
                <Heart className="inline h-3 w-3 text-pink-400" /> to lock a card
              </span>
            </div>
            <div className="hidden md:grid px-4 py-2 border-b border-white/6 text-[10px] font-semibold uppercase tracking-widest text-white/25"
              style={{ gridTemplateColumns: '1fr 5.5rem 5.5rem 5rem 4.5rem 3.5rem' }}>
              <span>Card</span>
              <span>Cost basis</span>
              <span>Curr. value</span>
              <span>Liquidity</span>
              <span>Days held</span>
              <span className="text-center">Lock</span>
            </div>
          </>
        )}

        {loadingInv ? (
          <div className="flex items-center justify-center py-16 gap-3 text-white/30">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading portfolio…</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2 text-white/30">
            <PieChart className="h-8 w-8 opacity-40" />
            <p className="text-sm">No owned inventory found.</p>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {rows.map(row => {
              const dec     = decisionMap[row.card_id]
              const profit  = row.current_value - row.cost_basis
              const isExpand = expanded.has(row.card_id)
              const isSell  = dec?.action === 'sell'

              return (
                <div key={row.card_id} className={cn(
                  'transition-colors',
                  isSell                ? 'bg-emerald-500/5' : '',
                  row.sentimental_hold  ? 'opacity-60'       : '',
                )}>
                  <div className="grid items-center gap-2 px-4 py-2.5"
                    style={{ gridTemplateColumns: '1fr 5.5rem 5.5rem 5rem 4.5rem 3.5rem' }}>

                    {/* Card name + decision badge */}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-white truncate">{row.card_name}</span>
                        {dec && (
                          <span className={cn(
                            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border',
                            isSell
                              ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                              : 'text-slate-400 bg-slate-500/10 border-slate-500/20',
                          )}>
                            {isSell
                              ? <><CheckCircle2 className="h-2.5 w-2.5" /> Sell</>
                              : <><MinusCircle  className="h-2.5 w-2.5" /> Hold</>}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-[11px] text-white/35 truncate">{row.set_name}</span>
                        <span className={cn('text-[11px]', profitColor(profit))}>
                          {profit >= 0 ? '+' : ''}{usd(profit)}
                          {row.cost_basis > 0 ? ` (${pct(profit / row.cost_basis)})` : ''}
                        </span>
                        {dec && (
                          <button onClick={() => toggleExpand(row.card_id)}
                            className="text-white/25 hover:text-white/50 transition-colors">
                            {isExpand ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Cost basis */}
                    <NumInput value={String(row.cost_basis)}
                      onChange={v => updateRow(row.card_id, { cost_basis: parseFloat(v) || 0 })}
                      prefix="$" step={0.5} />

                    {/* Current value */}
                    <NumInput value={String(row.current_value)}
                      onChange={v => updateRow(row.card_id, { current_value: parseFloat(v) || 0 })}
                      prefix="$" step={0.5} />

                    {/* Liquidity */}
                    <NumInput
                      value={String((row.liquidity_score * 100).toFixed(0))}
                      onChange={v => updateRow(row.card_id, { liquidity_score: Math.min((parseFloat(v) || 0) / 100, 1) })}
                      suffix="%" step={5} />

                    {/* Days held */}
                    <NumInput value={String(row.days_held)}
                      onChange={v => updateRow(row.card_id, { days_held: parseInt(v) || 0 })}
                      suffix="d" min={0} />

                    {/* Sentimental lock */}
                    <div className="flex justify-center items-center gap-1">
                      {row.sentimental_hold && <Lock className="h-3 w-3 text-pink-400/60" />}
                      <Toggle
                        checked={row.sentimental_hold}
                        onChange={v => updateRow(row.card_id, { sentimental_hold: v })}
                      />
                    </div>
                  </div>

                  {/* Expanded reason */}
                  {isExpand && dec && (
                    <div className={cn(
                      'mx-4 mb-2.5 rounded-lg border px-3 py-2 text-xs',
                      isSell
                        ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-200/70'
                        : 'border-white/8 bg-white/3 text-white/40',
                    )}>
                      {dec.reason}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Run button ── */}
      {!loadingInv && rows.length > 0 && (
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
              background: 'linear-gradient(135deg, #6366f1, #4338ca)',
              boxShadow:  '0 4px 24px rgba(99,102,241,0.35)',
            }}
          >
            {running
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Optimizing…</>
              : <><Play className="h-4 w-4" /> Rebalance {rows.length} holdings</>}
          </button>
        </div>
      )}

      {/* ── Results ── */}
      {result && (
        <div className="space-y-4">
          {/* Summary */}
          <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-semibold text-white/40 uppercase tracking-widest">
                Rebalancing Plan
              </p>
              <span className="text-xs text-white/30">
                {result.solve_time_ms.toFixed(0)}ms · {result.solver_used}
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: 'Cards to sell',    value: String(result.cards_to_sell),             color: 'text-emerald-400' },
                { label: 'Cards to hold',    value: String(result.cards_to_hold),             color: 'text-white/60' },
                { label: 'Realized value',   value: usd(result.total_realized_value),         color: 'text-white' },
                { label: 'Realized profit',  value: `${result.total_realized_profit >= 0 ? '+' : ''}${usd(result.total_realized_profit)}`,
                  color: profitColor(result.total_realized_profit) },
              ].map(({ label, value, color }) => (
                <div key={label} className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3">
                  <p className="text-[10px] text-white/40 uppercase tracking-widest mb-1">{label}</p>
                  <p className={cn('text-xl font-bold', color)}>{value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Sell list */}
          {sellDecisions.length > 0 && (
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-emerald-400" />
                  <span className="text-sm font-semibold text-emerald-400">Sell</span>
                  <span className="text-xs text-white/30">List these to realize profit</span>
                </div>
                <span className="text-xs text-white/40">
                  {sellDecisions.length} cards · {usd(result.total_realized_value)} proceeds
                </span>
              </div>
              <div className="space-y-2">
                {sellDecisions.map(dec => (
                  <div key={dec.card_id}
                    className="flex items-start gap-3 rounded-lg border border-white/6 bg-black/20 px-3 py-2.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white">{dec.card_name}</p>
                      <p className="text-xs text-white/40 mt-0.5">{dec.reason}</p>
                    </div>
                    <div className="flex-shrink-0 text-right">
                      <p className={cn('text-sm font-bold', profitColor(dec.profit))}>
                        {dec.profit >= 0 ? '+' : ''}{usd(dec.profit)}
                      </p>
                      <p className="text-[10px] text-white/30">{pct(dec.roi_pct)} ROI</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Hold list */}
          {holdDecisions.length > 0 && (
            <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TrendingDown className="h-4 w-4 text-white/30" />
                  <span className="text-sm font-semibold text-white/50">Hold</span>
                  <span className="text-xs text-white/25">Keep in portfolio</span>
                </div>
                <span className="text-xs text-white/30">{holdDecisions.length} cards</span>
              </div>
              <div className="space-y-2">
                {holdDecisions.map(dec => (
                  <div key={dec.card_id}
                    className="flex items-start gap-3 rounded-lg border border-white/6 bg-black/10 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white/60">{dec.card_name}</p>
                      <p className="text-xs text-white/30 mt-0.5">{dec.reason}</p>
                    </div>
                    <div className="flex-shrink-0 text-right">
                      <p className={cn('text-xs font-medium', profitColor(dec.profit))}>
                        {dec.profit >= 0 ? '+' : ''}{usd(dec.profit)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
