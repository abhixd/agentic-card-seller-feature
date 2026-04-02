'use client'

import { useState, useCallback } from 'react'
import {
  MapPin, Search, Loader2, Calendar, ExternalLink,
  Navigation, Info, RefreshCw, X,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CardShow {
  id:          string
  name:        string
  date:        string        // ISO or human-readable
  venue:       string
  city:        string
  state:       string
  distance?:   number       // miles
  url?:        string
  description?: string
  source:      string
}

// ── Search via a free geocode + event search ──────────────────────────────────
// We use the Nominatim geocode API (free, no key) to convert zipcode → lat/lng
// then search for card shows via Google Maps embed (no key needed for static embed)
// and also link to popular community resources.

async function geocodeZip(zip: string): Promise<{ lat: number; lon: number; city: string; state: string } | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(zip)}&countrycodes=us&format=json&limit=1`,
      { headers: { 'Accept-Language': 'en', 'User-Agent': 'CardSellerOS/1.0' } }
    )
    const data = await res.json()
    if (!data?.[0]) return null
    const d = data[0]
    const parts = (d.display_name as string).split(', ')
    return {
      lat:   parseFloat(d.lat),
      lon:   parseFloat(d.lon),
      city:  parts[0] ?? '',
      state: parts[1] ?? '',
    }
  } catch {
    return null
  }
}

// ── Static community resources ────────────────────────────────────────────────

const COMMUNITY_RESOURCES = [
  {
    name:    'Card Show Locator',
    url:     'https://www.cardshowlocator.com/',
    desc:    'Comprehensive US card show database — filter by date and state',
    icon:    '📍',
  },
  {
    name:    'Beckett Card Shows',
    url:     'https://www.beckett.com/news/category/card-shows/',
    desc:    'Beckett\'s upcoming show listings and event coverage',
    icon:    '📅',
  },
  {
    name:    'PSA Show Schedule',
    url:     'https://www.psacard.com/grading/eventschedule',
    desc:    'Find shows where PSA is on-site for same-day submissions',
    icon:    '🏆',
  },
  {
    name:    'TCGPlayer Events',
    url:     'https://www.tcgplayer.com/event',
    desc:    'Local game store events, tournaments, and trade nights',
    icon:    '🎮',
  },
  {
    name:    'Eventbrite · Card Shows',
    url:     'https://www.eventbrite.com/d/online/card-show/',
    desc:    'Trading card shows and conventions on Eventbrite',
    icon:    '🎫',
  },
]

// ── Radius options ────────────────────────────────────────────────────────────

const RADIUS_OPTIONS = [25, 50, 100, 200]

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CardShowsPage() {
  const [zip,       setZip]       = useState('')
  const [radius,    setRadius]    = useState(50)
  const [location,  setLocation]  = useState<{ lat: number; lon: number; city: string; state: string } | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [searched,  setSearched]  = useState(false)

  const handleSearch = useCallback(async () => {
    if (zip.trim().length < 5) { setError('Enter a valid 5-digit zip code'); return }
    setLoading(true)
    setError(null)
    setSearched(false)

    const geo = await geocodeZip(zip.trim())
    if (!geo) {
      setError('Could not find that zip code. Try a different one.')
      setLoading(false)
      return
    }
    setLocation(geo)
    setLoading(false)
    setSearched(true)
  }, [zip])

  const mapsQuery = location
    ? `trading+card+show+convention+near+${encodeURIComponent(location.city + ' ' + location.state)}`
    : ''

  const eventbriteUrl = location
    ? `https://www.eventbrite.com/d/${encodeURIComponent(location.city.toLowerCase() + '--' + location.state.toLowerCase())}/trading-card-show/?radius=${radius}`
    : 'https://www.eventbrite.com/d/online/trading-card-show/'

  const googleMapsUrl = location
    ? `https://www.google.com/maps/search/trading+card+show+${encodeURIComponent(location.city + '+' + location.state)}`
    : ''

  const cardShowLocatorUrl = location
    ? `https://www.cardshowlocator.com/#search`
    : 'https://www.cardshowlocator.com/'

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <MapPin className="h-5 w-5 text-rose-400" />
          Card Show Finder
        </h1>
        <p className="text-xs text-muted-foreground/50 mt-1">
          Find trading card conventions and shows near you — compare prices, buy raw cards, get PSA subs
        </p>
      </div>

      {/* ── Search bar ──────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-5 space-y-4">
        <div className="flex flex-col sm:flex-row gap-3">
          {/* ZIP input */}
          <div className="flex-1 relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/30" />
            <input
              type="text"
              value={zip}
              onChange={e => { setZip(e.target.value); setError(null) }}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="Enter your zip code (e.g. 90210)"
              maxLength={10}
              className="w-full rounded-xl border border-white/10 bg-white/[0.03] pl-9 pr-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:border-rose-400/30 focus:bg-rose-400/[0.03] transition-all"
            />
            {zip && (
              <button onClick={() => { setZip(''); setError(null); setSearched(false) }}
                className="absolute right-3 top-1/2 -translate-y-1/2">
                <X className="h-3.5 w-3.5 text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors" />
              </button>
            )}
          </div>

          {/* Radius */}
          <div className="flex items-center gap-1 bg-white/[0.04] rounded-xl p-1 border border-white/8">
            {RADIUS_OPTIONS.map(r => (
              <button key={r} onClick={() => setRadius(r)}
                className={[
                  'px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
                  radius === r ? 'bg-white/10 text-white/90' : 'text-white/30 hover:text-white/60',
                ].join(' ')}>
                {r}mi
              </button>
            ))}
          </div>

          <button
            onClick={handleSearch}
            disabled={loading}
            className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50 transition-all"
            style={{ background: 'linear-gradient(135deg, #f43f5e, #e11d48)' }}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Find Shows
          </button>
        </div>

        {error && (
          <p className="text-xs text-red-400 flex items-center gap-1.5">
            <Info className="h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>

      {/* ── Results area ────────────────────────────────────────────────────── */}
      {searched && location && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Navigation className="h-4 w-4 text-rose-400 shrink-0" />
            <p className="text-sm font-medium">
              Showing results near <span className="text-white">{location.city}, {location.state}</span>
              <span className="text-muted-foreground/40 ml-2">within {radius} miles</span>
            </p>
          </div>

          {/* Direct search links */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              {
                label: 'Search Card Show Locator',
                sub:   'Best dedicated database for US card shows',
                url:   cardShowLocatorUrl,
                icon:  '📍',
                highlight: true,
              },
              {
                label: 'Search Eventbrite Near You',
                sub:   `Events within ${radius}mi of ${location.city}`,
                url:   eventbriteUrl,
                icon:  '🎫',
                highlight: false,
              },
              {
                label: 'Google Maps — Card Shows',
                sub:   `"Trading card show" near ${location.city}`,
                url:   googleMapsUrl,
                icon:  '🗺️',
                highlight: false,
              },
              {
                label: 'PSA On-Site Events',
                sub:   'Shows with same-day PSA grading submissions',
                url:   'https://www.psacard.com/grading/eventschedule',
                icon:  '🏆',
                highlight: false,
              },
            ].map(({ label, sub, url, icon, highlight }) => (
              <a
                key={label}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className={[
                  'flex items-start gap-3 rounded-xl border p-4 hover:-translate-y-0.5 transition-all group',
                  highlight
                    ? 'border-rose-400/20 bg-rose-400/[0.04]'
                    : 'border-white/8 bg-white/[0.025]',
                ].join(' ')}
              >
                <span className="text-xl shrink-0">{icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground group-hover:text-white transition-colors">{label}</p>
                  <p className="text-xs text-muted-foreground/50 mt-0.5 leading-tight">{sub}</p>
                </div>
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/20 group-hover:text-muted-foreground/50 transition-colors shrink-0 mt-0.5" />
              </a>
            ))}
          </div>

          {/* Embedded map */}
          <div className="rounded-xl overflow-hidden border border-white/8">
            <div className="px-4 py-2.5 border-b border-white/5 flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground/40 font-semibold">Google Maps Preview</span>
            </div>
            <iframe
              width="100%"
              height="340"
              style={{ border: 0 }}
              loading="lazy"
              allowFullScreen
              referrerPolicy="no-referrer-when-downgrade"
              src={`https://maps.google.com/maps?q=${mapsQuery}&output=embed&z=9`}
              className="block"
            />
          </div>

          {/* Pro tips */}
          <div className="rounded-xl border border-white/8 bg-white/[0.02] p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/40">Show Day Tips</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {[
                { tip: 'Check prices on this app before buying — see live TCGPlayer comps instantly', icon: '💰' },
                { tip: 'Bring a list of cards you\'re targeting with your max price from the Market Index', icon: '📋' },
                { tip: 'PSA on-site events = fastest path to graded value — submit raw NM cards', icon: '🏆' },
                { tip: 'Use the Trade Analyzer to evaluate on-the-spot trade offers', icon: '⚖️' },
                { tip: 'Arrive early — the best raw singles go in the first hour', icon: '⏰' },
                { tip: 'Bring cash — many dealers don\'t accept cards or charge a fee', icon: '💵' },
              ].map(({ tip, icon }) => (
                <div key={tip} className="flex items-start gap-2.5">
                  <span className="text-base shrink-0">{icon}</span>
                  <p className="text-xs text-muted-foreground/50 leading-relaxed">{tip}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Community resources (always visible) ────────────────────────────── */}
      <div className="space-y-3">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/40 font-semibold">
          Community Resources
        </p>
        <div className="space-y-2">
          {COMMUNITY_RESOURCES.map(({ name, url, desc, icon }) => (
            <a
              key={name}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 hover:bg-white/[0.04] hover:border-white/15 transition-all group"
            >
              <span className="text-lg shrink-0">{icon}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground/80 group-hover:text-foreground transition-colors">{name}</p>
                <p className="text-[10px] text-muted-foreground/40 truncate">{desc}</p>
              </div>
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/15 group-hover:text-muted-foreground/45 transition-colors shrink-0" />
            </a>
          ))}
        </div>
      </div>

      {/* ── Note ────────────────────────────────────────────────────────────── */}
      <p className="text-[10px] text-muted-foreground/20 text-center leading-relaxed">
        Card Show Finder uses free geocoding via OpenStreetMap Nominatim to locate your area,
        then links directly to dedicated card show databases and event platforms.
        No personal data is stored.
      </p>
    </div>
  )
}
