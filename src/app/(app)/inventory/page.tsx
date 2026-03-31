'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/inventory/StatusBadge'
import { Archive, TrendingUp, TrendingDown, ChevronRight, DollarSign, Layers } from 'lucide-react'
import type { InventoryListItem } from '@/types/inventory'

// ── Constants ─────────────────────────────────────────────────────────────────

const REC_LABEL: Record<string, string> = {
  SELL_RAW:               'Sell Raw',
  GRADE:                  'Grade',
  HOLD:                   'Hold',
  INSUFFICIENT_CONFIDENCE: 'Low Confidence',
}

const REC_STYLE: Record<string, string> = {
  SELL_RAW: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  GRADE:    'bg-blue-500/10 text-blue-400 border-blue-500/20',
  HOLD:     'bg-amber-500/10 text-amber-400 border-amber-500/20',
  INSUFFICIENT_CONFIDENCE: 'bg-white/5 text-white/40 border-white/10',
}

function fmt(n: number) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ── Empty state ────────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div
      data-testid="inventory-empty"
      className="flex flex-col items-center justify-center gap-3 py-16 text-center"
    >
      <Archive className="h-10 w-10 text-muted-foreground/40" />
      <div>
        <p className="font-medium text-muted-foreground">No cards in inventory yet</p>
        <p className="text-sm text-muted-foreground mt-0.5">
          Analyze a card and save it to start tracking your collection.
        </p>
      </div>
      <Link
        href="/analyze"
        className="mt-2 text-sm font-medium underline hover:text-foreground transition-colors"
      >
        Analyze a card
      </Link>
    </div>
  )
}

// ── Stat card ──────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string
  value: string
  icon: React.ReactNode
  valueClass?: string
  subtext?: string
}

function StatCard({ label, value, icon, valueClass, subtext }: StatCardProps) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.08] rounded-2xl p-4 flex flex-col gap-2 min-w-0">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">{label}</span>
        <span className="text-muted-foreground/50">{icon}</span>
      </div>
      <p className={['text-xl font-bold tabular-nums leading-tight', valueClass ?? ''].join(' ')}>
        {value}
      </p>
      {subtext && <p className="text-xs text-muted-foreground">{subtext}</p>}
    </div>
  )
}

// ── Insight chip ───────────────────────────────────────────────────────────────

function InsightChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-xs text-muted-foreground">
      {children}
    </span>
  )
}

// ── Analytics header ───────────────────────────────────────────────────────────

function AnalyticsHeader({ items }: { items: InventoryListItem[] }) {
  const stats = useMemo(() => {
    const totalCards = items.length

    const itemsWithValue = items.filter((i) => i.estimated_market_value != null)
    const portfolioValue = itemsWithValue.length > 0
      ? itemsWithValue.reduce((sum, i) => sum + (i.estimated_market_value ?? 0), 0)
      : null

    const itemsWithCost = items.filter((i) => i.acquisition_cost != null && i.acquisition_cost > 0)
    const totalCost = itemsWithCost.length > 0
      ? itemsWithCost.reduce((sum, i) => sum + (i.acquisition_cost ?? 0), 0)
      : null

    const pnl = portfolioValue != null && totalCost != null ? portfolioValue - totalCost : null

    return { totalCards, portfolioValue, totalCost, pnl }
  }, [items])

  const insights = useMemo(() => {
    // Most valuable
    const withValue = items.filter((i) => i.estimated_market_value != null)
    const mostValuable = withValue.length > 0
      ? withValue.reduce((best, i) =>
          (i.estimated_market_value ?? 0) > (best.estimated_market_value ?? 0) ? i : best
        )
      : null

    // Rec distribution
    const dist: Record<string, number> = {}
    for (const item of items) {
      if (item.recommendation_type) {
        dist[item.recommendation_type] = (dist[item.recommendation_type] ?? 0) + 1
      }
    }

    return { mostValuable, dist }
  }, [items])

  return (
    <div className="space-y-3">
      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Total Cards"
          value={stats.totalCards.toString()}
          icon={<Layers className="h-4 w-4" />}
        />
        <StatCard
          label="Portfolio Value"
          value={stats.portfolioValue != null ? fmt(stats.portfolioValue) : '—'}
          icon={<TrendingUp className="h-4 w-4" />}
          subtext={stats.portfolioValue != null ? 'Est. market value' : 'No analyses yet'}
        />
        <StatCard
          label="Total Cost"
          value={stats.totalCost != null ? fmt(stats.totalCost) : '—'}
          icon={<DollarSign className="h-4 w-4" />}
          subtext={stats.totalCost != null ? 'Acquisition cost' : 'Not tracked'}
        />
        <StatCard
          label="Unrealized P&L"
          value={stats.pnl != null ? (stats.pnl >= 0 ? '+' : '') + fmt(stats.pnl) : '—'}
          icon={stats.pnl != null && stats.pnl >= 0
            ? <TrendingUp className="h-4 w-4" />
            : <TrendingDown className="h-4 w-4" />
          }
          valueClass={
            stats.pnl == null ? '' :
            stats.pnl > 0 ? 'bg-gradient-to-r from-emerald-400 to-green-300 bg-clip-text text-transparent' :
            stats.pnl < 0 ? 'bg-gradient-to-r from-red-400 to-rose-300 bg-clip-text text-transparent' :
            ''
          }
        />
      </div>

      {/* Insight chips */}
      <div className="flex flex-wrap gap-2">
        {insights.mostValuable && (
          <InsightChip>
            <TrendingUp className="h-3 w-3 text-emerald-400" />
            <span>Top card: <span className="text-foreground">{insights.mostValuable.card.card_name}</span></span>
            {insights.mostValuable.estimated_market_value != null && (
              <span className="text-emerald-400 font-medium">{fmt(insights.mostValuable.estimated_market_value)}</span>
            )}
          </InsightChip>
        )}
        {insights.dist['SELL_RAW'] != null && (
          <InsightChip>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
            {insights.dist['SELL_RAW']} to Sell
          </InsightChip>
        )}
        {insights.dist['GRADE'] != null && (
          <InsightChip>
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
            {insights.dist['GRADE']} to Grade
          </InsightChip>
        )}
        {insights.dist['HOLD'] != null && (
          <InsightChip>
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
            {insights.dist['HOLD']} to Hold
          </InsightChip>
        )}
      </div>
    </div>
  )
}

