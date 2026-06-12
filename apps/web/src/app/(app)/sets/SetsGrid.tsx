'use client'

import { useState, useMemo } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import type { PokemonTcgSet } from '@/lib/pokemon/pokemonTcgApi'

// ── Series color palette ──────────────────────────────────────────────────────

const SERIES_PALETTES: Record<string, { from: string; to: string; accent: string; glow: string }> = {
  'Scarlet & Violet':   { from: '#3b1515', to: '#1a0a2e', accent: '#f87171', glow: 'rgba(248,113,113,0.35)' },
  'Sword & Shield':     { from: '#0c1f3a', to: '#0a1a0e', accent: '#60a5fa', glow: 'rgba(96,165,250,0.35)' },
  'Sun & Moon':         { from: '#2a1a00', to: '#1a0a00', accent: '#fbbf24', glow: 'rgba(251,191,36,0.35)' },
  'XY':                 { from: '#1a0a2e', to: '#0a1520', accent: '#a78bfa', glow: 'rgba(167,139,250,0.35)' },
  'Black & White':      { from: '#111111', to: '#1a1a2e', accent: '#e2e8f0', glow: 'rgba(226,232,240,0.3)' },
  'HeartGold & SoulSilver': { from: '#1a1200', to: '#0a1a00', accent: '#fcd34d', glow: 'rgba(252,211,77,0.35)' },
  'Platinum':           { from: '#0f1a2e', to: '#1a0f2e', accent: '#93c5fd', glow: 'rgba(147,197,253,0.35)' },
  'Diamond & Pearl':    { from: '#0a0f2e', to: '#1a0a2e', accent: '#c4b5fd', glow: 'rgba(196,181,253,0.35)' },
  'EX':                 { from: '#1a0a0a', to: '#0a1a0a', accent: '#f97316', glow: 'rgba(249,115,22,0.35)' },
  'Base':               { from: '#0a1a0a', to: '#0a0a1a', accent: '#4ade80', glow: 'rgba(74,222,128,0.35)' },
  'Gym':                { from: '#1a1a0a', to: '#0a1a0a', accent: '#a3e635', glow: 'rgba(163,230,53,0.35)' },
  'Neo':                { from: '#0a0a0a', to: '#1a0a1a', accent: '#e879f9', glow: 'rgba(232,121,249,0.35)' },
}

const DEFAULT_PALETTE = { from: '#111827', to: '#0d1117', accent: '#6b7280', glow: 'rgba(107,114,128,0.25)' }

