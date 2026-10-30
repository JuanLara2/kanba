begin;

create or replace function public.add_business_hours(p_start timestamptz, p_hours numeric)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
declare
  local_time timestamp without time zone := p_start at time zone 'America/Bogota';
  local_day_start timestamp without time zone;
  local_day_end timestamp without time zone;
  available_hours numeric;
  remaining_hours numeric := greatest(p_hours, 0);
begin
  if p_start is null then
    return null;
  end if;

  while remaining_hours > 0 loop
    local_day_start := date_trunc('day', local_time) + interval '8 hours';
    local_day_end := date_trunc('day', local_time) + interval '17 hours';

    if extract(isodow from local_time) between 1 and 5 then
      if local_time < local_day_start then
        local_time := local_day_start;
      elsif local_time >= local_day_end then
        local_time := local_day_start + interval '1 day';
      else
        available_hours := extract(epoch from (local_day_end - local_time)) / 3600;
        if remaining_hours <= available_hours then
          return (local_time + remaining_hours * interval '1 hour') at time zone 'America/Bogota';
        end if;
        remaining_hours := remaining_hours - available_hours;
        local_time := local_day_start + interval '1 day';
      end if;
    else
      local_time := local_day_start + interval '1 day';
    end if;
  end loop;

  return local_time at time zone 'America/Bogota';
end;
$$;

create or replace function public.ticket_sla_due_at(p_priority text, p_created_at timestamptz)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select case p_priority
    when 'Urgente' then p_created_at + interval '4 hours'
    when 'Alta' then public.add_business_hours(p_created_at, 8)
    when 'Media' then public.add_business_hours(p_created_at, 48)
    when 'Baja' then public.add_business_hours(p_created_at, 45)
    else null
  end
$$;

create or replace function public.ticket_sla_warning_at(p_priority text, p_created_at timestamptz)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select case p_priority
    when 'Urgente' then p_created_at + interval '3 hours 12 minutes'
    when 'Alta' then public.add_business_hours(p_created_at, 6.4)
    when 'Media' then public.add_business_hours(p_created_at, 38.4)
    when 'Baja' then public.add_business_hours(p_created_at, 36)
    else null
  end
$$;

alter table public.tickets
  add column if not exists sla_due_at timestamptz,
  add column if not exists sla_warning_at timestamptz;

alter table public.tickets disable trigger tickets_enforce_update;

update public.tickets
set sla_due_at = public.ticket_sla_due_at(priority, created_at),
    sla_warning_at = public.ticket_sla_warning_at(priority, created_at)
where sla_due_at is null or sla_warning_at is null;

alter table public.tickets enable trigger tickets_enforce_update;

create or replace function public.set_ticket_sla_deadlines()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.sla_due_at := public.ticket_sla_due_at(new.priority, new.created_at);
    new.sla_warning_at := public.ticket_sla_warning_at(new.priority, new.created_at);
  elsif new.priority is distinct from old.priority
    or new.created_at is distinct from old.created_at then
    new.sla_due_at := public.ticket_sla_due_at(new.priority, new.created_at);
    new.sla_warning_at := public.ticket_sla_warning_at(new.priority, new.created_at);
  end if;
  return new;
end;
$$;

drop trigger if exists tickets_set_sla_deadlines on public.tickets;
create trigger tickets_set_sla_deadlines
before insert or update of priority, created_at on public.tickets
for each row execute function public.set_ticket_sla_deadlines();

create table if not exists public.ticket_comments (
  id bigint generated always as identity primary key,
  ticket_id text not null references public.tickets (id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text not null check (length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists ticket_comments_ticket_created_idx
  on public.ticket_comments (ticket_id, created_at);

create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  ticket_id text not null references public.tickets (id) on delete cascade,
  kind text not null check (kind in ('comment', 'sla_warning', 'sla_overdue')),
  dedupe_key text not null,
  message text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (user_id, dedupe_key)
);

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

alter table public.ticket_comments enable row level security;
alter table public.notifications enable row level security;

drop policy if exists "Workspace members can read permitted ticket comments" on public.ticket_comments;
create policy "Workspace members can read permitted ticket comments"
on public.ticket_comments for select to authenticated
using (
  exists (
    select 1
    from public.tickets as ticket
    where ticket.id = ticket_comments.ticket_id
      and ticket.workspace_id = (select public.current_workspace_id())
      and (
        public.current_app_role() in ('Admin', 'Agent')
        or ticket.created_by = (select auth.uid())
      )
  )
);

drop policy if exists "Workspace members can comment on permitted tickets" on public.ticket_comments;
create policy "Workspace members can comment on permitted tickets"
on public.ticket_comments for insert to authenticated
with check (
  author_id = (select auth.uid())
  and exists (
    select 1
    from public.tickets as ticket
    where ticket.id = ticket_comments.ticket_id
      and ticket.workspace_id = (select public.current_workspace_id())
      and (
        public.current_app_role() in ('Admin', 'Agent')
        or ticket.created_by = (select auth.uid())
      )
  )
);

drop policy if exists "Users can read their own notifications" on public.notifications;
create policy "Users can read their own notifications"
on public.notifications for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists "Users can mark their own notifications as read" on public.notifications;
create policy "Users can mark their own notifications as read"
on public.notifications for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()) and read_at is not null);