// ── Inventory row ──────────────────────────────────────────────────────────────

function InventoryRow({ item }: { item: InventoryListItem }) {
  const pnl =
    item.estimated_market_value != null && item.acquisition_cost != null && item.acquisition_cost > 0
      ? item.estimated_market_value - item.acquisition_cost
      : null

  return (
    <Link href={`/inventory/${item.item_id}`} className="block group">
      <div
        data-testid="inventory-item"
        className="flex items-center gap-3 px-4 py-3 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/[0.12] transition-all cursor-pointer"
      >
        {/* Card image placeholder */}
        <div className="shrink-0 w-9 h-12 rounded-md bg-white/[0.05] border border-white/[0.08] flex items-center justify-center text-lg select-none">
          🃏
        </div>

        {/* Card info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="font-medium text-sm truncate">{item.card.card_name}</p>
            {item.card.variant && (
              <span className="text-xs text-muted-foreground shrink-0">({item.card.variant})</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {item.card.franchise_or_brand}
            {item.card.set_name ? ` · ${item.card.set_name}` : ''}
            {item.card.year ? ` · ${item.card.year}` : ''}
          </p>
        </div>

        {/* Values */}
        <div className="shrink-0 flex items-center gap-3">
          {/* Cost */}
          <div className="hidden sm:block text-right min-w-[4rem]">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Cost</p>
            <p className="text-xs tabular-nums font-medium">
              {item.acquisition_cost != null && item.acquisition_cost > 0
                ? fmt(item.acquisition_cost)
                : <span className="text-muted-foreground/50">—</span>
              }
            </p>
          </div>

          {/* Market value */}
          <div className="hidden md:block text-right min-w-[4.5rem]">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Value</p>
            <p className="text-xs tabular-nums font-medium">
              {item.estimated_market_value != null
                ? fmt(item.estimated_market_value)
                : <span className="text-muted-foreground/50">—</span>
              }
            </p>
          </div>

          {/* P&L */}
          <div className="hidden lg:block text-right min-w-[4rem]">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">P&L</p>
            <p className={[
              'text-xs tabular-nums font-semibold',
              pnl == null ? 'text-muted-foreground/50' :
              pnl > 0 ? 'text-emerald-400' :
              pnl < 0 ? 'text-red-400' :
              'text-muted-foreground',
            ].join(' ')}>
              {pnl == null ? '—' : (pnl >= 0 ? '+' : '') + fmt(pnl)}
            </p>
          </div>

          {/* Rec badge */}
          {item.recommendation_type && (
            <span className={[
              'hidden sm:inline-flex text-[10px] font-medium px-2 py-0.5 rounded-full border',
              REC_STYLE[item.recommendation_type] ?? 'bg-white/5 text-white/40 border-white/10',
            ].join(' ')}>
              {REC_LABEL[item.recommendation_type] ?? item.recommendation_type}
            </span>
          )}

          <StatusBadge status={item.status} />
          <ChevronRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
        </div>
      </div>
    </Link>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const [items, setItems]     = useState<InventoryListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/inventory')
        if (!res.ok) throw new Error('Failed to load inventory')
        const data = await res.json()
        setItems(data.items)
      } catch {
        setError('Could not load inventory.')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold">Inventory</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Your saved cards, analysis history, and status tracking.
        </p>
      </div>

      {/* Loading skeletons */}
      {loading && (
        <div data-testid="inventory-loading" className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-24 w-full rounded-2xl" />
            ))}
          </div>
          <div className="space-y-2 mt-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <p data-testid="inventory-error" className="text-sm text-destructive">{error}</p>
      )}

      {/* Empty state */}
      {!loading && !error && items.length === 0 && <EmptyState />}

      {/* Content */}
      {!loading && !error && items.length > 0 && (
        <>
          {/* Section A: Analytics */}
          <AnalyticsHeader items={items} />

          {/* Section B: Table */}
          <div data-testid="inventory-list" className="space-y-1.5">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium px-1 pb-1">
              {items.length} {items.length === 1 ? 'card' : 'cards'}
            </p>
            {items.map((item) => (
              <InventoryRow key={item.item_id} item={item} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
