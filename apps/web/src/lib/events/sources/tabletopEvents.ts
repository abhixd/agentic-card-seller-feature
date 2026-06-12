import { classifyEvent } from '../classify'
import type { NormalizedEvent } from '../types'

const TTE_BASE = 'https://tabletop.events/api'

// Game slugs relevant to our collector audience
const GAME_SLUGS = ['pokemon-trading-card-game', 'magic-the-gathering', 'yugioh']

// Actual API response shape (fields confirmed from live response)
interface TteConvention {
  id:           string
  name:         string
  start_date?:  string    // "2026-10-09 18:00:00"
  end_date?:    string
  cancelled?:   number    // 0 or 1
  is_online?:   number
  view_uri?:    string    // "/conventions/arnecon-4"
  uri_part?:    string
  geolocation_id?: string | null
  venue_id?:    string | null
}

async function fetchGame(slug: string): Promise<TteConvention[]> {
  const params = new URLSearchParams({ game: slug, per_page: '100' })
  const res = await fetch(`${TTE_BASE}/convention?${params}`, {
    headers: { Accept: 'application/json' },
    next: { revalidate: 3600 },
  })
  if (!res.ok) return []
  const json = await res.json()
  return json?.result?.items ?? []
}

export async function ingestTabletopEvents(): Promise<NormalizedEvent[]> {
  const now  = new Date()
  const seen = new Set<string>()
  const events: NormalizedEvent[] = []

  for (const slug of GAME_SLUGS) {
    try {
      const raw = await fetchGame(slug)
      for (const c of raw) {
        if (seen.has(c.id)) continue
        seen.add(c.id)
        if (!c.start_date) continue
        if (c.cancelled === 1) continue
        if (c.is_online === 1) continue

        // Parse "YYYY-MM-DD HH:MM:SS" → Date
        const startDate = new Date(c.start_date.replace(' ', 'T'))
        if (startDate < now) continue

        const classified = classifyEvent(c.name, undefined, slug)
        const url = c.view_uri
          ? `https://tabletop.events${c.view_uri}`
          : c.uri_part
            ? `https://tabletop.events/conventions/${c.uri_part}`
            : undefined

        // Note: TTE API doesn't expose lat/lng in convention list —
        // events without location won't appear in radius searches
        // but ARE stored and shown in the "All Events" tab.
        events.push({
          source:      'tabletop_events',
          external_id: String(c.id),
          title:       c.name,
          start_at:    startDate.toISOString(),
          end_at:      c.end_date
            ? new Date(c.end_date.replace(' ', 'T')).toISOString()
            : undefined,
          country:     'US',
          url,
          category:    slug,
          ...classified,
        })
      }
    } catch (err) {
      console.error('[tabletop.events] slug fetch error:', err)
    }
  }
  return events
}
