import { classifyEvent } from '../classify'
import type { NormalizedEvent } from '../types'

const SG_BASE = 'https://api.seatgeek.com/2'

const QUERIES = ['card show', 'pokemon card', 'trading card', 'sports card expo', 'collectibles']

interface SgVenue {
  name?:     string
  address?:  string
  city?:     string
  state?:    string
  country?:  string
  location?: { lat?: number; lon?: number }
}

interface SgEvent {
  id:              number
  title:           string
  url?:            string
  datetime_utc?:   string
  datetime_local?: string
  type?:           string
  description?:    string
  performers?:     Array<{ name?: string; image?: string }>
  venue?:          SgVenue
}

async function fetchQuery(clientId: string, q: string): Promise<SgEvent[]> {
  const params = new URLSearchParams({ client_id: clientId, q, per_page: '50', sort: 'datetime_utc.asc' })
  const res = await fetch(`${SG_BASE}/events?${params}`, { next: { revalidate: 3600 } })
  if (!res.ok) return []
  const json = await res.json()
  return json?.events ?? []
}

export async function ingestSeatGeek(): Promise<NormalizedEvent[]> {
  const clientId = process.env.SEATGEEK_CLIENT_ID
  if (!clientId) return []

  const seen = new Set<string>()
  const events: NormalizedEvent[] = []
  const now = new Date().toISOString()

  for (const q of QUERIES) {
    try {
      const raw = await fetchQuery(clientId, q)
      for (const e of raw) {
        const key = String(e.id)
        if (seen.has(key)) continue
        seen.add(key)
        const startAt = e.datetime_utc ?? e.datetime_local
        if (!startAt || startAt < now) continue

        const venue      = e.venue
        const classified = classifyEvent(e.title, e.description, e.type)
        const image      = e.performers?.[0]?.image

        events.push({
          source:      'seatgeek',
          external_id: key,
          title:       e.title,
          description: e.description,
          start_at:    startAt,
          venue_name:  venue?.name,
          address:     venue?.address,
          city:        venue?.city,
          state:       venue?.state,
          country:     venue?.country ?? 'US',
          lat:         venue?.location?.lat,
          lng:         venue?.location?.lon,
          url:         e.url,
          image_url:   image,
          category:    e.type,
          ...classified,
        })
      }
    } catch (err) {
      console.error('[seatgeek] query fetch error:', err)
    }
  }
  return events
}
