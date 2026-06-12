import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchTicketmasterNear } from '@/lib/events/sources/ticketmaster'
import { ingestTabletopEvents } from '@/lib/events/sources/tabletopEvents'
import type { NormalizedEvent } from '@/lib/events/types'

export const runtime = 'nodejs'
export const maxDuration = 45

// Haversine distance in miles
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R    = 3958.8
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a    = Math.sin(dLat / 2) ** 2 +
               Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
               Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Bounding box for quick DB pre-filter
function boundingBox(lat: number, lng: number, radiusMiles: number) {
  const latDeg = radiusMiles / 69.0
  const lngDeg = radiusMiles / (69.0 * Math.cos(lat * Math.PI / 180))
  return { minLat: lat - latDeg, maxLat: lat + latDeg, minLng: lng - lngDeg, maxLng: lng + lngDeg }
}

// Upsert a batch of normalized events into card_show_events
async function upsertEvents(svc: ReturnType<typeof createServiceClient>, events: NormalizedEvent[]) {
  if (events.length === 0) return
  const rows = events.map(e => ({
    source:            e.source,
    external_id:       e.external_id,
    title:             e.title,
    description:       e.description ?? null,
    start_at:          e.start_at,
    end_at:            e.end_at ?? null,
    venue_name:        e.venue_name ?? null,
    address:           e.address ?? null,
    city:              e.city ?? null,
    state:             e.state ?? null,
    country:           e.country ?? 'US',
    lat:               e.lat ?? null,
    lng:               e.lng ?? null,
    url:               e.url ?? null,
    image_url:         e.image_url ?? null,
    category:          e.category ?? null,
    event_type:        e.event_type,
    source_confidence: e.source_confidence,
    tags:              e.tags ?? [],
    fetched_at:        new Date().toISOString(),
  }))
  await svc
    .from('card_show_events')
    .upsert(rows, { onConflict: 'source,external_id', ignoreDuplicates: false })
}

export async function GET(req: NextRequest) {
  const sp        = new URL(req.url).searchParams
  const lat       = parseFloat(sp.get('lat')    ?? '')
  const lng       = parseFloat(sp.get('lng')    ?? '')
  const radius    = Math.min(parseFloat(sp.get('radius') ?? '50'), 300)
  const eventType = sp.get('type')      ?? ''
  const startDate = sp.get('startDate') ?? new Date().toISOString()
  const endDate   = sp.get('endDate')   ?? new Date(Date.now() + 90 * 86_400_000).toISOString()
  const keyword   = sp.get('q')?.toLowerCase() ?? ''

  if (isNaN(lat) || isNaN(lng)) {
    return NextResponse.json({ error: 'lat and lng are required' }, { status: 400 })
  }

  const svc = createServiceClient()
  const box = boundingBox(lat, lng, radius)

  // ── Check if we have any recently fetched data for this area ─────────────
  // "recently" = fetched within the last 6 hours
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
  const { count: recentCount } = await svc
    .from('card_show_events')
    .select('id', { count: 'exact', head: true })
    .gte('lat', box.minLat)
    .lte('lat', box.maxLat)
    .gte('lng', box.minLng)
    .lte('lng', box.maxLng)
    .gte('fetched_at', sixHoursAgo)

  let freshFetch = false

  // ── On-demand geo fetch if cache is cold ─────────────────────────────────
  if ((recentCount ?? 0) === 0) {
    freshFetch = true
    try {
      // Geo-targeted Ticketmaster fetch (12 collector keywords, batched)
      const tmEvents = await fetchTicketmasterNear(lat, lng, radius)
      await upsertEvents(svc, tmEvents)
    } catch (err) {
      console.error('[shows/search] Ticketmaster geo fetch failed:', err)
    }

    try {
      // Tabletop.Events national sweep (no geo API — filter by lat/lng after)
      const tteEvents = await ingestTabletopEvents()
      // Only upsert events that have lat/lng within range (TTE usually has none)
      const nearby = tteEvents.filter(e =>
        e.lat != null && e.lng != null &&
        haversine(lat, lng, e.lat!, e.lng!) <= radius
      )
      await upsertEvents(svc, nearby)
      // Also upsert all TTE events without geo so they appear in "All Events"
      const noGeo = tteEvents.filter(e => e.lat == null || e.lng == null)
      await upsertEvents(svc, noGeo)
    } catch (err) {
      console.error('[shows/search] TabletopEvents fetch failed:', err)
    }
  }

  // ── Query DB (now populated if fresh fetch ran) ───────────────────────────
  let query = svc
    .from('card_show_events')
    .select('*')
    .gte('lat', box.minLat)
    .lte('lat', box.maxLat)
    .gte('lng', box.minLng)
    .lte('lng', box.maxLng)
    .gte('start_at', startDate)
    .lte('start_at', endDate)
    .order('start_at', { ascending: true })
    .limit(200)

  if (eventType && eventType !== 'all') {
    query = query.eq('event_type', eventType)
  }

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Precise distance filter + sort
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let events = (data ?? []).map((e: any) => ({
    ...e,
    distance: e.lat && e.lng ? Math.round(haversine(lat, lng, e.lat, e.lng) * 10) / 10 : null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })).filter((e: any) => e.distance === null || e.distance <= radius)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .sort((a: any, b: any) => {
      if (a.distance !== null && b.distance !== null) return a.distance - b.distance
      return new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
    })

  // Keyword filter
  if (keyword) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events = events.filter((e: any) =>
      e.title?.toLowerCase().includes(keyword) ||
      e.description?.toLowerCase().includes(keyword) ||
      e.venue_name?.toLowerCase().includes(keyword) ||
      e.city?.toLowerCase().includes(keyword)
    )
  }

  return NextResponse.json({ events, total: events.length, freshFetch })
}
