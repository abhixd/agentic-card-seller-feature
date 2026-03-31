-- ── user_profiles ──────────────────────────────────────────────────────────────
create table if not exists public.user_profiles (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  username           text unique not null,
  display_name       text,
  avatar_url         text,
  bio                text,
  collection_visibility text not null default 'public'
    check (collection_visibility in ('public', 'friends', 'private')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.user_profiles enable row level security;
create policy "profiles_select_all"  on public.user_profiles for select using (true);
create policy "profiles_insert_own"  on public.user_profiles for insert with check (auth.uid() = user_id);
create policy "profiles_update_own"  on public.user_profiles for update using (auth.uid() = user_id);

-- ── user_follows ────────────────────────────────────────────────────────────────
create table if not exists public.user_follows (
  id           uuid primary key default gen_random_uuid(),
  follower_id  uuid not null references auth.users(id) on delete cascade,
  following_id uuid not null references auth.users(id) on delete cascade,
  status       text not null default 'pending'
    check (status in ('pending', 'accepted')),
  created_at   timestamptz not null default now(),
  unique(follower_id, following_id)
);

alter table public.user_follows enable row level security;
create policy "follows_select_involved" on public.user_follows for select
  using (auth.uid() = follower_id or auth.uid() = following_id);
create policy "follows_insert_own"  on public.user_follows for insert
  with check (auth.uid() = follower_id);
create policy "follows_update_own"  on public.user_follows for update
  using (auth.uid() = following_id);
create policy "follows_delete_own"  on public.user_follows for delete
  using (auth.uid() = follower_id or auth.uid() = following_id);
