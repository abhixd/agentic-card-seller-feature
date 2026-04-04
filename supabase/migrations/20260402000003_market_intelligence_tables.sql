-- =============================================================================
-- Market Intelligence Tables — Tier 1 & 2 metrics
-- Rollback: run 20260402000001_rollback.sql to drop all tables created here.
-- =============================================================================

-- ── 1. eBay Sold History ──────────────────────────────────────────────────────
-- Permanent store of eBay sold listings. eBay removes them after 90 days;
-- we keep them forever. Gives us the only multi-year sold velocity database.
CREATE TABLE IF NOT EXISTS public.ebay_sold_history (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  catalog_id      uuid REFERENCES public.card_catalog_items(catalog_id) ON DELETE SET NULL,
  card_name       text NOT NULL,
  set_name        text,
  ebay_item_id    text NOT NULL UNIQUE,          -- dedup: same listing never stored twice
  sold_price      numeric(10,2) NOT NULL,
  currency        text NOT NULL DEFAULT 'USD',
  condition       text,                           -- eBay condition string
  title           text NOT NULL,
  listing_url     text,
  sold_at         timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ebay_sold_catalog   ON public.ebay_sold_history(catalog_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_ebay_sold_card_name ON public.ebay_sold_history(lower(card_name), sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_ebay_sold_at        ON public.ebay_sold_history(sold_at DESC);

ALTER TABLE public.ebay_sold_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read ebay_sold_history"
  ON public.ebay_sold_history FOR SELECT USING (true);
CREATE POLICY "service role manage ebay_sold_history"
  ON public.ebay_sold_history FOR ALL USING (auth.role() = 'service_role');

-- ── 2. PSA Population Snapshots ──────────────────────────────────────────────
-- Weekly PSA pop report snapshots per card.
-- PSA 10 supply growth rate is the strongest graded card price predictor.
CREATE TABLE IF NOT EXISTS public.psa_pop_snapshots (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  catalog_id      uuid REFERENCES public.card_catalog_items(catalog_id) ON DELETE CASCADE,
  card_name       text NOT NULL,
  set_name        text,
  card_number     text,
  psa_10          int NOT NULL DEFAULT 0,
  psa_9           int NOT NULL DEFAULT 0,
  psa_8           int NOT NULL DEFAULT 0,
  psa_7           int NOT NULL DEFAULT 0,
  psa_auth        int NOT NULL DEFAULT 0,        -- authentic (no grade)
  total_graded    int NOT NULL DEFAULT 0,
  snapshot_date   date NOT NULL DEFAULT CURRENT_DATE,
  source          text NOT NULL DEFAULT 'psacard.com',
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_psa_pop_card_date
  ON public.psa_pop_snapshots(catalog_id, snapshot_date)
  WHERE catalog_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_psa_pop_date ON public.psa_pop_snapshots(snapshot_date DESC);

ALTER TABLE public.psa_pop_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read psa_pop_snapshots"
  ON public.psa_pop_snapshots FOR SELECT USING (true);
CREATE POLICY "service role manage psa_pop_snapshots"
  ON public.psa_pop_snapshots FOR ALL USING (auth.role() = 'service_role');

-- ── 3. PriceCharting Set ARR ──────────────────────────────────────────────────
-- Annual rate of return per set, computed from PriceCharting historical prices.
CREATE TABLE IF NOT EXISTS public.set_investment_metrics (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  set_name        text NOT NULL UNIQUE,
  pricecharting_id text,                         -- PriceCharting internal set ID
  cagr_1yr        numeric(6,2),                  -- 1-year CAGR %
  cagr_3yr        numeric(6,2),                  -- 3-year CAGR %
  cagr_5yr        numeric(6,2),                  -- 5-year CAGR %
  index_price_now numeric(10,2),                 -- avg price of top-10 cards today
  index_price_1yr numeric(10,2),
  index_price_3yr numeric(10,2),
  index_price_5yr numeric(10,2),
  investment_grade text CHECK (investment_grade IN ('A+','A','B+','B','C','D','F')),
  reprint_risk    text CHECK (reprint_risk IN ('low','medium','high','very_high')),
  top_cards       jsonb DEFAULT '[]',            -- [{name, current_price, cagr_1yr}]
  notes           text,
  last_updated    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_set_investment_grade ON public.set_investment_metrics(investment_grade);

ALTER TABLE public.set_investment_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read set_investment_metrics"
  ON public.set_investment_metrics FOR SELECT USING (true);
CREATE POLICY "service role manage set_investment_metrics"
  ON public.set_investment_metrics FOR ALL USING (auth.role() = 'service_role');

-- ── 4. PriceCharting Card Price History ───────────────────────────────────────
-- Long-term card price history from PriceCharting (goes back to 2010+).
CREATE TABLE IF NOT EXISTS public.pricecharting_history (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  catalog_id      uuid REFERENCES public.card_catalog_items(catalog_id) ON DELETE CASCADE,
  card_name       text NOT NULL,
  set_name        text,
  pricecharting_id text,
  price_date      date NOT NULL,
  loose_price     numeric(10,2),                 -- ungraded NM price
  graded_price    numeric(10,2),                 -- graded (PSA 9 equiv)
  complete_price  numeric(10,2),
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pricecharting_card_date
  ON public.pricecharting_history(catalog_id, price_date)
  WHERE catalog_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pricecharting_date ON public.pricecharting_history(price_date DESC);

ALTER TABLE public.pricecharting_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read pricecharting_history"
  ON public.pricecharting_history FOR SELECT USING (true);
CREATE POLICY "service role manage pricecharting_history"
  ON public.pricecharting_history FOR ALL USING (auth.role() = 'service_role');

-- ── 5. Tournament Appearances ─────────────────────────────────────────────────
-- Which cards appear in top-8 tournament decks. Leading indicator of price spikes.
CREATE TABLE IF NOT EXISTS public.tournament_appearances (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  catalog_id      uuid REFERENCES public.card_catalog_items(catalog_id) ON DELETE SET NULL,
  card_name       text NOT NULL,
  set_name        text,
  card_number     text,
  tournament_id   text NOT NULL,
  tournament_name text NOT NULL,
  tournament_date date NOT NULL,
  placement       int,                           -- 1-8 for top 8
  deck_count      int NOT NULL DEFAULT 1,        -- copies in the deck
  format          text,                          -- e.g. "Standard", "Expanded"
  player_name     text,
  source          text NOT NULL DEFAULT 'limitlesstcg.com',
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tournament_card
  ON public.tournament_appearances(tournament_id, card_name, coalesce(set_name,''), placement);
CREATE INDEX IF NOT EXISTS idx_tournament_date      ON public.tournament_appearances(tournament_date DESC);
CREATE INDEX IF NOT EXISTS idx_tournament_catalog   ON public.tournament_appearances(catalog_id, tournament_date DESC);
CREATE INDEX IF NOT EXISTS idx_tournament_card_name ON public.tournament_appearances(lower(card_name));

ALTER TABLE public.tournament_appearances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read tournament_appearances"
  ON public.tournament_appearances FOR SELECT USING (true);
CREATE POLICY "service role manage tournament_appearances"
  ON public.tournament_appearances FOR ALL USING (auth.role() = 'service_role');

-- ── 6. Set Enrichment ─────────────────────────────────────────────────────────
-- Manual + scraped metadata: reprint history, print run era, collector notes.
CREATE TABLE IF NOT EXISTS public.set_enrichment (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  set_name        text NOT NULL UNIQUE,
  release_year    int,
  print_era       text CHECK (print_era IN ('wotc','early_ex','dp_era','bw_era','xy_era','sm_era','swsh_era','sv_era','modern')),
  reprint_count   int NOT NULL DEFAULT 0,        -- times this set has been reprinted
  last_reprint_year int,
  reprint_risk    text CHECK (reprint_risk IN ('none','low','medium','high','very_high')) DEFAULT 'medium',
  print_run_size  text CHECK (print_run_size IN ('ultra_scarce','scarce','moderate','large','mass_market')) DEFAULT 'moderate',
  collector_notes text,                          -- "Only WOTC-era set with this mechanic"
  wiki_url        text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.set_enrichment ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read set_enrichment"
  ON public.set_enrichment FOR SELECT USING (true);
CREATE POLICY "service role manage set_enrichment"
  ON public.set_enrichment FOR ALL USING (auth.role() = 'service_role');

-- ── 7. Buylist Prices ─────────────────────────────────────────────────────────
-- What dealers pay to buy cards. This is the absolute floor price.
CREATE TABLE IF NOT EXISTS public.buylist_prices (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  catalog_id      uuid REFERENCES public.card_catalog_items(catalog_id) ON DELETE CASCADE,
  card_name       text NOT NULL,
  set_name        text,
  dealer          text NOT NULL,                 -- 'tcgplayer','cardkingdom','coolstuffinc'
  condition       text NOT NULL DEFAULT 'NM',
  buy_price       numeric(10,2) NOT NULL,
  trade_price     numeric(10,2),                 -- trade-in credit (usually higher)
  currency        text NOT NULL DEFAULT 'USD',
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_buylist_catalog  ON public.buylist_prices(catalog_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_buylist_dealer   ON public.buylist_prices(dealer, recorded_at DESC);

ALTER TABLE public.buylist_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read buylist_prices"
  ON public.buylist_prices FOR SELECT USING (true);
CREATE POLICY "service role manage buylist_prices"
  ON public.buylist_prices FOR ALL USING (auth.role() = 'service_role');

