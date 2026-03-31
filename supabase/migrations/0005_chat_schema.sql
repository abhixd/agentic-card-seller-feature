-- ---------------------------------------------------------------
-- Chat sessions and messages for the read-only copilot
-- ---------------------------------------------------------------

create table if not exists chat_sessions (
  session_id  uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  title       text not null default 'New conversation',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists chat_messages (
  message_id   uuid primary key default gen_random_uuid(),
  session_id   uuid not null references chat_sessions (session_id) on delete cascade,
  role         text not null check (role in ('user', 'assistant', 'tool')),
  content      text,
  tool_calls   jsonb,      -- for assistant messages that invoke tools
  tool_name    text,       -- for tool result messages
  created_at   timestamptz not null default now()
);

-- Indexes
create index if not exists idx_chat_sessions_user   on chat_sessions (user_id, created_at desc);
create index if not exists idx_chat_messages_session on chat_messages (session_id, created_at asc);

-- updated_at trigger for chat_sessions
create trigger set_chat_sessions_updated_at
  before update on chat_sessions
  for each row execute function set_updated_at();

-- RLS
alter table chat_sessions enable row level security;
alter table chat_messages  enable row level security;

create policy chat_sessions_own_rows on chat_sessions
  using (user_id = auth.uid());

create policy chat_messages_own_rows on chat_messages
  using (
    session_id in (
      select session_id from chat_sessions where user_id = auth.uid()
    )
  );
