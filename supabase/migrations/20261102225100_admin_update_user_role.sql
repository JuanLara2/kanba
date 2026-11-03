begin;

create or replace function public.admin_update_user_role(
  p_user_id uuid,
  p_role text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  admin_id uuid := auth.uid();
  admin_workspace_id uuid;
  admin_role text;
  target_role text;
begin
  if p_role is null or p_role not in ('Admin', 'Agent', 'Reporter') then
    raise exception 'El rol seleccionado no es válido.';
  end if;

  if admin_id is null then
    raise exception 'Solo un administrador puede cambiar roles.';
  end if;

  select profile.workspace_id
  into admin_workspace_id
  from public.profiles as profile
  where profile.id = admin_id
    and profile.role = 'Admin';

  if not found then
    raise exception 'Solo un administrador puede cambiar roles.';
  end if;

  perform 1
  from public.workspaces as workspace
  where workspace.id = admin_workspace_id
  for update;

  select profile.role
  into admin_role
  from public.profiles as profile
  where profile.id = admin_id
    and profile.workspace_id = admin_workspace_id;

  if admin_role is distinct from 'Admin' then
    raise exception 'Solo un administrador puede cambiar roles.';
  end if;

  select profile.role
  into target_role
  from public.profiles as profile
  where profile.id = p_user_id
    and profile.workspace_id = admin_workspace_id;

  if not found then
    if exists (select 1 from public.profiles where id = p_user_id) then
      raise exception 'No se puede cambiar el rol de usuarios de otro espacio de trabajo.';
    end if;
    raise exception 'El usuario no existe.';
  end if;

  if target_role in ('Admin', 'Agent')
    and p_role = 'Reporter'
    and exists (
      select 1
      from public.tickets as ticket
      where ticket.assigned_to = p_user_id
        and ticket.status <> 'closed'
    ) then
    raise exception 'Reasigna o cierra los tickets asignados antes de cambiar el rol a Reporter.';
  end if;

  if target_role = 'Admin'
    and p_role <> 'Admin'
    and not exists (
      select 1
      from public.profiles as other_admin
      where other_admin.workspace_id = admin_workspace_id
        and other_admin.role = 'Admin'
        and other_admin.id <> p_user_id
    ) then
    raise exception 'No se puede degradar al último administrador del espacio de trabajo.';
  end if;

  update public.profiles
  set role = p_role
  where id = p_user_id
    and workspace_id = admin_workspace_id;

  return p_role;
end;
$$;

revoke all on function public.admin_update_user_role(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_update_user_role(uuid, text) to authenticated;

commit;
