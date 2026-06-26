'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { StatusBadge } from '@/components/inventory/StatusBadge'
import { AnimatedNumber } from '@/components/ui/AnimatedNumber'
import {
  TrendingUp, TrendingDown, ChevronRight, ArrowRight,
  ChevronDown, Layers, DollarSign, BarChart3,
} from 'lucide-react'
import type { InventoryListItem } from '@/types/inventory'

// ── Constants ─────────────────────────────────────────────────────────────────

const REC_LABEL: Record<string, string> = {
  SELL_RAW:                'Sell Raw',
  GRADE:                   'Grade',
  HOLD:                    'Hold',
  INSUFFICIENT_CONFIDENCE: 'Low Confidence',
}

const REC_STYLE: Record<string, string> = {
  SELL_RAW: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  GRADE:    'bg-blue-500/10 text-blue-400 border-blue-500/20',
  HOLD:     'bg-amber-500/10 text-amber-400 border-amber-500/20',
  INSUFFICIENT_CONFIDENCE: 'bg-white/5 text-white/40 border-white/10',
}

// Left accent border color per recommendation
const REC_BORDER: Record<string, string> = {
  SELL_RAW: '#10b981', // emerald-500
  GRADE:    '#3b82f6', // blue-500
  HOLD:     '#f59e0b', // amber-500
}

const STATUS_FILTERS = ['All', 'Owned', 'Listed', 'Grading', 'Sold'] as const
type StatusFilter = typeof STATUS_FILTERS[number]

type SortKey = 'price-high' | 'price-low' | 'recent' | 'name'
const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'price-high', label: 'Price High → Low' },
  { value: 'price-low',  label: 'Price Low → High' },
  { value: 'recent',     label: 'Recently Added' },
  { value: 'name',       label: 'Name' },
]

function fmt(n: number) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtCompact(n: number) {
  if (Math.abs(n) >= 1000) {
    return '$' + (n / 1000).toFixed(1) + 'k'
  }
  return fmt(n)
}

// ── Card-back illustration (CSS only) ─────────────────────────────────────────

function CardBack({ initial }: { initial: string }) {
  return (
    <div
      style={{
        width: 36,
        height: 50,
        borderRadius: 6,
        flexShrink: 0,
        background: 'radial-gradient(circle at 30% 30%, #6366f1 0%, #4f46e5 40%, #2e1065 100%)',
        border: '1px solid rgba(99,102,241,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* subtle pattern overlay */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(255,255,255,0.04) 4px, rgba(255,255,255,0.04) 5px)',
      }} />
      <span style={{
        fontWeight: 700,
        fontSize: 16,
        color: 'rgba(255,255,255,0.9)',
        textShadow: '0 1px 4px rgba(0,0,0,0.5)',
        position: 'relative',
        zIndex: 1,
        userSelect: 'none',
      }}>
        {initial}
      </span>
    </div>
  )
}

// ── Shimmer loading skeleton ───────────────────────────────────────────────────

function ShimmerBlock({ width = '100%', height = 16, radius = 8 }: { width?: string | number; height?: number; radius?: number }) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: radius,
        background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.09) 50%, rgba(255,255,255,0.04) 100%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.6s infinite linear',
      }}
    />
  )
}

