import { classifyEvent } from '../classify'
import type { NormalizedEvent } from '../types'

const TM_BASE = 'https://app.ticketmaster.com/discovery/v2'

// Broad collector-relevant keywords — cast wide net since card shows are sparse on TM
const GEO_KEYWORDS = [
  'card show',
  'trading card',
  'pokemon',
  'sports card',
  'collectibles',
  'comic con',
  'anime',
  'tcg',
  'hobby expo',
  'card expo',
  'yugioh',
  'magic gathering',
]

interface TmVenue {
  name?:     string
  address?:  { line1?: string }
  city?:     { name?: string }
  state?:    { stateCode?: string }
  location?: { latitude?: string; longitude?: string }
}

interface TmEvent {
  id:      string
  name:    string
  url?:    string
  info?:   string
  images?: Array<{ url: string; width: number }>
  dates?: {
    start?: { dateTime?: string; localDate?: string; localTime?: string }
    end?:   { dateTime?: string; localDate?: string }
  }
  classifications?: Array<{ genre?: { name?: string }; subGenre?: { name?: string } }>
  _embedded?: { venues?: TmVenue[] }
}

async function fetchGeo(
  apiKey: string,
  lat: number,
  lng: number,
  radiusMiles: number,
  keyword: string,
): Promise<TmEvent[]> {
  const params = new URLSearchParams({
    apikey:        apiKey,
    latlong:       `${lat},${lng}`,
    radius:        String(Math.min(radiusMiles, 300)),
    unit:          'miles',
    keyword,
    startDateTime: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    size:          '50',
    sort:          'date,asc',
    countryCode:   'US',
  })
  const res = await fetch(`${TM_BASE}/events.json?${params}`, { cache: 'no-store' })
  if (!res.ok) return []
  const json = await res.json()
  return json?._embedded?.events ?? []
}

function normalizeEvent(e: TmEvent): NormalizedEvent | null {
  const venue   = e._embedded?.venues?.[0]
  const lat     = venue?.location?.latitude  ? parseFloat(venue.location.latitude)  : undefined
  const lng     = venue?.location?.longitude ? parseFloat(venue.location.longitude) : undefined
  const startAt = e.dates?.start?.dateTime
    ?? (e.dates?.start?.localDate
      ? `${e.dates.start.localDate}T${e.dates.start.localTime ?? '09:00:00'}`
      : null)
  if (!startAt) return null

  const category = [
    e.classifications?.[0]?.genre?.name,
    e.classifications?.[0]?.subGenre?.name,
  ].filter(Boolean).join(' / ')

  const classified = classifyEvent(e.name, e.info, category)
  const bestImage  = e.images?.sort((a, b) => b.width - a.width)[0]?.url

  return {
    source:      'ticketmaster',
    external_id: e.id,
    title:       e.name,
    description: e.info,
    start_at:    startAt,
    end_at:      e.dates?.end?.dateTime ?? (e.dates?.end?.localDate ? `${e.dates.end.localDate}T23:59:00` : undefined),
    venue_name:  venue?.name,
    address:     venue?.address?.line1,
    city:        venue?.city?.name,
    state:       venue?.state?.stateCode,
    country:     'US',
    lat,
    lng,
    url:         e.url,
    image_url:   bestImage,
    category,
    ...classified,
  }
}

/**
 * Geo-targeted fetch: search for collector-relevant events near a specific location.
 * Called on-demand from the search route when no cached data exists for an area.
 */
export async function fetchTicketmasterNear(
  lat: number,
  lng: number,
  radiusMiles: number,
): Promise<NormalizedEvent[]> {
  const apiKey = process.env.TICKETMASTER_API_KEY
  if (!apiKey) return []

  const seen   = new Set<string>()
  const events: NormalizedEvent[] = []

  // Run keyword fetches in small batches to avoid rate limits
  const batches = [GEO_KEYWORDS.slice(0, 4), GEO_KEYWORDS.slice(4, 8), GEO_KEYWORDS.slice(8)]
  for (const batch of batches) {
    const results = await Promise.allSettled(
      batch.map(kw => fetchGeo(apiKey, lat, lng, radiusMiles, kw))
    )
    for (const r of results) {
      if (r.status !== 'fulfilled') continue
      for (const e of r.value) {
        if (seen.has(e.id)) continue
        seen.add(e.id)
        const normalized = normalizeEvent(e)
        if (normalized) events.push(normalized)
      }
    }
    await new Promise(res => setTimeout(res, 250))
  }

  return events
}

/**
 * National keyword sweep — used for initial DB population / cron jobs.
 */
export async function ingestTicketmaster(): Promise<NormalizedEvent[]> {
  const apiKey = process.env.TICKETMASTER_API_KEY
  if (!apiKey) return []

  const params = new URLSearchParams({
    apikey:        apiKey,
    keyword:       'card show trading card pokemon sports card',
    startDateTime: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    size:          '200',
    sort:          'date,asc',
    countryCode:   'US',
  })
  const res = await fetch(`${TM_BASE}/events.json?${params}`, { cache: 'no-store' })
  if (!res.ok) return []
  const json  = await res.json()
  const raw   = json?._embedded?.events ?? []
  return raw.map(normalizeEvent).filter(Boolean) as NormalizedEvent[]
}