function getSeriesPalette(series: string) {
  for (const [key, val] of Object.entries(SERIES_PALETTES)) {
    if (series.toLowerCase().includes(key.toLowerCase())) return val
  }
  return DEFAULT_PALETTE
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function releaseYear(date: string): string {
  return date.split('/')[0] ?? date
}

function isNewSet(releaseDate: string): boolean {
  const release = new Date(releaseDate.replace(/\//g, '-'))
  const cutoff  = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  return release >= cutoff
}

function groupBySeries(sets: PokemonTcgSet[]): Map<string, PokemonTcgSet[]> {
  const map = new Map<string, PokemonTcgSet[]>()
  for (const set of sets) {
    const arr = map.get(set.series) ?? []
    arr.push(set)
    map.set(set.series, arr)
  }
  return new Map(
    [...map.entries()].sort(([, a], [, b]) => {
      const maxA = a.reduce((m, s) => (s.releaseDate > m ? s.releaseDate : m), '')
      const maxB = b.reduce((m, s) => (s.releaseDate > m ? s.releaseDate : m), '')
      return maxB.localeCompare(maxA)
    })
  )
}

// ── Set Card ──────────────────────────────────────────────────────────────────

function SetCard({ set, palette }: { set: PokemonTcgSet; palette: ReturnType<typeof getSeriesPalette> }) {
  const [hovered, setHovered] = useState(false)
  const isNew = isNewSet(set.releaseDate)

  return (
    <Link
      href={`/sets/${set.id}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="group flex flex-col rounded-xl border border-white/8 overflow-hidden transition-all duration-200"
      style={{
        background: `linear-gradient(145deg, ${palette.from}ee, ${palette.to}ee)`,
        backdropFilter: 'blur(12px)',
        borderColor: hovered ? `${palette.accent}55` : 'rgba(255,255,255,0.07)',
        boxShadow: hovered
          ? `0 0 24px 4px ${palette.glow}, 0 8px 32px rgba(0,0,0,0.4)`
          : '0 2px 8px rgba(0,0,0,0.3)',
        transform: hovered ? 'translateY(-3px) scale(1.01)' : 'translateY(0) scale(1)',
      }}
    >
      {/* Logo area */}
      <div
        className="relative flex items-center justify-center h-20 overflow-hidden"
        style={{
          background: `radial-gradient(ellipse at center, ${palette.accent}18 0%, transparent 70%)`,
        }}
      >
        {/* Subtle shimmer line */}
        <div
          className="absolute inset-x-0 top-0 h-px"
          style={{ background: `linear-gradient(90deg, transparent, ${palette.accent}44, transparent)` }}
        />

        {(set.images?.logo || set.images?.symbol) ? (
          <Image
            src={set.images.logo ?? set.images.symbol}
            alt={set.name}
            width={160}
            height={64}
            className="object-contain max-h-16 px-3 drop-shadow-lg transition-transform duration-200 group-hover:scale-105"
            unoptimized
          />
        ) : (
          <span className="text-3xl opacity-30">🃏</span>
        )}

        {/* NEW badge */}
        {isNew && (
          <div
            className="absolute top-2 right-2 text-[9px] font-black px-1.5 py-0.5 rounded-md tracking-wider"
            style={{
              background: `linear-gradient(135deg, ${palette.accent}, ${palette.accent}cc)`,
              color: '#000',
              boxShadow: `0 0 8px ${palette.glow}`,
            }}
          >
            NEW
          </div>
        )}
      </div>

      {/* Info */}
      <div className="px-3 pb-3 pt-2 flex flex-col gap-0.5">
        <p
          className="text-[11px] font-semibold leading-tight line-clamp-2 transition-colors duration-150"
          style={{ color: hovered ? palette.accent : 'rgba(255,255,255,0.85)' }}
        >
          {set.name}
        </p>
        <p className="text-[10px]" style={{ color: 'rgba(255,255,255,0.35)' }}>
          {releaseYear(set.releaseDate)} · {set.printedTotal} cards
        </p>
      </div>
    </Link>
  )
}

// ── Main Grid ─────────────────────────────────────────────────────────────────

interface SetsGridProps {
  sets: PokemonTcgSet[]
  totalCards: number
}

export default function SetsGrid({ sets, totalCards }: SetsGridProps) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    if (!query.trim()) return sets
    const q = query.toLowerCase()
    return sets.filter(s => s.name.toLowerCase().includes(q) || s.series.toLowerCase().includes(q))
  }, [sets, query])

  const grouped = useMemo(() => groupBySeries(filtered), [filtered])

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-10">
        <div className="flex flex-col sm:flex-row sm:items-end gap-4 mb-6">
          <div className="flex-1">
            <h1
              className="text-3xl font-black tracking-tight"
              style={{
                background: 'linear-gradient(135deg, #fff 0%, #a78bfa 40%, #60a5fa 80%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}
            >
              Browse by Set
            </h1>
            <p className="text-sm mt-1" style={{ color: 'rgba(255,255,255,0.35)' }}>
              {sets.length} sets · {totalCards.toLocaleString()}+ cards
            </p>
          </div>

          {/* Search */}
          <div className="relative w-full sm:w-72">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 pointer-events-none"
              style={{ color: 'rgba(255,255,255,0.3)' }}
              fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
            >
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search sets or series…"
              className="w-full pl-9 pr-4 py-2.5 rounded-xl text-sm outline-none transition-all duration-150"
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'rgba(255,255,255,0.85)',
                backdropFilter: 'blur(8px)',
              }}
              onFocus={e => {
                e.currentTarget.style.border = '1px solid rgba(167,139,250,0.5)'
                e.currentTarget.style.boxShadow = '0 0 0 3px rgba(167,139,250,0.12)'
              }}
              onBlur={e => {
                e.currentTarget.style.border = '1px solid rgba(255,255,255,0.1)'
                e.currentTarget.style.boxShadow = 'none'
              }}
            />
          </div>
        </div>

        {/* Divider */}
        <div
          className="h-px w-full"
          style={{ background: 'linear-gradient(90deg, rgba(167,139,250,0.4), rgba(96,165,250,0.4), transparent)' }}
        />
      </div>

      {/* No results */}
      {filtered.length === 0 && (
        <div className="text-center py-20" style={{ color: 'rgba(255,255,255,0.25)' }}>
          No sets found for &ldquo;{query}&rdquo;
        </div>
      )}

      {/* Series groups */}
      {[...grouped.entries()].map(([series, seriesSets]) => {
        const palette = getSeriesPalette(series)
        return (
          <section key={series} className="mb-12">
            {/* Series header */}
            <div className="flex items-center gap-3 mb-5">
              {/* Accent line */}
              <div
                className="w-1 h-6 rounded-full flex-shrink-0"
                style={{ background: `linear-gradient(180deg, ${palette.accent}, ${palette.accent}55)` }}
              />
              <h2
                className="text-sm font-bold uppercase tracking-widest"
                style={{ color: palette.accent }}
              >
                {series}
              </h2>
              {/* Count badge */}
              <div
                className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                style={{
                  background: `${palette.accent}18`,
                  color: palette.accent,
                  border: `1px solid ${palette.accent}30`,
                }}
              >
                {seriesSets.length}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {seriesSets.map(set => (
                <SetCard key={set.id} set={set} palette={palette} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