revoke all on public.ticket_comments, public.notifications from public, anon, authenticated;
grant select on public.ticket_comments to authenticated;
grant insert (ticket_id, body) on public.ticket_comments to authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant usage on sequence public.ticket_comments_id_seq to authenticated;

create or replace function public.notify_ticket_comment_participants()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ticket_title text;
begin
  select title into ticket_title
  from public.tickets
  where id = new.ticket_id;

  insert into public.notifications (user_id, ticket_id, kind, dedupe_key, message)
  select distinct recipient_id,
         new.ticket_id,
         'comment',
         'comment:' || new.id::text,
         'Nuevo comentario en ' || new.ticket_id || ': ' || ticket_title
  from public.tickets as ticket
  cross join lateral unnest(array[ticket.created_by, ticket.assigned_to]) as recipients(recipient_id)
  where ticket.id = new.ticket_id
    and recipient_id is not null
    and recipient_id <> new.author_id
  on conflict (user_id, dedupe_key) do nothing;

  return new;
end;
$$;

revoke all on function public.notify_ticket_comment_participants() from public, anon, authenticated;

drop trigger if exists ticket_comments_notify_participants on public.ticket_comments;
create trigger ticket_comments_notify_participants
after insert on public.ticket_comments
for each row execute function public.notify_ticket_comment_participants();

create or replace function public.process_sla_notifications()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_count integer;
begin
  with eligible as (
    select ticket.id,
           ticket.title,
           ticket.assigned_to,
           ticket.created_by,
           ticket.workspace_id,
           ticket.sla_due_at,
           case
             when now() >= ticket.sla_due_at then 'sla_overdue'
             else 'sla_warning'
           end as kind
    from public.tickets as ticket
    where ticket.status not in ('resolved', 'closed')
      and ticket.sla_due_at is not null
      and ticket.sla_warning_at is not null
      and now() >= ticket.sla_warning_at
  ),
  recipients as (
    select eligible.*,
           unnest(
             case
               when kind = 'sla_overdue' then array_remove(
                 array[assigned_to, created_by] || array(
                   select profile.id
                   from public.profiles as profile
                   where profile.workspace_id = eligible.workspace_id
                     and profile.role = 'Admin'
                 ),
                 null
               )
               else array_remove(array[assigned_to, created_by], null)
             end
           ) as recipient_id
    from eligible
  )
  insert into public.notifications (user_id, ticket_id, kind, dedupe_key, message)
  select recipient_id,
         id,
         kind,
         kind || ':' || id || ':' || sla_due_at::text,
         case kind
           when 'sla_overdue' then 'SLA vencido para ' || id || ': ' || title
           else 'El SLA de ' || id || ' está próximo a vencer: ' || title
         end
  from recipients
  on conflict (user_id, dedupe_key) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke all on function public.process_sla_notifications() from public, anon, authenticated;
grant execute on function public.process_sla_notifications() to service_role;

create extension if not exists pg_cron with schema pg_catalog;

do $$
declare
  scheduled_job_id bigint;
begin
  select jobid into scheduled_job_id
  from cron.job
  where jobname = 'vortex-ticket-sla-notifications'
  limit 1;

  if scheduled_job_id is not null then
    perform cron.unschedule(scheduled_job_id);
  end if;

  perform cron.schedule(
    'vortex-ticket-sla-notifications',
    '* * * * *',
    'select public.process_sla_notifications();'
  );
end;
$$;

commit;
