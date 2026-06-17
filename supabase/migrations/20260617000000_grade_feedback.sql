-- ---------------------------------------------------------------
-- grade_feedback
-- Thumbs up/down on a grade read (centering by default). Grading is stateless
-- (no persisted grade row to reference), so each feedback row carries a denormalised
-- snapshot of the grade context + the warped image. That makes a downvote actionable
-- on its own, and turns the corpus into a user-labelled centering dataset for the CV
-- pipeline (up = looked right, down = looked wrong, with the exact boundaries we drew).
-- ---------------------------------------------------------------
create table if not exists public.grade_feedback (
  feedback_id       uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  aspect            text not null default 'centering'
                      check (aspect in ('centering','overall','corners','edges','surface')),
  verdict           text not null check (verdict in ('up','down')),
  comment           text,
  -- grade-context snapshot (what we need to reproduce/debug a read)
  overall_score     numeric(4,2),
  psa_equivalent    text,
  centering_score   numeric(4,2),
  left_right        text,
  top_bottom        text,
  reliable          boolean,
  border_type       text,
  grader_backend    text,
  content_region    jsonb,          -- inner printed-border box {x1,y1,x2,y2}
  card_boundary     jsonb,          -- outer card-edge box [x1,y1,x2,y2]
  warped_image_b64  text,           -- the exact warped image the overlay was drawn on
  created_at        timestamptz not null default now()
);

create index if not exists idx_grade_feedback_user
  on public.grade_feedback (user_id, created_at desc);

-- triage index: pull "all downvoted centering reads, newest first" cheaply
create index if not exists idx_grade_feedback_triage
  on public.grade_feedback (aspect, verdict, created_at desc);

-- ---------------------------------------------------------------
-- Row-Level Security: a user may write and read only their own rows.
-- Analysis/triage runs under the service role, which bypasses RLS.
-- ---------------------------------------------------------------
alter table public.grade_feedback enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='grade_feedback' and policyname='grade_feedback_insert_own') then
    create policy "grade_feedback_insert_own" on public.grade_feedback for insert
      with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='grade_feedback' and policyname='grade_feedback_select_own') then
    create policy "grade_feedback_select_own" on public.grade_feedback for select
      using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='grade_feedback' and policyname='grade_feedback_update_own') then
    create policy "grade_feedback_update_own" on public.grade_feedback for update
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;
