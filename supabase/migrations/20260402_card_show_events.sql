CREATE TABLE IF NOT EXISTS card_show_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text        NOT NULL,           -- 'ticketmaster' | 'tabletop_events' | 'seatgeek'
  external_id     text        NOT NULL,
  title           text        NOT NULL,
  description     text,
  start_at        timestamptz NOT NULL,
  end_at          timestamptz,
  venue_name      text,
  address         text,
  city            text,
  state           text,
  country         text        DEFAULT 'US',
  lat             double precision,
  lng             double precision,
  url             text,
  image_url       text,
  event_type      text        NOT NULL DEFAULT 'general',
  category        text,
  source_confidence text      DEFAULT 'medium',
  tags            text[]      DEFAULT '{}',
  fetched_at      timestamptz DEFAULT now(),
  created_at      timestamptz DEFAULT now(),
  UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS cse_start_at_idx   ON card_show_events (start_at);
CREATE INDEX IF NOT EXISTS cse_lat_lng_idx    ON card_show_events (lat, lng);
CREATE INDEX IF NOT EXISTS cse_event_type_idx ON card_show_events (event_type);
CREATE INDEX IF NOT EXISTS cse_source_idx     ON card_show_events (source);
CREATE INDEX IF NOT EXISTS cse_fetched_at_idx ON card_show_events (fetched_at);
-- Composite index for the geo + recency hotpath used by the search route
CREATE INDEX IF NOT EXISTS cse_geo_fetched_idx ON card_show_events (lat, lng, fetched_at);
