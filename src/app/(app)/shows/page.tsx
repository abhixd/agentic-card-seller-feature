'use client'

import { useState, useCallback, useRef } from 'react'
import {
  MapPin, Calendar, ExternalLink, Loader2, RefreshCw,
  Search, Navigation, AlertCircle, Info, X, Filter,
} from 'lucide-react'
import type { CardShowEvent, EventType } from '@/lib/events/types'

// ── Constants ──────────────────────────────────────────────────────────────────

const EVENT_TYPE_META: Record<string, { label: string; color: string; bg: string; border: string }> = {
  card_show:       { label: 'Card Show',       color: '#10b981', bg: 'rgba(16,185,129,0.12)',  border: 'rgba(16,185,129,0.25)' },
  tcg_tournament:  { label: 'TCG Tournament',  color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)', border: 'rgba(139,92,246,0.25)' },
  convention:      { label: 'Convention',      color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.25)' },
  collector_event: { label: 'Collector Event', color: '#3b82f6', bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.25)' },
  general:         { label: 'General',         color: '#6b7280', bg: 'rgba(107,114,128,0.12)', border: 'rgba(107,114,128,0.25)' },
}

const SOURCE_META: Record<string, { label: string; color: string }> = {
  ticketmaster:   { label: 'Ticketmaster',   color: '#00b4d8' },
  tabletop_events:{ label: 'Tabletop.Events', color: '#7c3aed' },
  seatgeek:       { label: 'SeatGeek',       color: '#e11d48' },
  manual:         { label: 'Manual',         color: '#6b7280' },
}

const RADIUS_OPTIONS = [10, 25, 50, 100, 200] as const
const DATE_RANGE_OPTIONS = [
  { label: 'Next 7 days',  days: 7   },
  { label: 'Next 30 days', days: 30  },
  { label: 'Next 90 days', days: 90  },
] as const

const EVENT_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all',             label: 'All Types'       },
  { value: 'card_show',       label: 'Card Shows'      },
  { value: 'tcg_tournament',  label: 'TCG Tournaments' },
  { value: 'convention',      label: 'Conventions'     },
  { value: 'collector_event', label: 'Collector Events'},
]

// ── Geocoding ──────────────────────────────────────────────────────────────────

interface GeoResult {
  lat:   number
  lon:   number
  city:  string
  state: string
}

async function geocodeLocation(query: string): Promise<GeoResult | null> {
  try {
    const q = /^\d{5}(-\d{4})?$/.test(query.trim())
      ? `postalcode=${encodeURIComponent(query.trim())}&countrycodes=us`
      : `q=${encodeURIComponent(query.trim())}&countrycodes=us`

    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?${q}&format=json&limit=1&addressdetails=1`,
      { headers: { 'Accept-Language': 'en', 'User-Agent': 'CardSellerOS/1.0' } }
    )
    const data = await res.json()
    if (!data?.[0]) return null
    const d    = data[0]
    const addr = d.address ?? {}
    return {
      lat:   parseFloat(d.lat),
      lon:   parseFloat(d.lon),
      city:  addr.city ?? addr.town ?? addr.village ?? addr.county ?? d.display_name.split(',')[0] ?? '',
      state: addr.state ?? '',
    }
  } catch {
    return null
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDateRange(startAt: string, endAt?: string | null): string {
  const start = new Date(startAt)
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
  const startStr = start.toLocaleDateString('en-US', opts)
  if (!endAt) return startStr
  const end = new Date(endAt)
  // Same day
  if (start.toDateString() === end.toDateString()) return startStr
  // Same month/year
  if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
    return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${end.getDate()}, ${end.getFullYear()}`
  }
  return `${startStr} – ${end.toLocaleDateString('en-US', opts)}`
}

function formatTime(isoStr: string): string {
  const d = new Date(isoStr)
  // If time is exactly midnight UTC — likely no time data
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return ''
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function EventTypeBadge({ type }: { type: string }) {
  const meta = EVENT_TYPE_META[type] ?? EVENT_TYPE_META.general
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider"
      style={{ color: meta.color, background: meta.bg, border: `1px solid ${meta.border}` }}
    >
      {meta.label}
    </span>
  )
}

function SourceBadge({ source }: { source: string }) {
  const meta = SOURCE_META[source] ?? { label: source, color: '#6b7280' }
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-widest"
      style={{ color: meta.color, background: `${meta.color}18`, border: `1px solid ${meta.color}30` }}
    >
      {meta.label}
    </span>
  )
}

