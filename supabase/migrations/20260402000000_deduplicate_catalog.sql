-- -----------------------------------------------------------------------
-- Deduplicate card_catalog_items
--
-- Root cause: pokemonTcgSync loads existing rows with .ilike() which is
-- capped at 1000 rows by PostgREST. When a card already exists past row
-- 1000, it gets re-inserted, creating N copies. This migration:
--   1. Identifies the canonical row per (card_name, card_number, set_name)
--      — prefers rows that have a pokemon_tcg_id in metadata_json
--   2. Remaps all FK references to the canonical row
--   3. Deletes the duplicate rows
--   4. Adds a unique index to prevent recurrence
-- -----------------------------------------------------------------------

BEGIN;

-- Step 1 ─ build a mapping: duplicate_catalog_id → canonical_catalog_id
-- "canonical" = the row we keep; chosen by:
--   • prefer rows with metadata_json->>'pokemon_tcg_id' IS NOT NULL
--   • then by catalog_id (deterministic tiebreak)
CREATE TEMP TABLE _dedup_map AS
WITH ranked AS (
  SELECT
    catalog_id,
    FIRST_VALUE(catalog_id) OVER (
      PARTITION BY
        lower(coalesce(card_name,'')),
        lower(coalesce(card_number,'')),
        lower(coalesce(set_name,''))
      ORDER BY
        CASE WHEN metadata_json->>'pokemon_tcg_id' IS NOT NULL THEN 0 ELSE 1 END ASC,
        catalog_id ASC
    ) AS canonical_id
  FROM public.card_catalog_items
)
SELECT catalog_id AS dup_id, canonical_id
FROM ranked
WHERE catalog_id <> canonical_id;

-- Step 2 ─ remap FK references so we don't lose user data

-- inventory_items
UPDATE public.inventory_items i
SET catalog_id = m.canonical_id
FROM _dedup_map m
WHERE i.catalog_id = m.dup_id;

-- user_wantlist (created conditionally, guard with DO block)
DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='user_wantlist') THEN
    UPDATE public.user_wantlist w SET catalog_id = m.canonical_id FROM _dedup_map m WHERE w.catalog_id = m.dup_id;
  END IF;
END $$;

-- card_analyses (nullable FK, safe to nullify if remapping fails — but try update first)
UPDATE public.card_analyses a
SET catalog_id = m.canonical_id
FROM _dedup_map m
WHERE a.catalog_id = m.dup_id;

-- marketplace_listings
UPDATE public.marketplace_listings ml
SET catalog_id = m.canonical_id
FROM _dedup_map m
WHERE ml.catalog_id = m.dup_id;

-- Step 3 ─ delete duplicate rows
DELETE FROM public.card_catalog_items
WHERE catalog_id IN (SELECT dup_id FROM _dedup_map);

-- Step 4 ─ unique index to prevent future duplicates
-- Use LOWER() + coalesce so NULL card_number doesn't dodge the constraint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_catalog_name_num_set
  ON public.card_catalog_items (
    lower(coalesce(card_name,'')),
    lower(coalesce(card_number,'')),
    lower(coalesce(set_name,''))
  );

-- Reset catalog_sync_log so counts are recomputed against clean data
TRUNCATE TABLE public.catalog_sync_log;

DROP TABLE _dedup_map;

COMMIT;
