export type EventSource     = 'ticketmaster' | 'tabletop_events' | 'seatgeek' | 'manual'
export type EventType       = 'card_show' | 'convention' | 'tcg_tournament' | 'collector_event' | 'general'
export type EventConfidence = 'high' | 'medium' | 'low'

export interface NormalizedEvent {
  source:            EventSource
  external_id:       string
  title:             string
  description?:      string
  start_at:          string   // ISO string
  end_at?:           string
  venue_name?:       string
  address?:          string
  city?:             string
  state?:            string
  country?:          string
  lat?:              number
  lng?:              number
  url?:              string
  image_url?:        string
  event_type:        EventType
  category?:         string
  source_confidence: EventConfidence
  tags:              string[]
}

// DB row (includes id + timestamps)
export interface CardShowEvent extends NormalizedEvent {
  id:         string
  fetched_at: string
  created_at: string
  distance?:  number   // miles, added client-side
}
