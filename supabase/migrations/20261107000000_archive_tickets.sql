alter table public.tickets
  add column if not exists is_archived boolean not null default false,
  add column if not exists archived_at timestamptz;

grant update (is_archived, archived_at) on public.tickets to authenticated;
