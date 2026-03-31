-- ---------------------------------------------------------------
-- card_analyses
-- One row per analysis run. Stores comps summary + recommendation.
-- ---------------------------------------------------------------
create table if not exists public.card_analyses (
  analysis_id             uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  catalog_id              uuid references public.card_catalog_items(catalog_id),
  -- Comps summary
  estimated_market_value  numeric(10,2),
  comp_range_low          numeric(10,2),
  comp_range_high         numeric(10,2),
  confidence_score        numeric(4,3) check (confidence_score between 0 and 1),
  comp_count              integer default 0,
  days_of_data            integer default 0,
  -- Recommendation
  recommendation_type     text check (recommendation_type in
                            ('SELL_RAW','GRADE','HOLD','INSUFFICIENT_CONFIDENCE')),
  rationale_text          text,
  -- Fee/grading assumptions snapshot
  assumptions_json        jsonb default '{}'::jsonb,
  created_at              timestamptz default now()
);

create index if not exists idx_analyses_user
  on public.card_analyses (user_id, created_at desc);

create index if not exists idx_analyses_catalog
  on public.card_analyses (catalog_id);

-- ---------------------------------------------------------------
-- comparable_sales
-- Individual eBay sold comps linked to an analysis.
-- ---------------------------------------------------------------
create table if not exists public.comparable_sales (
  comp_id              uuid primary key default gen_random_uuid(),
  analysis_id          uuid not null references public.card_analyses(analysis_id) on delete cascade,
  catalog_id           uuid references public.card_catalog_items(catalog_id),
  venue                text not null default 'ebay',
  sold_price           numeric(10,2) not null,
  sold_at              timestamptz,
  grade_state          text check (grade_state in ('raw','graded','unknown')),
  grade_value          text,
  raw_or_graded        text check (raw_or_graded in ('raw','graded')),
  source_url           text,
  title                text,
  normalization_weight numeric(4,3) default 1.0,
  created_at           timestamptz default now()
);

create index if not exists idx_comps_analysis
  on public.comparable_sales (analysis_id);

-- ---------------------------------------------------------------
-- condition_assessments
-- Optional per-analysis condition input from the user.
-- ---------------------------------------------------------------
create table if not exists public.condition_assessments (
  condition_id     uuid primary key default gen_random_uuid(),
  analysis_id      uuid not null references public.card_analyses(analysis_id) on delete cascade,
  corners_rating   smallint check (corners_rating between 1 and 5),
  edges_rating     smallint check (edges_rating between 1 and 5),
  surface_rating   smallint check (surface_rating between 1 and 5),
  centering_rating smallint check (centering_rating between 1 and 5),
  notes            text,
  created_at       timestamptz default now()
);

create index if not exists idx_conditions_analysis
  on public.condition_assessments (analysis_id);

-- ---------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------
alter table public.card_analyses         enable row level security;
alter table public.comparable_sales      enable row level security;
alter table public.condition_assessments enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='card_analyses' and policyname='analyses_own_rows') then
    create policy "analyses_own_rows" on public.card_analyses for all
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='comparable_sales' and policyname='comps_via_analysis') then
    create policy "comps_via_analysis" on public.comparable_sales for all
      using (exists (
        select 1 from public.card_analyses a
        where a.analysis_id = comparable_sales.analysis_id and a.user_id = auth.uid()
      ));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='condition_assessments' and policyname='conditions_via_analysis') then
    create policy "conditions_via_analysis" on public.condition_assessments for all
      using (exists (
        select 1 from public.card_analyses a
        where a.analysis_id = condition_assessments.analysis_id and a.user_id = auth.uid()
      ));
  end if;
end $$;
