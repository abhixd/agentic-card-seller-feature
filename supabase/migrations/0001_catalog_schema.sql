-- Enable UUID generation
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------
-- card_catalog_items
-- The canonical source of truth for card identity.
-- Public read, authenticated insert/update.
-- ---------------------------------------------------------------
create table if not exists public.card_catalog_items (
  catalog_id          uuid primary key default gen_random_uuid(),
  category            text not null,               -- 'sports' | 'tcg' | 'other'
  franchise_or_brand  text not null,               -- 'Pokemon', 'NBA', 'NFL', 'MTG', ...
  set_name            text not null,
  year                smallint,
  card_name           text not null,
  card_number         text,
  variant             text,
  canonical_image_url text,
  metadata_json       jsonb default '{}'::jsonb,
  created_at          timestamptz default now()
);

-- Indexes for ILIKE search on lowercased values (created once)
create index if not exists idx_catalog_card_name
  on public.card_catalog_items (lower(card_name));

create index if not exists idx_catalog_franchise
  on public.card_catalog_items (lower(franchise_or_brand));

create index if not exists idx_catalog_set_name
  on public.card_catalog_items (lower(set_name));

create index if not exists idx_catalog_card_number
  on public.card_catalog_items (lower(card_number));

-- ---------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------
alter table public.card_catalog_items enable row level security;

-- Public read (anyone can search the catalog)
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'card_catalog_items' and policyname = 'catalog_read_all'
  ) then
    create policy "catalog_read_all"
      on public.card_catalog_items for select using (true);
  end if;
end $$;

-- Authenticated insert
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'card_catalog_items' and policyname = 'catalog_insert_auth'
  ) then
    create policy "catalog_insert_auth"
      on public.card_catalog_items for insert with check (auth.uid() is not null);
  end if;
end $$;
