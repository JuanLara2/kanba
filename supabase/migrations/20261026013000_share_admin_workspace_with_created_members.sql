begin;

with recursive workspace_tree as (
  select
    p.id as user_id,
    p.id as root_admin_id,
    array[p.id] as path
  from public.profiles as p
  where p.role = 'Admin'
    and p.created_by_admin_id is null

  union all

  select
    member.id as user_id,
    tree.root_admin_id,
    tree.path || member.id
  from public.profiles as member
  join workspace_tree as tree
    on member.created_by_admin_id = tree.user_id
  where not member.id = any(tree.path)
),
root_workspaces as (
  select
    tree.user_id,
    root.workspace_id
  from workspace_tree as tree
  join public.profiles as root
    on root.id = tree.root_admin_id
)
update public.profiles as member
set workspace_id = root_workspaces.workspace_id
from root_workspaces
where member.id = root_workspaces.user_id
  and member.workspace_id is distinct from root_workspaces.workspace_id;

update public.tickets as ticket
set workspace_id = creator.workspace_id
from public.profiles as creator
where creator.id = ticket.created_by
  and ticket.workspace_id is distinct from creator.workspace_id;

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
  admin_workspace_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the trusted user-provisioning service can create workspace members';
  end if;

  select admin_profile.workspace_id
  into admin_workspace_id
  from public.profiles as admin_profile
  where admin_profile.id = p_created_by_admin_id
    and admin_profile.role = 'Admin';

  if admin_workspace_id is null then
    raise exception 'The user creator must be an administrator with a workspace';
  end if;

  insert into public.profiles (id, full_name, email, role, workspace_id, created_by_admin_id)
  values (
    p_user_id,
    trim(p_full_name),
    lower(trim(p_email)),
    p_role,
    admin_workspace_id,
    p_created_by_admin_id
  );

  return admin_workspace_id;
end;
$$;

revoke all on function public.admin_create_user_workspace(uuid, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_create_user_workspace(uuid, text, text, text, uuid)
  to service_role;

commit;
