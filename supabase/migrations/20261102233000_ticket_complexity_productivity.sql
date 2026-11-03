begin;

alter table public.tickets
  add column if not exists complexity_score smallint not null default 1;

alter table public.tickets
  drop constraint if exists tickets_complexity_score_range;

alter table public.tickets
  add constraint tickets_complexity_score_range
  check (complexity_score between 1 and 10);

alter table public.ticket_status_history
  add column if not exists assigned_to_at_change uuid;

grant insert (complexity_score) on public.tickets to authenticated;
grant update (complexity_score) on public.tickets to authenticated;

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

  if old.status = 'closed'
    and new.complexity_score is distinct from old.complexity_score then
    raise exception 'La complejidad no se puede cambiar después de cerrar el ticket.';
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

drop policy if exists "Users can create tickets only in their workspace" on public.tickets;
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
      and checklist = '[]'::jsonb
      and complexity_score = 1
    )
  )
);

create or replace function public.record_ticket_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    insert into public.ticket_status_history (
      ticket_id,
      from_status,
      to_status,
      changed_by,
      assigned_to_at_change
    )
    values (
      new.id,
      old.status,
      new.status,
      (select auth.uid()),
      new.assigned_to
    );
  end if;
  return new;
end;
$$;

commit;
