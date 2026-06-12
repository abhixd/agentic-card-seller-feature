import { createServiceClient }   from '@/lib/supabase/server'
import { ingestTicketmaster }    from './sources/ticketmaster'
import { ingestTabletopEvents }  from './sources/tabletopEvents'
import { ingestSeatGeek }        from './sources/seatgeek'
import type { NormalizedEvent }  from './types'

export async function runIngestion(): Promise<{ inserted: number; errors: string[] }> {
  const errors: string[] = []

  // Gather from all sources in parallel
  const [tmEvents, tteEvents, sgEvents] = await Promise.allSettled([
    ingestTicketmaster(),
    ingestTabletopEvents(),
    ingestSeatGeek(),
  ])

  const allEvents: NormalizedEvent[] = [
    ...(tmEvents.status  === 'fulfilled' ? tmEvents.value  : (errors.push('ticketmaster'),   [])),
    ...(tteEvents.status === 'fulfilled' ? tteEvents.value : (errors.push('tabletop_events'), [])),
    ...(sgEvents.status  === 'fulfilled' ? sgEvents.value  : (errors.push('seatgeek'),        [])),
  ]

  if (allEvents.length === 0) return { inserted: 0, errors }

  // Filter: only future events
  const now = new Date().toISOString()
  const future = allEvents.filter(e => e.start_at > now)

  // Upsert to Supabase
  try {
    const svc = createServiceClient()
    const { error } = await svc
      .from('card_show_events')
      .upsert(
        future.map(e => ({ ...e, fetched_at: new Date().toISOString() })),
        { onConflict: 'source,external_id', ignoreDuplicates: false }
      )
    if (error) errors.push(`db: ${error.message}`)
  } catch (err) {
    errors.push(`db: ${err instanceof Error ? err.message : String(err)}`)
  }

  return { inserted: future.length, errors }
}
