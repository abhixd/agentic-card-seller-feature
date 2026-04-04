-- catalog_sync_log: tracks when each search query was last fully synced
-- from the Pokemon TCG API. This lets us skip re-syncing recent queries
-- while ensuring older / newly-expanded queries always get a fresh sync.

CREATE TABLE IF NOT EXISTS catalog_sync_log (
  query_term  text        PRIMARY KEY,
  api_total   integer     NOT NULL DEFAULT 0,
  local_count integer     NOT NULL DEFAULT 0,
  synced_at   timestamptz NOT NULL DEFAULT now()
);

-- Only the service role (server-side crons + API routes) should write here.
ALTER TABLE catalog_sync_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_only" ON catalog_sync_log USING (false);
