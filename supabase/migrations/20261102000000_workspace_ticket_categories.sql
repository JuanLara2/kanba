begin;

alter table public.tickets
  drop constraint if exists tickets_category_valid;

create table if not exists public.ticket_categories (
  workspace_id uuid not null default public.current_workspace_id()
    references public.workspaces (id) on delete cascade,
  name text not null
    check (
      name = btrim(name)
      and length(name) between 1 and 50
      and name !~ '[[:cntrl:]]'
    ),
  created_by uuid default auth.uid()
    references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint ticket_categories_workspace_name_key unique (workspace_id, name)
);

create unique index if not exists ticket_categories_workspace_name_ci_idx
  on public.ticket_categories (workspace_id, lower(name));

alter table public.ticket_categories
  replica identity using index ticket_categories_workspace_name_key;

insert into public.ticket_categories (workspace_id, name)
select workspace.id, category.name
from public.workspaces as workspace
cross join (
  values
    ('Soporte técnico'),
    ('Accesos'),
    ('Incidente'),
    ('Solicitud de servicio'),
    ('Consulta'),
    ('Mejora'),
    ('Nómina y Pagos')
) as category(name)
on conflict (workspace_id, name) do nothing;

alter table public.tickets
  add constraint tickets_workspace_category_fkey
  foreign key (workspace_id, category)
  references public.ticket_categories (workspace_id, name)
  on update cascade
  on delete restrict
  not valid;

alter table public.tickets
  validate constraint tickets_workspace_category_fkey;

alter table public.ticket_categories enable row level security;

revoke all on public.ticket_categories from public, anon, authenticated;
grant select, delete on public.ticket_categories to authenticated;
grant insert (name) on public.ticket_categories to authenticated;

drop policy if exists "Workspace members can read ticket categories" on public.ticket_categories;
create policy "Workspace members can read ticket categories"
on public.ticket_categories for select to authenticated
using (workspace_id = (select public.current_workspace_id()));

drop policy if exists "Admins can create workspace ticket categories" on public.ticket_categories;
create policy "Admins can create workspace ticket categories"
on public.ticket_categories for insert to authenticated
with check (
  workspace_id = (select public.current_workspace_id())
  and created_by = (select auth.uid())
  and public.current_app_role() = 'Admin'
);

drop policy if exists "Admins can delete workspace ticket categories" on public.ticket_categories;
create policy "Admins can delete workspace ticket categories"
on public.ticket_categories for delete to authenticated
using (
  workspace_id = (select public.current_workspace_id())
  and public.current_app_role() = 'Admin'
);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'ticket_categories'
    ) then
    alter publication supabase_realtime add table public.ticket_categories;
  end if;
end;
$$;

commit;
