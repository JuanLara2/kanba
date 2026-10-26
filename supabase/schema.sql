create sequence if not exists public.ticket_number_seq start with 1001;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null check (length(trim(full_name)) >= 2),
  email text not null unique,
  role text not null check (role in ('Admin', 'Agent', 'Reporter')),
  created_at timestamptz not null default now()
);

create table if not exists public.tickets (
  id text primary key default ('TCK-' || nextval('public.ticket_number_seq')),
  title text not null check (length(trim(title)) >= 4),
  description text not null check (length(trim(description)) > 0),
  status text not null check (status in ('new', 'open', 'in_progress', 'resolved', 'closed', 'blocked')),
  priority text not null check (priority in ('Baja', 'Media', 'Alta', 'Urgente')),
  assigned_to uuid references public.profiles (id) on delete set null,
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  due_date timestamptz,
  checklist jsonb not null default '[]'::jsonb
    constraint tickets_checklist_is_array check (jsonb_typeof(checklist) = 'array')
);

create table if not exists public.ticket_status_history (
  id bigint generated always as identity primary key,
  ticket_id text not null,
  from_status text check (from_status is null or from_status in ('new', 'open', 'in_progress', 'resolved', 'closed', 'blocked')),
  to_status text not null check (to_status in ('new', 'open', 'in_progress', 'resolved', 'closed', 'blocked')),
  changed_at timestamptz not null default now(),
  changed_by uuid references public.profiles (id) on delete set null
);

create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles as p
  where p.id = (select auth.uid())
$$;

revoke all on function public.current_app_role() from public;
grant execute on function public.current_app_role() to authenticated;

create or replace function public.enforce_ticket_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  app_role text := public.current_app_role();
begin
  if new.id <> old.id
    or new.created_by <> old.created_by
    or new.created_at <> old.created_at then
    raise exception 'Ticket identity and creator fields cannot be changed';
  end if;

  if app_role = 'Admin' then
    null;
  elsif app_role = 'Agent' and (old.assigned_to = (select auth.uid()) or old.status = 'open') then
    null;
  elsif app_role = 'Agent'
    and new.title = old.title
    and new.description = old.description
    and new.status = old.status
    and new.priority = old.priority
    and new.checklist = old.checklist then
    null;
  else
    raise exception 'Insufficient permission to update this ticket';
  end if;

  if app_role = 'Agent'
    and not (old.assigned_to = (select auth.uid()) or old.status = 'open')
    and new.checklist is distinct from old.checklist then
    raise exception 'Insufficient permission to update ticket checklist';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.validate_ticket_assignee()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.assigned_to is not null and not exists (
    select 1
    from public.profiles as p
    where p.id = new.assigned_to
      and p.role in ('Admin', 'Agent')
  ) then
    raise exception 'Tickets can only be assigned to admins or agents';
  end if;
  return new;
end;
$$;

create or replace function public.record_ticket_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    insert into public.ticket_status_history (ticket_id, from_status, to_status, changed_by)
    values (new.id, old.status, new.status, (select auth.uid()));
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_ticket_update() from public, anon, authenticated;
revoke all on function public.validate_ticket_assignee() from public, anon, authenticated;
revoke all on function public.record_ticket_status_change() from public, anon, authenticated;

drop trigger if exists tickets_enforce_update on public.tickets;
create trigger tickets_enforce_update
before update on public.tickets
for each row execute function public.enforce_ticket_update();

drop trigger if exists tickets_validate_assignee on public.tickets;
create trigger tickets_validate_assignee
before insert or update on public.tickets
for each row execute function public.validate_ticket_assignee();

drop trigger if exists tickets_record_status_change on public.tickets;
create trigger tickets_record_status_change
after update on public.tickets
for each row execute function public.record_ticket_status_change();

alter table public.profiles enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_status_history enable row level security;

drop policy if exists "Authenticated users can read profiles" on public.profiles;
create policy "Authenticated users can read profiles"
on public.profiles for select to authenticated
using ((select auth.uid()) is not null);

drop policy if exists "Authenticated users can read tickets" on public.tickets;
create policy "Authenticated users can read tickets"
on public.tickets for select to authenticated
using ((select auth.uid()) is not null);

drop policy if exists "Admins and agents can create tickets, reporters can submit new tickets" on public.tickets;
create policy "Admins and agents can create tickets, reporters can submit new tickets"
on public.tickets for insert to authenticated
with check (
  created_by = (select auth.uid())
  and (
    public.current_app_role() in ('Admin', 'Agent')
    or (
      public.current_app_role() = 'Reporter'
      and status = 'new'
      and assigned_to is null
      and due_date is null
      and checklist = '[]'::jsonb
    )
  )
);

drop policy if exists "Admins and agents can update tickets" on public.tickets;
create policy "Admins and agents can update tickets"
on public.tickets for update to authenticated
using (
  public.current_app_role() = 'Admin'
  or public.current_app_role() = 'Agent'
)
with check (public.current_app_role() in ('Admin', 'Agent'));

drop policy if exists "Only admins can delete tickets" on public.tickets;
create policy "Only admins can delete tickets"
on public.tickets for delete to authenticated
using (public.current_app_role() = 'Admin');

drop policy if exists "Authenticated users can read ticket history" on public.ticket_status_history;
create policy "Authenticated users can read ticket history"
on public.ticket_status_history for select to authenticated
using ((select auth.uid()) is not null);

revoke all on public.profiles, public.tickets, public.ticket_status_history from public, anon, authenticated;
grant select on public.profiles, public.tickets, public.ticket_status_history to authenticated;
grant insert (title, description, status, priority, assigned_to, due_date, checklist) on public.tickets to authenticated;
grant update (title, description, status, priority, assigned_to, due_date, checklist) on public.tickets to authenticated;
grant delete on public.tickets to authenticated;
grant usage on sequence public.ticket_number_seq to authenticated;
