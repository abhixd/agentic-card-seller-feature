-- ---------------------------------------------------------------
-- inventory_items
-- One row per card saved to the user's working inventory.
-- References a catalog card and (optionally) the latest analysis.
-- ---------------------------------------------------------------
create table if not exists public.inventory_items (
  item_id          uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  catalog_id       uuid not null references public.card_catalog_items(catalog_id),
  analysis_id      uuid references public.card_analyses(analysis_id) on delete set null,

  -- Status workflow: owned → listed | sent_to_grading → sold
  status           text not null default 'owned'
                     check (status in ('owned','listed','sent_to_grading','sold')),

  -- User-editable fields
  acquisition_cost numeric(10,2) not null default 0,
  notes            text,

  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create index if not exists idx_inventory_user
  on public.inventory_items (user_id, created_at desc);

create index if not exists idx_inventory_catalog
  on public.inventory_items (catalog_id);

create index if not exists idx_inventory_analysis
  on public.inventory_items (analysis_id);

-- Auto-update updated_at on row change
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$ begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'inventory_updated_at' and tgrelid = 'public.inventory_items'::regclass
  ) then
    create trigger inventory_updated_at
      before update on public.inventory_items
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- ---------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------
alter table public.inventory_items enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'inventory_items' and policyname = 'inventory_own_rows'
  ) then
    create policy "inventory_own_rows" on public.inventory_items for all
      using  (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;
