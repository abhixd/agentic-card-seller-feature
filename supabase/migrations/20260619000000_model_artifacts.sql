-- ---------------------------------------------------------------
-- model_artifacts
-- Durable storage for the deployed per-side centering selector, so a retrain deployed from
-- /admin survives grading-api restarts/redeploys. The grading-api loads the newest row at
-- startup (anon read) and falls back to the baked-in perside_lr.joblib if none / unavailable.
-- The model is a small sklearn pipeline (~3 KB base64) — not sensitive (it's already served
-- via /grade), so it's world-readable; only authenticated users may write a new one.
-- ---------------------------------------------------------------
create table if not exists public.model_artifacts (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null default 'perside_centering',
  model_b64     text not null,                 -- joblib.dump({"model": pipeline}) → base64
  loo           numeric,                       -- leave-one-card-out accuracy at deploy time
  n_corrections int,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_model_artifacts_latest
  on public.model_artifacts (kind, created_at desc);

alter table public.model_artifacts enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='model_artifacts' and policyname='ma_read_all') then
    create policy "ma_read_all" on public.model_artifacts for select using (true);   -- grading-api reads with the anon key
  end if;
  if not exists (select 1 from pg_policies where tablename='model_artifacts' and policyname='ma_insert_authed') then
    create policy "ma_insert_authed" on public.model_artifacts for insert with check (auth.uid() = created_by);
  end if;
end $$;