function LoadingSkeleton() {
  return (
    <div data-testid="inventory-loading" className="space-y-4">
      <style>{`
        @keyframes shimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>

      {/* Banner skeleton */}
      <div style={{
        borderRadius: 16,
        border: '1px solid rgba(255,255,255,0.07)',
        background: 'rgba(255,255,255,0.02)',
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <ShimmerBlock width={80} height={11} />
            <ShimmerBlock width={180} height={40} radius={8} />
          </div>
          <div style={{ display: 'flex', gap: 24 }}>
            {[70, 80, 90].map((w, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <ShimmerBlock width={w} height={10} />
                <ShimmerBlock width={w} height={22} radius={6} />
              </div>
            ))}
          </div>
        </div>
        <ShimmerBlock width="100%" height={1} radius={0} />
        <div style={{ display: 'flex', gap: 8 }}>
          {[120, 90, 80, 100].map((w, i) => (
            <ShimmerBlock key={i} width={w} height={24} radius={12} />
          ))}
        </div>
      </div>

      {/* Toolbar skeleton */}
      <div style={{ display: 'flex', gap: 8 }}>
        {[40, 60, 60, 70, 50].map((w, i) => (
          <ShimmerBlock key={i} width={w} height={30} radius={99} />
        ))}
      </div>

      {/* Row skeletons */}
      {[1, 2, 3].map((i) => (
        <div key={i} style={{
          borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(255,255,255,0.02)',
          padding: '14px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <ShimmerBlock width={36} height={50} radius={6} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 7 }}>
            <ShimmerBlock width="45%" height={13} />
            <ShimmerBlock width="30%" height={10} />
          </div>
          <div style={{ display: 'flex', gap: 20 }}>
            {[54, 64, 54].map((w, j) => (
              <ShimmerBlock key={j} width={w} height={32} radius={6} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Empty state ────────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div
      data-testid="inventory-empty"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        padding: '64px 24px',
        textAlign: 'center',
      }}
    >
      {/* CSS-only card illustration */}
      <div style={{ position: 'relative', width: 96, height: 130 }}>
        {/* Back card */}
        <div style={{
          position: 'absolute', left: 12, top: 8, width: 72, height: 100, borderRadius: 8,
          background: 'radial-gradient(circle at 30% 30%, #4f46e5 0%, #1e1b4b 100%)',
          border: '1px solid rgba(99,102,241,0.3)',
          transform: 'rotate(-6deg)',
          opacity: 0.5,
        }} />
        {/* Mid card */}
        <div style={{
          position: 'absolute', left: 10, top: 4, width: 72, height: 100, borderRadius: 8,
          background: 'radial-gradient(circle at 60% 40%, #6366f1 0%, #312e81 100%)',
          border: '1px solid rgba(99,102,241,0.4)',
          transform: 'rotate(-2deg)',
          opacity: 0.7,
        }} />
        {/* Front card */}
        <div style={{
          position: 'absolute', left: 12, top: 0, width: 72, height: 100, borderRadius: 8,
          background: 'radial-gradient(circle at 35% 30%, #818cf8 0%, #4f46e5 50%, #1e1b4b 100%)',
          border: '1px solid rgba(129,140,248,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 8px 32px rgba(99,102,241,0.3)',
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%',
            background: 'rgba(255,255,255,0.1)',
            border: '1px solid rgba(255,255,255,0.15)',
          }} />
        </div>
      </div>

      <div>
        <p style={{ fontSize: 18, fontWeight: 700, color: 'rgba(255,255,255,0.85)', marginBottom: 6 }}>
          Your collection starts here
        </p>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.35)', maxWidth: 280 }}>
          Analyze a card to get pricing intelligence, then save it to start tracking your portfolio.
        </p>
      </div>

      <Link href="/analyze">
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '10px 20px', borderRadius: 10,
          background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
          color: '#fff', fontSize: 14, fontWeight: 600,
          boxShadow: '0 4px 24px rgba(99,102,241,0.35)',
          cursor: 'pointer',
          transition: 'opacity 0.2s',
        }}>
          Analyze a card
          <ArrowRight size={14} />
        </div>
      </Link>
    </div>
  )
}

// ── Stats hero banner ──────────────────────────────────────────────────────────

interface HeroStats {
  totalCards: number
  portfolioValue: number | null
  totalCost: number | null
  pnl: number | null
  mostValuable: InventoryListItem | null
  dist: Record<string, number>
}

function HeroStatsBanner({ stats }: { stats: HeroStats }) {
  const pnlPositive = stats.pnl != null && stats.pnl > 0
  const pnlNegative = stats.pnl != null && stats.pnl < 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Main banner */}
      <div style={{
        borderRadius: 16,
        border: '1px solid rgba(99,102,241,0.2)',
        background: 'linear-gradient(135deg, rgba(15,10,40,0.95) 0%, rgba(20,15,55,0.95) 100%)',
        overflow: 'hidden',
        position: 'relative',
      }}>
        {/* Grid overlay */}
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          backgroundImage: `
            linear-gradient(rgba(99,102,241,0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(99,102,241,0.04) 1px, transparent 1px)
          `,
          backgroundSize: '32px 32px',
        }} />
        {/* Glow orb */}
        <div style={{
          position: 'absolute', top: -60, right: -60,
          width: 220, height: 220, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(99,102,241,0.18) 0%, transparent 70%)',
          pointerEvents: 'none',
        }} />

        <div style={{
          position: 'relative', padding: '24px 28px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: 20,
        }}>
          {/* Portfolio value — left */}
          <div>
            <p style={{
              fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.35)', fontWeight: 600, marginBottom: 4,
            }}>
              Portfolio Value
            </p>
            <p style={{
              fontSize: 38, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.02em',
              background: 'linear-gradient(135deg, #818cf8 0%, #a78bfa 100%)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            }}>
              {stats.portfolioValue != null ? <AnimatedNumber value={stats.portfolioValue} formatter={fmtCompact} /> : '—'}
            </p>
            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', marginTop: 4 }}>
              Est. market value
            </p>
          </div>

          {/* Right: 3 inline stats */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
            {/* Total Cards */}
            <div style={{ textAlign: 'right' }}>
              <p style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)', marginBottom: 3 }}>
                Total Cards
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                <Layers size={13} style={{ color: 'rgba(129,140,248,0.7)' }} />
                <p style={{ fontSize: 22, fontWeight: 700, color: 'rgba(255,255,255,0.85)', lineHeight: 1 }}>
                  <AnimatedNumber value={stats.totalCards} formatter={(n) => String(Math.round(n))} />
                </p>
              </div>
            </div>

            <div style={{ width: 1, height: 40, background: 'rgba(255,255,255,0.07)' }} />

            {/* Cost Basis */}
            <div style={{ textAlign: 'right' }}>
              <p style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)', marginBottom: 3 }}>
                Cost Basis
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                <DollarSign size={13} style={{ color: 'rgba(129,140,248,0.7)' }} />
                <p style={{ fontSize: 22, fontWeight: 700, color: 'rgba(255,255,255,0.85)', lineHeight: 1 }}>
                  {stats.totalCost != null ? <AnimatedNumber value={stats.totalCost} formatter={fmtCompact} /> : '—'}
                </p>
              </div>
            </div>

            <div style={{ width: 1, height: 40, background: 'rgba(255,255,255,0.07)' }} />

            {/* P&L hero */}
            <div style={{ textAlign: 'right' }}>
              <p style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)', marginBottom: 3 }}>
                Unrealized P&amp;L
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                {stats.pnl != null && (
                  pnlPositive
                    ? <TrendingUp size={14} style={{ color: '#34d399' }} />
                    : pnlNegative
                    ? <TrendingDown size={14} style={{ color: '#f87171' }} />
                    : <BarChart3 size={14} style={{ color: 'rgba(255,255,255,0.3)' }} />
                )}
                <p style={{
                  fontSize: 22, fontWeight: 700, lineHeight: 1,
                  color: stats.pnl == null
                    ? 'rgba(255,255,255,0.3)'
                    : pnlPositive ? '#34d399'
                    : pnlNegative ? '#f87171'
                    : 'rgba(255,255,255,0.6)',
                }}>
                  {stats.pnl == null
                    ? '—'
                    : <AnimatedNumber value={stats.pnl} formatter={(n) => (n >= 0 ? '+' : '') + fmtCompact(n)} />
                  }
                </p>
              </div>
              {stats.pnl != null && stats.totalCost != null && stats.totalCost > 0 && (
                <p style={{
                  fontSize: 11, fontWeight: 600, marginTop: 3,
                  color: pnlPositive ? '#34d399' : pnlNegative ? '#f87171' : 'rgba(255,255,255,0.4)',
                }}>
                  {stats.pnl >= 0 ? '+' : ''}{((stats.pnl / stats.totalCost) * 100).toFixed(1)}% return
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Insight row */}
        <div style={{
          borderTop: '1px solid rgba(255,255,255,0.05)',
          padding: '10px 28px',
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          background: 'rgba(0,0,0,0.15)',
          position: 'relative',
        }}>
          {/* Most valuable */}
          {stats.mostValuable && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '3px 10px', borderRadius: 99,
              background: 'rgba(52,211,153,0.08)',
              border: '1px solid rgba(52,211,153,0.2)',
              fontSize: 11, color: 'rgba(255,255,255,0.5)',
            }}>
              <TrendingUp size={10} style={{ color: '#34d399' }} />
              <span>Top: </span>
              <span style={{ color: 'rgba(255,255,255,0.8)', fontWeight: 600 }}>
                {stats.mostValuable.card.card_name}
              </span>
              {stats.mostValuable.estimated_market_value != null && (
                <span style={{ color: '#34d399', fontWeight: 600 }}>
                  {fmt(stats.mostValuable.estimated_market_value)}
                </span>
              )}
            </span>
          )}

          {/* Rec distribution pills */}
          {stats.dist['SELL_RAW'] != null && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '3px 10px', borderRadius: 99,
              background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)',
              fontSize: 11, fontWeight: 600, color: '#34d399',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', display: 'inline-block' }} />
              {stats.dist['SELL_RAW']} Sell
            </span>
          )}
          {stats.dist['GRADE'] != null && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '3px 10px', borderRadius: 99,
              background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)',
              fontSize: 11, fontWeight: 600, color: '#60a5fa',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6', display: 'inline-block' }} />
              {stats.dist['GRADE']} Grade
            </span>
          )}
          {stats.dist['HOLD'] != null && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '3px 10px', borderRadius: 99,
              background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
              fontSize: 11, fontWeight: 600, color: '#fbbf24',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />
              {stats.dist['HOLD']} Hold
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Filter + sort toolbar ──────────────────────────────────────────────────────

interface ToolbarProps {
  activeFilter: StatusFilter
  onFilter: (f: StatusFilter) => void
  activeSort: SortKey
  onSort: (s: SortKey) => void
}

function Toolbar({ activeFilter, onFilter, activeSort, onSort }: ToolbarProps) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 12, flexWrap: 'wrap',
    }}>
      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {STATUS_FILTERS.map((f) => {
          const active = f === activeFilter
          return (
            <button
              key={f}
              onClick={() => onFilter(f)}
              style={{
                padding: '5px 14px', borderRadius: 99,
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
                transition: 'all 0.15s',
                border: active ? '1px solid rgba(99,102,241,0.6)' : '1px solid rgba(255,255,255,0.1)',
                background: active
                  ? 'linear-gradient(135deg, rgba(99,102,241,0.35) 0%, rgba(139,92,246,0.35) 100%)'
                  : 'rgba(255,255,255,0.03)',
                color: active ? '#a5b4fc' : 'rgba(255,255,255,0.35)',
              }}
            >
              {f}
            </button>
          )
        })}
      </div>

      {/* Sort dropdown */}
      <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
        <select
          value={activeSort}
          onChange={(e) => onSort(e.target.value as SortKey)}
          style={{
            appearance: 'none',
            padding: '5px 32px 5px 12px',
            borderRadius: 8,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.1)',
            color: 'rgba(255,255,255,0.5)',
            fontSize: 12, fontWeight: 500, cursor: 'pointer',
            outline: 'none',
          }}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value} style={{ background: '#0f0a28', color: '#fff' }}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown size={12} style={{
          position: 'absolute', right: 10,
          color: 'rgba(255,255,255,0.3)', pointerEvents: 'none',
        }} />
      </div>
    </div>
  )
}

// ── Inventory card item ────────────────────────────────────────────────────────

function InventoryCard({ item }: { item: InventoryListItem }) {
  const pnl =
    item.estimated_market_value != null && item.acquisition_cost != null && item.acquisition_cost > 0
      ? item.estimated_market_value - item.acquisition_cost
      : null

  const accentColor = item.recommendation_type
    ? (REC_BORDER[item.recommendation_type] ?? 'rgba(255,255,255,0.08)')
    : 'rgba(255,255,255,0.08)'

  const initial = (item.card.card_name?.[0] ?? '?').toUpperCase()

  return (
    <Link href={`/inventory/${item.item_id}`} className="block group">
      <div
        data-testid="inventory-item"
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 16px',
          borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(255,255,255,0.02)',
          cursor: 'pointer',
          position: 'relative',
          overflow: 'hidden',
          transition: 'background 0.15s, border-color 0.15s',
          borderLeft: `2px solid ${accentColor}`,
        }}
        onMouseEnter={(e) => {
          const el = e.currentTarget
          el.style.background = 'rgba(255,255,255,0.04)'
          el.style.borderColor = 'rgba(255,255,255,0.12)'
          el.style.borderLeftColor = accentColor === 'rgba(255,255,255,0.08)'
            ? 'rgba(255,255,255,0.2)'
            : accentColor
        }}
        onMouseLeave={(e) => {
          const el = e.currentTarget
          el.style.background = 'rgba(255,255,255,0.02)'
          el.style.borderColor = 'rgba(255,255,255,0.06)'
          el.style.borderLeftColor = accentColor
        }}
      >
        {/* Card back */}
        <CardBack initial={initial} />

        {/* Card info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
            <p style={{ fontSize: 14, fontWeight: 700, color: 'rgba(255,255,255,0.85)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {item.card.card_name}
            </p>
            {item.card.variant && (
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', flexShrink: 0 }}>
                {item.card.variant}
              </span>
            )}
          </div>
          <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.card.franchise_or_brand}
            {item.card.set_name ? ` · ${item.card.set_name}` : ''}
            {item.card.year ? ` · ${item.card.year}` : ''}
          </p>
        </div>

        {/* Right: cost → value → P&L inline flow */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {/* Cost */}
          <div className="hidden sm:flex" style={{ flexDirection: 'column', alignItems: 'flex-end', minWidth: 50 }}>
            <span style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.25)' }}>Cost</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.55)', fontVariantNumeric: 'tabular-nums' }}>
              {item.acquisition_cost != null && item.acquisition_cost > 0 ? fmt(item.acquisition_cost) : '—'}
            </span>
          </div>

          <span className="hidden sm:block" style={{ color: 'rgba(255,255,255,0.15)', fontSize: 10 }}>→</span>

          {/* Value */}
          <div className="hidden md:flex" style={{ flexDirection: 'column', alignItems: 'flex-end', minWidth: 56 }}>
            <span style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.25)' }}>Value</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.7)', fontVariantNumeric: 'tabular-nums' }}>
              {item.estimated_market_value != null ? fmt(item.estimated_market_value) : '—'}
            </span>
          </div>

          <span className="hidden md:block" style={{ color: 'rgba(255,255,255,0.15)', fontSize: 10 }}>→</span>

          {/* P&L */}
          <div className="hidden lg:flex" style={{ flexDirection: 'column', alignItems: 'flex-end', minWidth: 54 }}>
            <span style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.25)' }}>P&amp;L</span>
            <span style={{
              fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
              transition: 'transform 0.15s',
              color: pnl == null
                ? 'rgba(255,255,255,0.3)'
                : pnl > 0 ? '#34d399'
                : pnl < 0 ? '#f87171'
                : 'rgba(255,255,255,0.5)',
            }}>
              {pnl == null ? '—' : (pnl >= 0 ? '+' : '') + fmt(pnl)}
            </span>
          </div>

          {/* Rec badge */}
          {item.recommendation_type && (
            <span
              className="hidden sm:inline-flex"
              style={{ flexShrink: 0 }}
            >
              <span className={[
                'text-[10px] font-semibold px-2 py-0.5 rounded-full border inline-flex items-center',
                REC_STYLE[item.recommendation_type] ?? 'bg-white/5 text-white/40 border-white/10',
              ].join(' ')}>
                {REC_LABEL[item.recommendation_type] ?? item.recommendation_type}
              </span>
            </span>
          )}

          <StatusBadge status={item.status} />

          {/* Full price breakdown — stops propagation so it doesn't trigger the row's details link */}
          <a
            href={`/analyze/${item.catalog_id}`}
            onClick={(e) => e.stopPropagation()}
            title="View full price breakdown"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 24, height: 24, borderRadius: 6, flexShrink: 0,
              border: '1px solid rgba(255,255,255,0.1)',
              background: 'rgba(255,255,255,0.04)',
              color: 'rgba(255,255,255,0.3)',
              textDecoration: 'none',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget
              el.style.background = 'rgba(255,255,255,0.1)'
              el.style.color = 'rgba(255,255,255,0.7)'
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget
              el.style.background = 'rgba(255,255,255,0.04)'
              el.style.color = 'rgba(255,255,255,0.3)'
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="20" x2="18" y2="10"/>
              <line x1="12" y1="20" x2="12" y2="4"/>
              <line x1="6" y1="20" x2="6" y2="14"/>
            </svg>
          </a>

          <ChevronRight size={14} style={{ color: 'rgba(255,255,255,0.2)', flexShrink: 0, transition: 'color 0.15s' }} />
        </div>
      </div>
    </Link>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const [items, setItems]         = useState<InventoryListItem[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [activeFilter, setFilter] = useState<StatusFilter>('All')
  const [activeSort, setSort]     = useState<SortKey>('recent')

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

  const stats: HeroStats = useMemo(() => {
    const totalCards = items.length
    const itemsWithValue = items.filter((i) => i.estimated_market_value != null)
    const portfolioValue = itemsWithValue.length > 0
      ? itemsWithValue.reduce((s, i) => s + (i.estimated_market_value ?? 0), 0)
      : null
    const itemsWithCost = items.filter((i) => i.acquisition_cost != null && i.acquisition_cost > 0)
    const totalCost = itemsWithCost.length > 0
      ? itemsWithCost.reduce((s, i) => s + (i.acquisition_cost ?? 0), 0)
      : null
    const pnl = portfolioValue != null && totalCost != null ? portfolioValue - totalCost : null

    const withValue = items.filter((i) => i.estimated_market_value != null)
    const mostValuable = withValue.length > 0
      ? withValue.reduce((best, i) =>
          (i.estimated_market_value ?? 0) > (best.estimated_market_value ?? 0) ? i : best
        )
      : null

    const dist: Record<string, number> = {}
    for (const item of items) {
      if (item.recommendation_type) {
        dist[item.recommendation_type] = (dist[item.recommendation_type] ?? 0) + 1
      }
    }

    return { totalCards, portfolioValue, totalCost, pnl, mostValuable, dist }
  }, [items])

  const filteredSorted = useMemo(() => {
    let list = [...items]

    // Filter
    if (activeFilter !== 'All') {
      const statusMap: Record<StatusFilter, string> = {
        All:     '',
        Owned:   'owned',
        Listed:  'listed',
        Grading: 'grading',
        Sold:    'sold',
      }
      list = list.filter((i) => i.status?.toLowerCase() === statusMap[activeFilter])
    }

    // Sort
    switch (activeSort) {
      case 'price-high':
        list.sort((a, b) => (b.estimated_market_value ?? -1) - (a.estimated_market_value ?? -1))
        break
      case 'price-low':
        list.sort((a, b) => (a.estimated_market_value ?? Infinity) - (b.estimated_market_value ?? Infinity))
        break
      case 'name':
        list.sort((a, b) => a.card.card_name.localeCompare(b.card.card_name))
        break
      case 'recent':
      default:
        // Preserve server order (assumed newest-first)
        break
    }

    return list
  }, [items, activeFilter, activeSort])

  return (
    <div
      className="space-y-4 max-w-3xl mx-auto"
      style={{ paddingBottom: 40 }}
    >
      {/* Page header */}
      <div style={{ paddingBottom: 4 }}>
        <h1 style={{
          fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em',
          background: 'linear-gradient(135deg, rgba(255,255,255,0.9) 0%, rgba(165,180,252,0.8) 100%)',
          WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        }}>
          Inventory
        </h1>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>
          Portfolio tracker · Pricing intelligence · Status management
        </p>
      </div>

      {/* Loading */}
      {loading && <LoadingSkeleton />}

      {/* Error */}
      {!loading && error && (
        <p data-testid="inventory-error" className="text-sm text-destructive">{error}</p>
      )}

      {/* Empty state */}
      {!loading && !error && items.length === 0 && <EmptyState />}

      {/* Content */}
      {!loading && !error && items.length > 0 && (
        <>
          <HeroStatsBanner stats={stats} />

          <Toolbar
            activeFilter={activeFilter}
            onFilter={setFilter}
            activeSort={activeSort}
            onSort={setSort}
          />

          <div data-testid="inventory-list" className="space-y-1.5">
            <p style={{
              fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.2)', fontWeight: 600,
              paddingLeft: 4, paddingBottom: 4,
            }}>
              {filteredSorted.length} {filteredSorted.length === 1 ? 'card' : 'cards'}
              {activeFilter !== 'All' && ` · ${activeFilter}`}
            </p>

            {filteredSorted.length === 0 ? (
              <div style={{
                padding: '32px 16px', textAlign: 'center',
                color: 'rgba(255,255,255,0.25)', fontSize: 13,
                border: '1px dashed rgba(255,255,255,0.07)',
                borderRadius: 12,
              }}>
                No cards match this filter.
              </div>
            ) : (
              filteredSorted.map((item) => (
                <InventoryCard key={item.item_id} item={item} />
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}