function SkeletonCard() {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-4 space-y-3 animate-pulse">
      <div className="flex items-start justify-between gap-2">
        <div className="h-4 w-20 rounded bg-white/8" />
        <div className="h-4 w-16 rounded bg-white/5" />
      </div>
      <div className="h-5 w-3/4 rounded bg-white/10" />
      <div className="h-3 w-1/2 rounded bg-white/5" />
      <div className="h-3 w-2/3 rounded bg-white/5" />
      <div className="flex items-center justify-between pt-1">
        <div className="h-3 w-24 rounded bg-white/5" />
        <div className="h-7 w-24 rounded-lg bg-white/5" />
      </div>
    </div>
  )
}

function EventCard({ event }: { event: CardShowEvent }) {
  const meta     = EVENT_TYPE_META[event.event_type] ?? EVENT_TYPE_META.general
  const timeStr  = formatTime(event.start_at)
  const location = [event.venue_name, [event.city, event.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')

  return (
    <div
      className="group relative rounded-2xl border bg-white/[0.02] p-4 flex flex-col gap-3 transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/[0.035]"
      style={{ borderColor: 'rgba(255,255,255,0.08)' }}
    >
      {/* Left accent */}
      <div
        className="absolute left-0 top-4 bottom-4 w-[3px] rounded-r-full opacity-60 group-hover:opacity-100 transition-opacity"
        style={{ background: `linear-gradient(180deg, ${meta.color}, ${meta.color}66)` }}
      />

      {/* Top row: badge + source + distance */}
      <div className="flex items-start justify-between gap-2 pl-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <EventTypeBadge type={event.event_type} />
          <SourceBadge source={event.source} />
        </div>
        {event.distance != null && (
          <span className="flex-shrink-0 text-[10px] font-semibold text-white/40 bg-white/5 border border-white/8 px-2 py-0.5 rounded-full">
            {event.distance} mi
          </span>
        )}
      </div>

      {/* Title */}
      <h3 className="pl-2 text-sm font-bold text-white leading-snug line-clamp-2 group-hover:text-white/95 transition-colors">
        {event.title}
      </h3>

      {/* Date + time */}
      <div className="pl-2 flex items-center gap-1.5 text-xs text-white/50">
        <Calendar className="h-3.5 w-3.5 shrink-0 text-white/25" />
        <span>{formatDateRange(event.start_at, event.end_at)}</span>
        {timeStr && <span className="text-white/30">· {timeStr}</span>}
      </div>

      {/* Venue / location */}
      {location && (
        <div className="pl-2 flex items-start gap-1.5 text-xs text-white/40">
          <MapPin className="h-3.5 w-3.5 shrink-0 mt-0.5 text-white/20" />
          <span className="line-clamp-1">{location}</span>
        </div>
      )}

      {/* Tags */}
      {event.tags && event.tags.length > 0 && (
        <div className="pl-2 flex flex-wrap gap-1">
          {event.tags.map(tag => (
            <span key={tag} className="text-[9px] uppercase tracking-wider text-white/25 bg-white/5 px-1.5 py-0.5 rounded">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Footer: view button */}
      {event.url && (
        <div className="pl-2 pt-1 border-t border-white/5">
          <a
            href={event.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 hover:opacity-90 hover:scale-[1.02] active:scale-[0.98]"
            style={{ background: `linear-gradient(135deg, ${meta.color}28, ${meta.color}18)`, color: meta.color, border: `1px solid ${meta.color}30` }}
          >
            <ExternalLink className="h-3 w-3" />
            View Event
          </a>
        </div>
      )}
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function EventDiscoveryPage() {
  const [locationQuery, setLocationQuery]   = useState('')
  const [geo,           setGeo]             = useState<GeoResult | null>(null)
  const [radius,        setRadius]          = useState<number>(50)
  const [eventType,     setEventType]       = useState('all')
  const [dateRangeDays, setDateRangeDays]   = useState(90)
  const [keyword,       setKeyword]         = useState('')

  const [events,        setEvents]          = useState<CardShowEvent[]>([])
  const [total,         setTotal]           = useState<number | null>(null)
  const [freshFetch,    setFreshFetch]      = useState(false)

  const [geocoding,     setGeocoding]       = useState(false)
  const [searching,     setSearching]       = useState(false)
  const [refreshing,    setRefreshing]      = useState(false)
  const [geoError,      setGeoError]        = useState<string | null>(null)
  const [searchError,   setSearchError]     = useState<string | null>(null)
  const [refreshMsg,    setRefreshMsg]      = useState<string | null>(null)

  const searchAbortRef = useRef<AbortController | null>(null)

  // ── Search events from DB ────────────────────────────────────────────────────
  const searchEvents = useCallback(async (geoResult: GeoResult, opts?: {
    radiusOverride?:   number
    typeOverride?:     string
    daysOverride?:     number
    keywordOverride?:  string
  }) => {
    const r    = opts?.radiusOverride  ?? radius
    const t    = opts?.typeOverride    ?? eventType
    const days = opts?.daysOverride    ?? dateRangeDays
    const kw   = opts?.keywordOverride ?? keyword

    // Cancel any in-flight search
    searchAbortRef.current?.abort()
    const ctrl = new AbortController()
    searchAbortRef.current = ctrl

    setSearching(true)
    setSearchError(null)

    try {
      const startDate = new Date().toISOString()
      const endDate   = new Date(Date.now() + days * 86_400_000).toISOString()
      const params    = new URLSearchParams({
        lat:       String(geoResult.lat),
        lng:       String(geoResult.lon),
        radius:    String(r),
        type:      t,
        startDate,
        endDate,
        ...(kw ? { q: kw } : {}),
      })

      const res  = await fetch(`/api/shows/search?${params}`, { signal: ctrl.signal })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Search failed')

      setEvents(json.events ?? [])
      setTotal(json.total ?? 0)
      setFreshFetch(!!json.freshFetch)
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setSearchError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setSearching(false)
    }
  }, [radius, eventType, dateRangeDays, keyword])

  // ── Geocode + search ─────────────────────────────────────────────────────────
  const handleGeocode = useCallback(async () => {
    if (!locationQuery.trim()) { setGeoError('Enter a city, zip code, or state'); return }
    setGeocoding(true)
    setGeoError(null)

    const result = await geocodeLocation(locationQuery.trim())
    if (!result) {
      setGeoError('Location not found — try a city name or zip code')
      setGeocoding(false)
      return
    }

    setGeo(result)
    setGeocoding(false)
    await searchEvents(result)
  }, [locationQuery, searchEvents])

  // ── Refresh from sources ─────────────────────────────────────────────────────
  const handleRefresh = useCallback(async () => {
    const adminSecret = process.env.NEXT_PUBLIC_ADMIN_SECRET  // intentionally empty in prod
    setRefreshing(true)
    setRefreshMsg(null)

    try {
      const res = await fetch('/api/shows/ingest', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${adminSecret ?? ''}`,
        },
      })
      const json = await res.json()
      if (!res.ok) {
        setRefreshMsg(res.status === 401
          ? 'Set ADMIN_SECRET in .env.local to refresh from sources'
          : `Refresh failed: ${json.error ?? 'Unknown error'}`
        )
      } else {
        setRefreshMsg(`Ingested ${json.inserted} events${json.errors?.length ? ` (${json.errors.length} source error(s))` : ''}`)
        // Re-search if we have a geo location
        if (geo) await searchEvents(geo)
      }
    } catch {
      setRefreshMsg('Refresh request failed')
    } finally {
      setRefreshing(false)
    }
  }, [geo, searchEvents])

  // ── Filter change helpers ────────────────────────────────────────────────────
  const handleRadiusChange = (r: number) => {
    setRadius(r)
    if (geo) searchEvents(geo, { radiusOverride: r })
  }
  const handleTypeChange = (t: string) => {
    setEventType(t)
    if (geo) searchEvents(geo, { typeOverride: t })
  }
  const handleDaysChange = (d: number) => {
    setDateRangeDays(d)
    if (geo) searchEvents(geo, { daysOverride: d })
  }
  const handleKeywordSearch = () => {
    if (geo) searchEvents(geo, { keywordOverride: keyword })
  }

  const hasResults = total !== null

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-16">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1
            className="text-xl font-bold tracking-tight flex items-center gap-2"
            style={{
              background: 'linear-gradient(90deg, #06b6d4, #22d3ee, #67e8f9)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            <MapPin className="h-5 w-5 text-cyan-400" style={{ WebkitTextFillColor: 'initial' }} />
            Event Discovery
          </h1>
          {hasResults && geo ? (
            <p className="text-xs text-white/40 mt-1">
              <span className="text-white/70 font-semibold">{total}</span>
              {' '}event{total !== 1 ? 's' : ''} found near{' '}
              <span className="text-white/60">{geo.city}{geo.state ? `, ${geo.state}` : ''}</span>
            </p>
          ) : (
            <p className="text-xs text-white/25 mt-1">
              Card shows, TCG tournaments, and collector events near you
            </p>
          )}
        </div>

        {/* Refresh button */}
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium text-white/50 hover:text-white/80 bg-white/[0.04] hover:bg-white/[0.07] border border-white/8 hover:border-white/15 transition-all disabled:opacity-40"
          title="Refresh events from Ticketmaster, Tabletop.Events, SeatGeek"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Refresh message */}
      {refreshMsg && (
        <div className={`flex items-center gap-2 text-xs px-3 py-2 rounded-xl border ${
          refreshMsg.includes('error') || refreshMsg.includes('failed') || refreshMsg.includes('Set ')
            ? 'text-amber-400 bg-amber-400/8 border-amber-400/20'
            : 'text-emerald-400 bg-emerald-400/8 border-emerald-400/20'
        }`}>
          <Info className="h-3.5 w-3.5 shrink-0" />
          {refreshMsg}
        </div>
      )}

      {/* Fresh-fetch notice */}
      {freshFetch && !searching && total !== null && (
        <div className="flex items-center gap-2 text-xs px-3 py-2 rounded-xl border text-cyan-400 bg-cyan-400/8 border-cyan-400/20">
          <RefreshCw className="h-3.5 w-3.5 shrink-0" />
          Fetched live from Ticketmaster &amp; Tabletop.Events — results cached for 6 hours
        </div>
      )}

      {/* ── Location + keyword search ────────────────────────────────────────── */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-5 space-y-4">

        {/* Location row */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1 relative">
            <Navigation className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/20" />
            <input
              type="text"
              value={locationQuery}
              onChange={e => { setLocationQuery(e.target.value); setGeoError(null) }}
              onKeyDown={e => e.key === 'Enter' && handleGeocode()}
              placeholder="City, zip code, or state (e.g. Seattle WA, 90210)"
              className="w-full rounded-xl border border-white/10 bg-white/[0.03] pl-9 pr-9 py-2.5 text-sm text-white/90 placeholder:text-white/20 focus:outline-none focus:border-cyan-400/30 focus:bg-cyan-400/[0.03] transition-all"
            />
            {locationQuery && (
              <button
                onClick={() => { setLocationQuery(''); setGeoError(null); setGeo(null); setEvents([]); setTotal(null) }}
                className="absolute right-3 top-1/2 -translate-y-1/2"
              >
                <X className="h-3.5 w-3.5 text-white/20 hover:text-white/50 transition-colors" />
              </button>
            )}
          </div>

          <button
            onClick={handleGeocode}
            disabled={geocoding || searching}
            className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50 transition-all hover:opacity-90 active:scale-[0.98]"
            style={{ background: 'linear-gradient(135deg, #06b6d4, #0891b2)' }}
          >
            {geocoding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {geocoding ? 'Locating…' : 'Find Events'}
          </button>
        </div>

        {geoError && (
          <p className="text-xs text-red-400 flex items-center gap-1.5">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {geoError}
          </p>
        )}

        {/* Filter row */}
        <div className="flex flex-wrap gap-3 items-center">
          <Filter className="h-3.5 w-3.5 text-white/20 shrink-0" />

          {/* Radius */}
          <div className="flex items-center gap-1 bg-white/[0.04] rounded-xl p-1 border border-white/8">
            {RADIUS_OPTIONS.map(r => (
              <button
                key={r}
                onClick={() => handleRadiusChange(r)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                  radius === r ? 'bg-white/10 text-white/90' : 'text-white/30 hover:text-white/60'
                }`}
              >
                {r}mi
              </button>
            ))}
          </div>

          {/* Event type */}
          <select
            value={eventType}
            onChange={e => handleTypeChange(e.target.value)}
            className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/70 focus:outline-none focus:border-cyan-400/30 transition-all cursor-pointer"
          >
            {EVENT_TYPE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          {/* Date range */}
          <div className="flex items-center gap-1 bg-white/[0.04] rounded-xl p-1 border border-white/8">
            {DATE_RANGE_OPTIONS.map(o => (
              <button
                key={o.days}
                onClick={() => handleDaysChange(o.days)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                  dateRangeDays === o.days ? 'bg-white/10 text-white/90' : 'text-white/30 hover:text-white/60'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* Keyword search */}
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-white/20" />
            <input
              type="text"
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleKeywordSearch()}
              placeholder="Filter by keyword (e.g. pokemon, PSA, vintage)"
              className="w-full rounded-xl border border-white/8 bg-white/[0.02] pl-9 pr-4 py-2 text-xs text-white/70 placeholder:text-white/20 focus:outline-none focus:border-cyan-400/20 transition-all"
            />
          </div>
          <button
            onClick={handleKeywordSearch}
            disabled={!geo || searching}
            className="px-3 py-2 rounded-xl text-xs font-medium text-white/50 hover:text-white/80 bg-white/[0.04] hover:bg-white/[0.07] border border-white/8 disabled:opacity-30 transition-all"
          >
            Filter
          </button>
        </div>
      </div>

      {/* ── Results ──────────────────────────────────────────────────────────── */}

      {/* Loading skeleton */}
      {searching && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-xs text-cyan-400/70 bg-cyan-400/5 border border-cyan-400/15 rounded-xl px-3 py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
            Searching Ticketmaster &amp; Tabletop.Events near you — this may take a few seconds…
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        </div>
      )}

      {/* Search error */}
      {searchError && !searching && (
        <div className="flex items-center gap-2 text-sm text-red-400 bg-red-400/8 border border-red-400/20 rounded-2xl px-4 py-3">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {searchError}
        </div>
      )}

      {/* No-geo prompt */}
      {!geo && !searching && !searchError && (
        <div className="rounded-2xl border border-white/8 bg-white/[0.015] px-6 py-12 flex flex-col items-center gap-4 text-center">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #06b6d422, #0891b218)', border: '1px solid #06b6d430' }}
          >
            <MapPin className="h-7 w-7 text-cyan-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white/70">Enter your location to find events</p>
            <p className="text-xs text-white/30 mt-1">
              We search Ticketmaster, Tabletop.Events, and SeatGeek for card shows,
              TCG tournaments, and collector events near you.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2 mt-2">
            {(['card_show', 'tcg_tournament', 'convention', 'collector_event'] as EventType[]).map(t => (
              <EventTypeBadge key={t} type={t} />
            ))}
          </div>
        </div>
      )}

      {/* Empty results */}
      {hasResults && total === 0 && !searching && geo && (
        <div className="rounded-2xl border border-white/8 bg-white/[0.015] px-6 py-12 flex flex-col items-center gap-4 text-center">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)' }}
          >
            <Calendar className="h-7 w-7 text-amber-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white/70">No events found near {geo.city}</p>
            <p className="text-xs text-white/30 mt-1 max-w-sm">
              Try increasing the radius or date range, or click{' '}
              <span className="text-white/50 font-medium">Refresh</span>{' '}
              to pull the latest events from all sources.
            </p>
          </div>

          {/* API key hint */}
          <div className="mt-2 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 text-left max-w-md w-full space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-white/30">
              No API keys configured?
            </p>
            <p className="text-xs text-white/40 leading-relaxed">
              Add these to <code className="text-cyan-400/70 bg-white/5 px-1 rounded">.env.local</code> to enable live event ingestion:
            </p>
            <div className="space-y-1 font-mono text-[11px]">
              <div className="text-emerald-400/70">TICKETMASTER_API_KEY=…</div>
              <div className="text-violet-400/70">SEATGEEK_CLIENT_ID=…</div>
              <div className="text-amber-400/70">ADMIN_SECRET=…  <span className="text-white/20 font-sans"># for the Refresh button</span></div>
            </div>
          </div>

          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-cyan-400 bg-cyan-400/8 border border-cyan-400/20 hover:bg-cyan-400/12 transition-all disabled:opacity-40"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing from sources…' : 'Refresh from sources'}
          </button>
        </div>
      )}

      {/* Event grid */}
      {hasResults && total! > 0 && !searching && (
        <div className="space-y-4">
          {/* Type breakdown summary */}
          <div className="flex flex-wrap gap-2 items-center">
            {(Object.keys(EVENT_TYPE_META) as string[]).map(type => {
              const count = events.filter(e => e.event_type === type).length
              if (count === 0) return null
              const meta = EVENT_TYPE_META[type]
              return (
                <button
                  key={type}
                  onClick={() => handleTypeChange(eventType === type ? 'all' : type)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-all hover:opacity-80"
                  style={{
                    color:      meta.color,
                    background: eventType === type ? meta.bg : `${meta.color}08`,
                    border:     `1px solid ${eventType === type ? meta.border : `${meta.color}18`}`,
                  }}
                >
                  <span className="font-bold">{count}</span>
                  <span className="opacity-80">{meta.label}</span>
                </button>
              )
            })}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {events.map(event => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
