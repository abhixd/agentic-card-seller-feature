CREATE TABLE IF NOT EXISTS pokemon_news (
  id          BIGSERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  body        TEXT NOT NULL,
  source_url  TEXT,
  source_name TEXT,
  image_url   TEXT,
  tags        TEXT[] DEFAULT '{}',
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pokemon_news_published_at_idx ON pokemon_news(published_at DESC);
