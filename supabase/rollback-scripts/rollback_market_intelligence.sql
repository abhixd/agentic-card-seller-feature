-- =============================================================================
-- ROLLBACK: drops all tables created in 20260402000001_market_intelligence_tables.sql
-- Run this ONLY if you need to remove the market intelligence feature entirely.
-- =============================================================================
DROP TABLE IF EXISTS public.buylist_prices           CASCADE;
DROP TABLE IF EXISTS public.set_enrichment           CASCADE;
DROP TABLE IF EXISTS public.tournament_appearances   CASCADE;
DROP TABLE IF EXISTS public.pricecharting_history    CASCADE;
DROP TABLE IF EXISTS public.set_investment_metrics   CASCADE;
DROP TABLE IF EXISTS public.psa_pop_snapshots        CASCADE;
DROP TABLE IF EXISTS public.ebay_sold_history        CASCADE;
