begin;

drop function if exists public.admin_create_user_workspace(uuid, text, text, text, uuid);

create or replace function public.admin_create_user_workspace(
  p_user_id uuid,
  p_full_name text,
  p_email text,
  p_role text,
  p_created_by_admin_id uuid,
  p_new_workspace_name text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_workspace_id uuid;
  target_role text := p_role;
  creator_admin_id uuid := p_created_by_admin_id;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the trusted user-provisioning service can create workspace members';
  end if;

  if p_full_name is null or length(trim(p_full_name)) < 2 or length(trim(p_full_name)) > 100 then
    raise exception 'El nombre no es válido.';
  end if;
  if p_email is null or length(trim(p_email)) > 254 then
    raise exception 'El correo electrónico no es válido.';
  end if;

  if p_new_workspace_name is not null then
    if length(trim(p_new_workspace_name)) < 2 or length(trim(p_new_workspace_name)) > 100 then
      raise exception 'El nombre del equipo debe tener entre 2 y 100 caracteres.';
    end if;

    insert into public.workspaces (name)
    values (trim(p_new_workspace_name))
    returning id into target_workspace_id;

    target_role := 'Admin';
    creator_admin_id := null;
  else
    if p_role is null or p_role not in ('Admin', 'Agent', 'Reporter') then
      raise exception 'El rol seleccionado no es válido.';
    end if;

    select admin_profile.workspace_id
    into target_workspace_id
    from public.profiles as admin_profile
    where admin_profile.id = p_created_by_admin_id
      and admin_profile.role = 'Admin';

    if target_workspace_id is null then
      raise exception 'The user creator must be an administrator with a workspace';
    end if;
  end if;

  insert into public.profiles (id, full_name, email, role, workspace_id, created_by_admin_id)
  values (
    p_user_id,
    trim(p_full_name),
    lower(trim(p_email)),
    target_role,
    target_workspace_id,
    creator_admin_id
  );

  return target_workspace_id;
end;
$$;

revoke all on function public.admin_create_user_workspace(uuid, text, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_create_user_workspace(uuid, text, text, text, uuid, text)
  to service_role;

commit;
