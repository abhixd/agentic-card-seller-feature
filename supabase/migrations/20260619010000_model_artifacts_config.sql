-- Checkpoint the config alongside each model + a human note, so every deployed version records
-- exactly how it was produced and a revert restores the matching config.
alter table public.model_artifacts add column if not exists config jsonb;
alter table public.model_artifacts add column if not exists note   text;
