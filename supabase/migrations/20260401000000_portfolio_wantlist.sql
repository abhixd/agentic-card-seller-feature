-- ── Portfolio snapshots ────────────────────────────────────────────────────────
-- One row per user per day, recording total active portfolio value.
-- Accumulates over time → used to render a portfolio value line chart.

create table if not exists portfolio_snapshots (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  snapshot_date date not null default current_date,
  total_value   numeric(12, 2) not null default 0,
  card_count    int  not null default 0,
  created_at    timestamptz default now(),

  unique (user_id, snapshot_date)   -- one row per user per day
);

alter table portfolio_snapshots enable row level security;

create policy "Users can read own snapshots"
  on portfolio_snapshots for select
  using (auth.uid() = user_id);

create policy "Users can insert own snapshots"
  on portfolio_snapshots for insert
  with check (auth.uid() = user_id);

create policy "Users can update own snapshots"
  on portfolio_snapshots for update
  using (auth.uid() = user_id);

create index if not exists portfolio_snapshots_user_date
  on portfolio_snapshots (user_id, snapshot_date desc);

-- ── User wantlist ──────────────────────────────────────────────────────────────
-- Cards a user is hunting — tracks target price vs current market price.

create table if not exists user_wantlist (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  catalog_id    uuid not null references card_catalog_items(catalog_id) on delete cascade,
  target_price  numeric(10, 2),           -- null = watching without a target
  notes         text,
  created_at    timestamptz default now(),

  unique (user_id, catalog_id)            -- one entry per card per user
);

alter table user_wantlist enable row level security;

create policy "Users can manage own wantlist"
  on user_wantlist for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists user_wantlist_user
  on user_wantlist (user_id, created_at desc);
