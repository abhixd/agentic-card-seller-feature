-- Add analysis_id column if it doesn't already exist (idempotent)
do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'inventory_items'
      and column_name  = 'analysis_id'
  ) then
    alter table public.inventory_items
      add column analysis_id uuid references public.card_analyses(analysis_id) on delete set null;
  end if;
end $$;

create index if not exists idx_inventory_analysis
  on public.inventory_items (analysis_id);
