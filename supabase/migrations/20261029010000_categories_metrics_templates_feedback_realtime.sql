begin;

alter table public.tickets
  add column if not exists category text not null default 'Consulta';

alter table public.tickets
  drop constraint if exists tickets_category_valid;

alter table public.tickets
  add constraint tickets_category_valid
  check (category in (
    'Soporte técnico',
    'Accesos',
    'Incidente',
    'Solicitud de servicio',
    'Consulta',
    'Mejora',
    'Nómina y Pagos'
  ));

create index if not exists tickets_workspace_category_created_idx
  on public.tickets (workspace_id, category, created_at desc);

grant insert (category) on public.tickets to authenticated;
grant update (category) on public.tickets to authenticated;

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
    and new.priority = old.priority
    and new.category = old.category
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

create table if not exists public.response_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default public.current_workspace_id()
    references public.workspaces (id) on delete cascade,
  title text not null check (length(trim(title)) between 2 and 100),
  body text not null check (length(trim(body)) between 1 and 4000),
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, title)
);

create table if not exists public.ticket_satisfaction (
  ticket_id text primary key references public.tickets (id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  comment text check (comment is null or length(comment) <= 1000),
  submitted_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);

alter table public.notifications
  drop constraint if exists notifications_kind_check;

alter table public.notifications
  add constraint notifications_kind_check
  check (kind in ('comment', 'sla_warning', 'sla_overdue', 'satisfaction_request'));

alter table public.response_templates enable row level security;
alter table public.ticket_satisfaction enable row level security;

drop policy if exists "Workspace members can read response templates" on public.response_templates;
create policy "Workspace members can read response templates"
on public.response_templates for select to authenticated
using (workspace_id = (select public.current_workspace_id()));

drop policy if exists "Admins can create response templates" on public.response_templates;
create policy "Admins can create response templates"
on public.response_templates for insert to authenticated
with check (
  workspace_id = (select public.current_workspace_id())
  and created_by = (select auth.uid())
  and public.current_app_role() = 'Admin'
);

drop policy if exists "Admins can update response templates" on public.response_templates;
create policy "Admins can update response templates"
on public.response_templates for update to authenticated
using (
  workspace_id = (select public.current_workspace_id())
  and public.current_app_role() = 'Admin'
)
with check (
  workspace_id = (select public.current_workspace_id())
  and public.current_app_role() = 'Admin'
);

drop policy if exists "Admins can delete response templates" on public.response_templates;
create policy "Admins can delete response templates"
on public.response_templates for delete to authenticated
using (
  workspace_id = (select public.current_workspace_id())
  and public.current_app_role() = 'Admin'
);

drop policy if exists "Workspace members can read ticket satisfaction" on public.ticket_satisfaction;
create policy "Workspace members can read ticket satisfaction"
on public.ticket_satisfaction for select to authenticated
using (
  exists (
    select 1
    from public.tickets as ticket
    where ticket.id = ticket_satisfaction.ticket_id
      and ticket.workspace_id = (select public.current_workspace_id())
      and (
        public.current_app_role() in ('Admin', 'Agent')
        or ticket.created_by = (select auth.uid())
      )
  )
);

drop policy if exists "Ticket creators can submit satisfaction once ticket is closed" on public.ticket_satisfaction;
create policy "Ticket creators can submit satisfaction once ticket is closed"
on public.ticket_satisfaction for insert to authenticated
with check (
  submitted_by = (select auth.uid())
  and exists (
    select 1
    from public.tickets as ticket
    where ticket.id = ticket_satisfaction.ticket_id
      and ticket.workspace_id = (select public.current_workspace_id())
      and ticket.created_by = (select auth.uid())
      and ticket.status = 'closed'
  )
);

create or replace function public.notify_ticket_creator_for_satisfaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'closed' and old.status is distinct from new.status then
    insert into public.notifications (user_id, ticket_id, kind, dedupe_key, message)
    select ticket.created_by,
           ticket.id,
           'satisfaction_request',
           'satisfaction_request:' || ticket.id || ':' || ticket.updated_at::text,
           'El ticket ' || ticket.id || ' fue cerrado. Cuéntanos cómo fue la atención.'
    from public.tickets as ticket
    where ticket.id = new.id
      and not exists (
        select 1
        from public.ticket_satisfaction as satisfaction
        where satisfaction.ticket_id = ticket.id
      )
    on conflict (user_id, dedupe_key) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function public.notify_ticket_creator_for_satisfaction() from public, anon, authenticated;

drop trigger if exists tickets_notify_satisfaction on public.tickets;
create trigger tickets_notify_satisfaction
after update of status on public.tickets
for each row execute function public.notify_ticket_creator_for_satisfaction();

insert into public.notifications (user_id, ticket_id, kind, dedupe_key, message)
select ticket.created_by,
       ticket.id,
       'satisfaction_request',
       'satisfaction_request:' || ticket.id,
       'El ticket ' || ticket.id || ' fue cerrado. Cuéntanos cómo fue la atención.'
from public.tickets as ticket
where ticket.status = 'closed'
  and not exists (
    select 1
    from public.ticket_satisfaction as satisfaction
    where satisfaction.ticket_id = ticket.id
  )
on conflict (user_id, dedupe_key) do nothing;

revoke all on public.response_templates, public.ticket_satisfaction from public, anon, authenticated;
grant select, insert, update, delete on public.response_templates to authenticated;
grant select, insert on public.ticket_satisfaction to authenticated;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['tickets', 'ticket_comments', 'notifications'] loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end;
$$;

commit;
