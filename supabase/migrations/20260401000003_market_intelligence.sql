create table if not exists public.market_intelligence_posts (
  id            bigint generated always as identity primary key,
  headline      text not null,
  body          text not null,
  signal_types  text[]  not null default '{}',
  cards_referenced jsonb  not null default '[]',  -- [{name, set, price, change_pct}]
  data_snapshot jsonb  not null default '{}',     -- raw metrics used to generate
  confidence    smallint not null default 75,     -- 0-100
  generated_at  timestamptz not null default now()
);

alter table public.market_intelligence_posts enable row level security;
create policy "anyone can read intel posts"
  on public.market_intelligence_posts for select using (true);
create policy "service role can write intel posts"
  on public.market_intelligence_posts for all using (auth.role() = 'service_role');

create index idx_intel_generated_at on public.market_intelligence_posts(generated_at desc);
