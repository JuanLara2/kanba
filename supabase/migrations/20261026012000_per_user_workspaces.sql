begin;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) >= 2),
  created_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists workspace_id uuid references public.workspaces (id),
  add column if not exists created_by_admin_id uuid references public.profiles (id) on delete set null;

create temporary table profile_workspace_backfill on commit drop as
select p.id as user_id, gen_random_uuid() as workspace_id, p.full_name
from public.profiles as p
where p.workspace_id is null;

insert into public.workspaces (id, name)
select workspace_id, full_name || ' private workspace'
from profile_workspace_backfill;

update public.profiles as p
set workspace_id = backfill.workspace_id
from profile_workspace_backfill as backfill
where p.id = backfill.user_id;

update public.profiles as p
set created_by_admin_id = admin.id
from (
  select id
  from public.profiles
  where role = 'Admin'
  order by created_at, id
  limit 1
) as admin
where p.id <> admin.id
  and p.created_by_admin_id is null;

alter table public.profiles
  alter column workspace_id set not null;

alter table public.tickets
  add column if not exists workspace_id uuid references public.workspaces (id);

update public.tickets as t
set workspace_id = p.workspace_id
from public.profiles as p
where p.id = t.created_by
  and t.workspace_id is null;

update public.tickets as t
set assigned_to = null
where t.assigned_to is not null
  and not exists (
    select 1
    from public.profiles as assignee
    where assignee.id = t.assigned_to
      and assignee.workspace_id = t.workspace_id
  );

alter table public.tickets
  alter column workspace_id set not null,
  alter column workspace_id drop default;

create index if not exists profiles_workspace_id_idx on public.profiles (workspace_id);
create index if not exists profiles_created_by_admin_id_idx on public.profiles (created_by_admin_id);
create index if not exists tickets_workspace_id_created_at_idx on public.tickets (workspace_id, created_at desc);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.ticket_status_history'::regclass
      and conname = 'ticket_status_history_ticket_id_fkey'
  ) then
    alter table public.ticket_status_history
      add constraint ticket_status_history_ticket_id_fkey
      foreign key (ticket_id) references public.tickets (id) on delete cascade
      not valid;
  end if;
end;
$$;

create or replace function public.current_workspace_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.workspace_id
  from public.profiles as p
  where p.id = (select auth.uid())
$$;

revoke all on function public.current_workspace_id() from public, anon;
grant execute on function public.current_workspace_id() to authenticated;

alter table public.tickets
  alter column workspace_id set default public.current_workspace_id();

create or replace function public.admin_create_user_workspace(
  p_user_id uuid,
  p_full_name text,
  p_email text,
  p_role text,
  p_created_by_admin_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_workspace_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the trusted user-provisioning service can create workspaces';
  end if;

  if not exists (
    select 1
    from public.profiles as admin_profile
    where admin_profile.id = p_created_by_admin_id
      and admin_profile.role = 'Admin'
  ) then
    raise exception 'The user creator must be an administrator';
  end if;

  insert into public.workspaces (name)
  values (trim(p_full_name) || ' private workspace')
  returning id into new_workspace_id;

  insert into public.profiles (id, full_name, email, role, workspace_id, created_by_admin_id)
  values (p_user_id, trim(p_full_name), lower(trim(p_email)), p_role, new_workspace_id, p_created_by_admin_id);

  return new_workspace_id;
end;
$$;

revoke all on function public.admin_create_user_workspace(uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_create_user_workspace(uuid, text, text, text, uuid) to service_role;

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
    or new.created_at <> old.created_at
    or new.workspace_id <> old.workspace_id then
    raise exception 'Ticket identity, workspace, and creator fields cannot be changed';
  end if;

  if app_role = 'Admin' then
    null;
  elsif app_role = 'Agent' and (old.assigned_to = (select auth.uid()) or old.status = 'open') then
    null;
  elsif app_role = 'Agent'
    and new.title = old.title
    and new.description = old.description
    and new.status = old.status
    and new.priority = old.priority then
    null;
  else
    raise exception 'Insufficient permission to update this ticket';
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
      and p.workspace_id = new.workspace_id
      and p.role in ('Admin', 'Agent')
  ) then
    raise exception 'Tickets can only be assigned to admins or agents in the same workspace';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_ticket_update() from public, anon, authenticated;
revoke all on function public.validate_ticket_assignee() from public, anon, authenticated;

drop policy if exists "Authenticated users can read profiles" on public.profiles;
create policy "Users can read profiles in their workspace or accounts they created"
on public.profiles for select to authenticated
using (
  id = (select auth.uid())
  or workspace_id = (select public.current_workspace_id())
  or (
    created_by_admin_id = (select auth.uid())
    and (select public.current_app_role()) = 'Admin'
  )
);

drop policy if exists "Authenticated users can read tickets" on public.tickets;
create policy "Users can read tickets in their workspace"
on public.tickets for select to authenticated
using (workspace_id = (select public.current_workspace_id()));

drop policy if exists "Admins and agents can create tickets, reporters can submit new tickets" on public.tickets;
create policy "Users can create tickets only in their workspace"
on public.tickets for insert to authenticated
with check (
  workspace_id = (select public.current_workspace_id())
  and created_by = (select auth.uid())
  and (
    public.current_app_role() in ('Admin', 'Agent')
    or (
      public.current_app_role() = 'Reporter'
      and status = 'new'
      and assigned_to is null
      and due_date is null
    )
  )
);

drop policy if exists "Admins and agents can update tickets" on public.tickets;
create policy "Admins and agents can update tickets in their workspace"
on public.tickets for update to authenticated
using (
  workspace_id = (select public.current_workspace_id())
  and public.current_app_role() in ('Admin', 'Agent')
)
with check (
  workspace_id = (select public.current_workspace_id())
  and public.current_app_role() in ('Admin', 'Agent')
);

drop policy if exists "Only admins can delete tickets" on public.tickets;
create policy "Only admins can delete tickets in their workspace"
on public.tickets for delete to authenticated
using (
  workspace_id = (select public.current_workspace_id())
  and public.current_app_role() = 'Admin'
);

drop policy if exists "Authenticated users can read ticket history" on public.ticket_status_history;
create policy "Users can read ticket history in their workspace"
on public.ticket_status_history for select to authenticated
using (
  exists (
    select 1
    from public.tickets as t
    where t.id = ticket_status_history.ticket_id
      and t.workspace_id = (select public.current_workspace_id())
  )
);

revoke all on public.workspaces from public, anon, authenticated;

commit;
