-- fetch_log.error can contain sensitive upstream API error details.
-- Remove the broad read policy from databases where the baseline schema was already applied.
alter table public.fetch_log enable row level security;
drop policy if exists "public read" on public.fetch_log;
