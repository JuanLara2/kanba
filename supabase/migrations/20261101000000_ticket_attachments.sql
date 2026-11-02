insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ticket-attachments',
  'ticket-attachments',
  false,
  8388608,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.ticket_attachments (
  id uuid primary key default gen_random_uuid(),
  ticket_id text not null references public.tickets (id) on delete cascade,
  comment_id bigint references public.ticket_comments (id) on delete set null,
  storage_path text not null unique,
  file_name text not null check (length(trim(file_name)) between 1 and 255),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  size_bytes integer not null check (size_bytes between 1 and 8388608),
  uploaded_by uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists ticket_attachments_ticket_created_idx
  on public.ticket_attachments (ticket_id, created_at);

alter table public.ticket_attachments enable row level security;

revoke all on public.ticket_attachments from public, anon, authenticated;
grant select, insert, delete on public.ticket_attachments to authenticated;
grant update (comment_id) on public.ticket_attachments to authenticated;

drop policy if exists "Workspace members can read permitted ticket attachments" on public.ticket_attachments;
create policy "Workspace members can read permitted ticket attachments"
on public.ticket_attachments for select to authenticated
using (
  exists (
    select 1
    from public.tickets as ticket
    where ticket.id = ticket_attachments.ticket_id
      and ticket.workspace_id = (select public.current_workspace_id())
      and (storage.foldername(ticket_attachments.storage_path))[1] = ticket.workspace_id::text
      and (storage.foldername(ticket_attachments.storage_path))[2] = ticket.id
      and (
        public.current_app_role() in ('Admin', 'Agent')
        or ticket.created_by = (select auth.uid())
      )
  )
);

drop policy if exists "Users can add attachments to permitted tickets" on public.ticket_attachments;
create policy "Users can add attachments to permitted tickets"
on public.ticket_attachments for insert to authenticated
with check (
  uploaded_by = (select auth.uid())
  and exists (
    select 1
    from public.tickets as ticket
    where ticket.id = ticket_attachments.ticket_id
      and ticket.workspace_id = (select public.current_workspace_id())
      and (storage.foldername(ticket_attachments.storage_path))[1] = ticket.workspace_id::text
      and (storage.foldername(ticket_attachments.storage_path))[2] = ticket.id
      and (
        public.current_app_role() in ('Admin', 'Agent')
        or ticket.created_by = (select auth.uid())
      )
  )
  and (
    comment_id is null
    or exists (
      select 1
      from public.ticket_comments as ticket_comment
      where ticket_comment.id = ticket_attachments.comment_id
        and ticket_comment.ticket_id = ticket_attachments.ticket_id
    )
  )
);

drop policy if exists "Users can link their attachments to permitted comments" on public.ticket_attachments;
create policy "Users can link their attachments to permitted comments"
on public.ticket_attachments for update to authenticated
using (
  uploaded_by = (select auth.uid())
  and exists (
    select 1
    from public.tickets as ticket
    where ticket.id = ticket_attachments.ticket_id
      and ticket.workspace_id = (select public.current_workspace_id())
      and (storage.foldername(ticket_attachments.storage_path))[1] = ticket.workspace_id::text
      and (storage.foldername(ticket_attachments.storage_path))[2] = ticket.id
      and (
        public.current_app_role() in ('Admin', 'Agent')
        or ticket.created_by = (select auth.uid())
      )
  )
)
with check (
  uploaded_by = (select auth.uid())
  and exists (
    select 1
    from public.tickets as ticket
    where ticket.id = ticket_attachments.ticket_id
      and ticket.workspace_id = (select public.current_workspace_id())
      and (storage.foldername(ticket_attachments.storage_path))[1] = ticket.workspace_id::text
      and (storage.foldername(ticket_attachments.storage_path))[2] = ticket.id
      and (
        public.current_app_role() in ('Admin', 'Agent')
        or ticket.created_by = (select auth.uid())
      )
  )
  and (
    comment_id is null
    or exists (
      select 1
      from public.ticket_comments as ticket_comment
      where ticket_comment.id = ticket_attachments.comment_id
        and ticket_comment.ticket_id = ticket_attachments.ticket_id
    )
  )
);

drop policy if exists "Users can remove their attachments from permitted tickets" on public.ticket_attachments;
create policy "Users can remove their attachments from permitted tickets"
on public.ticket_attachments for delete to authenticated
using (
  uploaded_by = (select auth.uid())
  and exists (
    select 1
    from public.tickets as ticket
    where ticket.id = ticket_attachments.ticket_id
      and ticket.workspace_id = (select public.current_workspace_id())
      and (storage.foldername(ticket_attachments.storage_path))[1] = ticket.workspace_id::text
      and (storage.foldername(ticket_attachments.storage_path))[2] = ticket.id
      and (
        public.current_app_role() in ('Admin', 'Agent')
        or ticket.created_by = (select auth.uid())
      )
  )
);

drop policy if exists "Workspace members can read permitted ticket attachment objects" on storage.objects;
create policy "Workspace members can read permitted ticket attachment objects"
on storage.objects for select to authenticated
using (
  bucket_id = 'ticket-attachments'
  and (storage.foldername(name))[1] = (select public.current_workspace_id())::text
  and exists (
    select 1
    from public.tickets as ticket
    where ticket.id = (storage.foldername(name))[2]
      and ticket.workspace_id = (select public.current_workspace_id())
      and (
        public.current_app_role() in ('Admin', 'Agent')
        or ticket.created_by = (select auth.uid())
      )
  )
);

drop policy if exists "Users can upload permitted ticket attachment objects" on storage.objects;
create policy "Users can upload permitted ticket attachment objects"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'ticket-attachments'
  and cardinality(storage.foldername(name)) = 2
  and (storage.foldername(name))[1] = (select public.current_workspace_id())::text
  and exists (
    select 1
    from public.tickets as ticket
    where ticket.id = (storage.foldername(name))[2]
      and ticket.workspace_id = (select public.current_workspace_id())
      and (
        public.current_app_role() in ('Admin', 'Agent')
        or ticket.created_by = (select auth.uid())
      )
  )
);

drop policy if exists "Users can remove permitted ticket attachment objects" on storage.objects;
create policy "Users can remove permitted ticket attachment objects"
on storage.objects for delete to authenticated
using (
  bucket_id = 'ticket-attachments'
  and (storage.foldername(name))[1] = (select public.current_workspace_id())::text
  and exists (
    select 1
    from public.tickets as ticket
    where ticket.id = (storage.foldername(name))[2]
      and ticket.workspace_id = (select public.current_workspace_id())
      and (
        public.current_app_role() in ('Admin', 'Agent')
        or ticket.created_by = (select auth.uid())
      )
  )
);
