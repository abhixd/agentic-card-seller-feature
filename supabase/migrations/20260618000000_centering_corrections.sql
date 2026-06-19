-- ---------------------------------------------------------------
-- centering_corrections
-- A user's MANUAL fix of the inner print-border box on a grade read. Grading is
-- stateless, so each row carries a denormalised snapshot: the exact warped image, the
-- boundary the grader detected, and the boundary the user marked. That makes each row
-- a clean corner-GT label for retraining the per-side centering selector (warped image
-- + corrected inner boundary), and lets us measure the correction delta vs the original.
-- ---------------------------------------------------------------
create table if not exists public.centering_corrections (
  correction_id            uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users(id) on delete cascade,
  original_content_region  jsonb,                 -- what the grader detected {x1,y1,x2,y2} (0..1)
  corrected_content_region jsonb not null,        -- what the user marked      {x1,y1,x2,y2} (0..1)
  card_boundary            jsonb,                 -- outer card-edge box [x1,y1,x2,y2] (unchanged; for context)
  left_right               text,                  -- corrected ratios (for triage), e.g. "52/48"
  top_bottom               text,
  original_left_right      text,                  -- what the grader reported (to rank by delta)
  original_top_bottom      text,
  border_type              text,
  grader_backend           text,
  warped_image_b64         text,                  -- the exact warped image the boundary is relative to
  created_at               timestamptz not null default now()
);

create index if not exists idx_centering_corrections_user
  on public.centering_corrections (user_id, created_at desc);
create index if not exists idx_centering_corrections_triage
  on public.centering_corrections (created_at desc);

-- ---------------------------------------------------------------
-- Row-Level Security: a user may write and read only their own rows.
-- Export/retrain runs under the service role, which bypasses RLS.
-- ---------------------------------------------------------------
alter table public.centering_corrections enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='centering_corrections' and policyname='cc_insert_own') then
    create policy "cc_insert_own" on public.centering_corrections for insert
      with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='centering_corrections' and policyname='cc_select_own') then
    create policy "cc_select_own" on public.centering_corrections for select
      using (auth.uid() = user_id);
  end if;
end $$;
