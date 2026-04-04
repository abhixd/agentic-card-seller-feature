'use client'

import { useEffect, useState, useMemo } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { Calendar, Clock, ChevronRight, Sparkles, Package } from 'lucide-react'
import type { PokemonTcgSet } from '@/lib/pokemon/pokemonTcgApi'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse "YYYY/MM/DD" into a local-midnight Date */
function parseSetDate(d: string): Date {
  const [y, m, day] = d.split('/').map(Number)
  return new Date(y, m - 1, day)
}

/** Days until (or since) a date. Negative = past. */
function daysUntil(d: Date): number {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.round((d.getTime() - now.getTime()) / 86_400_000)
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

function countdownLabel(days: number): { text: string; urgent: boolean } {
  if (days === 0)  return { text: 'TODAY',          urgent: true }
  if (days === 1)  return { text: 'TOMORROW',       urgent: true }
  if (days <= 7)   return { text: `${days}d away`,  urgent: true }
  if (days <= 30)  return { text: `${days}d away`,  urgent: false }
  const weeks = Math.round(days / 7)
  if (days <= 90)  return { text: `${weeks}w away`, urgent: false }
  const months = Math.round(days / 30)
  return { text: `${months}mo away`, urgent: false }
}

// Pre-release is always ~1 week before official release
function preReleaseDate(releaseDate: Date): Date {
  const d = new Date(releaseDate)
  d.setDate(d.getDate() - 7)
  return d
}

// ── Series color map ──────────────────────────────────────────────────────────
const SERIES_COLORS: Record<string, [string, string]> = {
  'Scarlet & Violet': ['#f43f5e', '#be123c'],
  'Sword & Shield':   ['#0ea5e9', '#0369a1'],
  'Sun & Moon':       ['#f59e0b', '#b45309'],
  'XY':               ['#3b82f6', '#1d4ed8'],
  'Black & White':    ['#6b7280', '#374151'],
  'HeartGold & SoulSilver': ['#fbbf24', '#d97706'],
  'Platinum':         ['#94a3b8', '#475569'],
  'Diamond & Pearl':  ['#a78bfa', '#7c3aed'],
}
function seriesColor(series: string): [string, string] {
  return SERIES_COLORS[series] ?? ['#6366f1', '#4338ca']
}

// ── SetCard component ─────────────────────────────────────────────────────────

function SetCard({ set, days }: { set: PokemonTcgSet; days: number }) {
  const date   = parseSetDate(set.releaseDate)
  const preRel = preReleaseDate(date)
  const [c1, c2] = seriesColor(set.series)
  const upcoming = days >= 0
  const { text: countdownText, urgent } = days >= 0
    ? countdownLabel(days)
    : { text: `${Math.abs(days)}d ago`, urgent: false }

  return (
    <Link href={`/sets`} className="block group">
      <div
        className="relative rounded-2xl border overflow-hidden transition-all duration-300 hover:scale-[1.02] hover:shadow-xl"
        style={{
          background:   `linear-gradient(135deg, ${c1}12 0%, ${c2}08 100%)`,
          borderColor:  upcoming ? `${c1}35` : 'rgba(255,255,255,0.07)',
          boxShadow:    upcoming ? `0 0 20px 0 ${c1}18` : undefined,
        }}
      >
        {/* Urgency glow for soon-releases */}
        {urgent && (
          <div
            className="absolute inset-0 pointer-events-none rounded-2xl animate-pulse"
            style={{ boxShadow: `inset 0 0 30px 0 ${c1}20` }}
          />
        )}

        <div className="p-4 flex gap-4 items-start">
          {/* Set logo */}
          <div
            className="relative flex-shrink-0 w-16 h-16 rounded-xl flex items-center justify-center overflow-hidden"
            style={{ background: `linear-gradient(135deg, ${c1}20, ${c2}15)`, border: `1px solid ${c1}30` }}
          >
            {set.images.logo ? (
              <Image
                src={set.images.logo}
                alt={set.name}
                fill
                className="object-contain p-1.5"
                sizes="64px"
                unoptimized
              />
            ) : (
              <Package className="h-6 w-6" style={{ color: c1 }} />
            )}
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[10px] font-medium tracking-wider uppercase mb-0.5" style={{ color: c1 }}>
                  {set.series}
                </p>
                <h3 className="font-semibold text-white/90 text-sm leading-tight truncate">
                  {set.name}
                </h3>
              </div>

              {/* Countdown badge */}
              <span
                className="flex-shrink-0 text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full"
                style={{
                  background: upcoming
                    ? urgent ? `${c1}30` : `${c1}18`
                    : 'rgba(255,255,255,0.06)',
                  color: upcoming ? (urgent ? c1 : `${c1}cc`) : 'rgba(255,255,255,0.3)',
                  border: `1px solid ${upcoming ? c1 + '40' : 'rgba(255,255,255,0.08)'}`,
                }}
              >
                {countdownText}
              </span>
            </div>

            {/* Date + card count */}
            <div className="flex items-center gap-3 mt-2">
              <div className="flex items-center gap-1 text-[11px] text-white/40">
                <Calendar className="h-3 w-3" />
                {formatDate(date)}
              </div>
              {set.total > 0 && (
                <div className="text-[11px] text-white/25">
                  {set.printedTotal} cards
                </div>
              )}
            </div>

            {/* Pre-release note for upcoming sets */}
            {upcoming && daysUntil(preRel) >= 0 && (
              <p className="text-[10px] text-white/30 mt-1">
                Pre-release: {formatDate(preRel)}
              </p>
            )}
          </div>
        </div>

        {/* Hover arrow */}
        <ChevronRight
          className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/10 group-hover:text-white/30 group-hover:translate-x-0.5 transition-all duration-200"
        />
      </div>
    </Link>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ReleasesPage() {
  const [sets, setSets]       = useState<PokemonTcgSet[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/catalog/sets')
      .then(r => r.json())
      .then(d => setSets(d.sets ?? []))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const today = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d
  }, [])

  // Upcoming: future releases sorted ascending (soonest first)
  const upcoming = useMemo(() =>
    sets
      .map(s => ({ set: s, days: daysUntil(parseSetDate(s.releaseDate)) }))
      .filter(x => x.days >= 0)
      .sort((a, b) => a.days - b.days),
    [sets]
  )

  // Recent: released in last 90 days, sorted by most recent first
  const recent = useMemo(() =>
    sets
      .map(s => ({ set: s, days: daysUntil(parseSetDate(s.releaseDate)) }))
      .filter(x => x.days < 0 && x.days >= -90)
      .sort((a, b) => b.days - a.days),
    [sets]
  )

  // Next up (the very next release)
  const nextSet = upcoming[0]

  return (
    <div className="min-h-screen p-4 md:p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="flex items-center justify-center w-9 h-9 rounded-xl"
          style={{ background: 'linear-gradient(135deg, #06b6d4, #0891b2)' }}
        >
          <Calendar className="h-4.5 w-4.5 text-white h-[18px] w-[18px]" />
        </div>
        <div>
          <h1
            className="text-lg font-bold"
            style={{
              background: 'linear-gradient(90deg, #67e8f9, #22d3ee)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            Release Calendar
          </h1>
          <p className="text-xs text-white/30">Upcoming & recent Pokémon TCG sets</p>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-24 rounded-2xl bg-white/[0.04] animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          {/* Hero: Next release */}
          {nextSet && (
            <div
              className="relative rounded-2xl border overflow-hidden p-5"
              style={{
                background: `linear-gradient(135deg, ${seriesColor(nextSet.set.series)[0]}18, transparent)`,
                borderColor: `${seriesColor(nextSet.set.series)[0]}40`,
                boxShadow: `0 0 40px 0 ${seriesColor(nextSet.set.series)[0]}15`,
              }}
            >
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="h-3.5 w-3.5" style={{ color: seriesColor(nextSet.set.series)[0] }} />
                <span className="text-[10px] font-bold tracking-widest uppercase text-white/40">
                  Next Release
                </span>
              </div>
              <div className="flex items-center gap-5">
                <div
                  className="relative flex-shrink-0 w-20 h-20 rounded-xl overflow-hidden"
                  style={{
                    background: `linear-gradient(135deg, ${seriesColor(nextSet.set.series)[0]}25, ${seriesColor(nextSet.set.series)[1]}18)`,
                    border: `1px solid ${seriesColor(nextSet.set.series)[0]}40`,
                  }}
                >
                  {nextSet.set.images.logo ? (
                    <Image
                      src={nextSet.set.images.logo}
                      alt={nextSet.set.name}
                      fill
                      className="object-contain p-2"
                      sizes="80px"
                      unoptimized
                    />
                  ) : (
                    <Package className="h-8 w-8 m-auto mt-6" style={{ color: seriesColor(nextSet.set.series)[0] }} />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-medium tracking-wider uppercase mb-1" style={{ color: seriesColor(nextSet.set.series)[0] }}>
                    {nextSet.set.series}
                  </p>
                  <h2 className="text-xl font-bold text-white mb-1">{nextSet.set.name}</h2>
                  <div className="flex items-center gap-2 text-sm text-white/50">
                    <Clock className="h-3.5 w-3.5" />
                    {nextSet.days === 0 ? 'Releasing today!' : nextSet.days === 1 ? 'Tomorrow' : `${nextSet.days} days`}
                    <span className="text-white/20">·</span>
                    <span>{formatDate(parseSetDate(nextSet.set.releaseDate))}</span>
                  </div>
                  {nextSet.set.printedTotal > 0 && (
                    <p className="text-xs text-white/25 mt-1">{nextSet.set.printedTotal} cards · Pre-release {formatDate(preReleaseDate(parseSetDate(nextSet.set.releaseDate)))}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Upcoming sets */}
          {upcoming.length > 1 && (
            <section className="space-y-3">
              <h2 className="text-xs font-semibold tracking-widest uppercase text-white/30 px-1">
                Coming Up — {upcoming.length - 1} set{upcoming.length - 1 !== 1 ? 's' : ''}
              </h2>
              <div className="space-y-2">
                {upcoming.slice(1).map(({ set, days }) => (
                  <SetCard key={set.id} set={set} days={days} />
                ))}
              </div>
            </section>
          )}

          {upcoming.length === 0 && !loading && (
            <div className="rounded-2xl border border-white/[0.07] p-8 text-center">
              <Calendar className="h-8 w-8 text-white/15 mx-auto mb-2" />
              <p className="text-sm text-white/30">No upcoming releases announced yet</p>
              <p className="text-xs text-white/15 mt-1">Check back soon — new sets are announced regularly</p>
            </div>
          )}

          {/* Recently released */}
          {recent.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-semibold tracking-widest uppercase text-white/30 px-1">
                Recently Released — last 90 days
              </h2>
              <div className="space-y-2">
                {recent.map(({ set, days }) => (
                  <SetCard key={set.id} set={set} days={days} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Bottom padding for mobile nav */}
      <div className="h-20 md:h-4" />
    </div>
  )
}
