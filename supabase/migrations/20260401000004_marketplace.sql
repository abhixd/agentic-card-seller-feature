-- Listings: a card for sale or trade
create table if not exists public.marketplace_listings (
  id              bigint generated always as identity primary key,
  seller_id       uuid not null references auth.users(id) on delete cascade,
  catalog_id      uuid not null references public.card_catalog_items(catalog_id),
  title           text not null,                    -- e.g. "Charizard ex Alt-Art NM"
  condition       text not null default 'NM',       -- NM / LP / MP / HP / D / PSA10 / PSA9 / BGS9.5
  grade           text,                             -- "PSA 10", "BGS 9.5", null for raw
  asking_price    numeric(10,2) not null,
  ai_market_price numeric(10,2),                    -- TCGPlayer market at time of listing
  price_delta_pct numeric(5,1),                     -- (asking - market) / market * 100
  description     text,
  image_urls      text[] not null default '{}',
  accepts_trades  boolean not null default false,
  status          text not null default 'active'    -- active / sold / cancelled
    check (status in ('active','sold','cancelled')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Offers: buyer makes an offer on a listing
create table if not exists public.marketplace_offers (
  id              bigint generated always as identity primary key,
  listing_id      bigint not null references public.marketplace_listings(id) on delete cascade,
  buyer_id        uuid not null references auth.users(id) on delete cascade,
  offer_price     numeric(10,2) not null,
  message         text,
  status          text not null default 'pending'   -- pending / accepted / rejected / countered / withdrawn
    check (status in ('pending','accepted','rejected','countered','withdrawn')),
  counter_price   numeric(10,2),                    -- set when seller counters
  created_at      timestamptz not null default now()
);

-- RLS
alter table public.marketplace_listings enable row level security;
alter table public.marketplace_offers   enable row level security;

-- Listings: anyone can read active listings; only seller can manage their own
create policy "anyone can view active listings"
  on public.marketplace_listings for select using (status = 'active' or seller_id = auth.uid());
create policy "sellers manage own listings"
  on public.marketplace_listings for all using (seller_id = auth.uid());
create policy "service role full access listings"
  on public.marketplace_listings for all using (auth.role() = 'service_role');

-- Offers: buyer sees own offers; seller sees offers on their listings
create policy "buyers see own offers"
  on public.marketplace_offers for select
  using (buyer_id = auth.uid() or
    listing_id in (select id from public.marketplace_listings where seller_id = auth.uid()));
create policy "buyers create offers"
  on public.marketplace_offers for insert with check (buyer_id = auth.uid());
create policy "buyers withdraw own offers"
  on public.marketplace_offers for update using (buyer_id = auth.uid());
create policy "sellers respond to offers"
  on public.marketplace_offers for update
  using (listing_id in (select id from public.marketplace_listings where seller_id = auth.uid()));

create index idx_marketplace_status    on public.marketplace_listings(status, created_at desc);
create index idx_marketplace_seller    on public.marketplace_listings(seller_id);
create index idx_marketplace_catalog   on public.marketplace_listings(catalog_id);
create index idx_offers_listing        on public.marketplace_offers(listing_id);
create index idx_offers_buyer          on public.marketplace_offers(buyer_id);
