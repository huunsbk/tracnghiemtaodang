-- AI Pose Quiz cloud storage, question bank, subjects and sharing groups
-- Supabase project: MotionClass
-- Run this whole file in Supabase SQL Editor.

-- =========================================================
-- 1. CLOUD LESSONS
-- =========================================================
create table if not exists public.pose_quiz_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Bài dạy chưa đặt tên',
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pose_quiz_sets_user_id_idx
  on public.pose_quiz_sets(user_id);

alter table public.pose_quiz_sets enable row level security;

revoke all on table public.pose_quiz_sets from anon, authenticated;
grant select, insert, update, delete on table public.pose_quiz_sets to authenticated;

drop policy if exists "pose_quiz_select_own" on public.pose_quiz_sets;
create policy "pose_quiz_select_own"
on public.pose_quiz_sets
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "pose_quiz_insert_own" on public.pose_quiz_sets;
create policy "pose_quiz_insert_own"
on public.pose_quiz_sets
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "pose_quiz_update_own" on public.pose_quiz_sets;
create policy "pose_quiz_update_own"
on public.pose_quiz_sets
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "pose_quiz_delete_own" on public.pose_quiz_sets;
create policy "pose_quiz_delete_own"
on public.pose_quiz_sets
for delete
to authenticated
using ((select auth.uid()) = user_id);

-- =========================================================
-- 2. SHARING GROUPS
-- =========================================================
create table if not exists public.pose_quiz_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  join_code text not null unique
    default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_at timestamptz not null default now()
);

create table if not exists public.pose_quiz_group_members (
  group_id uuid not null references public.pose_quiz_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index if not exists pose_quiz_groups_owner_idx
  on public.pose_quiz_groups(owner_id);

create index if not exists pose_quiz_group_members_user_idx
  on public.pose_quiz_group_members(user_id);

alter table public.pose_quiz_groups enable row level security;
alter table public.pose_quiz_group_members enable row level security;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create or replace function private.can_access_pose_quiz_group(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.pose_quiz_groups g
    where g.id = p_group_id
      and (
        g.owner_id = (select auth.uid())
        or exists (
          select 1
          from public.pose_quiz_group_members gm
          where gm.group_id = g.id
            and gm.user_id = (select auth.uid())
        )
      )
  );
$$;

revoke all on function private.can_access_pose_quiz_group(uuid) from public;
grant execute on function private.can_access_pose_quiz_group(uuid) to authenticated;

revoke all on table public.pose_quiz_groups from anon, authenticated;
grant select, insert, update, delete on table public.pose_quiz_groups to authenticated;

drop policy if exists "pose_quiz_groups_select_member" on public.pose_quiz_groups;
create policy "pose_quiz_groups_select_member"
on public.pose_quiz_groups
for select
to authenticated
using ((select private.can_access_pose_quiz_group(id)));

drop policy if exists "pose_quiz_groups_insert_owner" on public.pose_quiz_groups;
create policy "pose_quiz_groups_insert_owner"
on public.pose_quiz_groups
for insert
to authenticated
with check (owner_id = (select auth.uid()));

drop policy if exists "pose_quiz_groups_update_owner" on public.pose_quiz_groups;
create policy "pose_quiz_groups_update_owner"
on public.pose_quiz_groups
for update
to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

drop policy if exists "pose_quiz_groups_delete_owner" on public.pose_quiz_groups;
create policy "pose_quiz_groups_delete_owner"
on public.pose_quiz_groups
for delete
to authenticated
using (owner_id = (select auth.uid()));

revoke all on table public.pose_quiz_group_members from anon, authenticated;
grant select, delete on table public.pose_quiz_group_members to authenticated;

drop policy if exists "pose_quiz_group_members_select_group" on public.pose_quiz_group_members;
create policy "pose_quiz_group_members_select_group"
on public.pose_quiz_group_members
for select
to authenticated
using ((select private.can_access_pose_quiz_group(group_id)));

drop policy if exists "pose_quiz_group_members_leave_or_owner_remove" on public.pose_quiz_group_members;
create policy "pose_quiz_group_members_leave_or_owner_remove"
on public.pose_quiz_group_members
for delete
to authenticated
using (
  user_id = (select auth.uid())
  or exists (
    select 1
    from public.pose_quiz_groups g
    where g.id = group_id
      and g.owner_id = (select auth.uid())
  )
);

create or replace function public.join_pose_quiz_group(p_code text)
returns table(group_id uuid, group_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_group_id uuid;
  v_group_name text;
  v_owner_id uuid;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select g.id, g.name, g.owner_id
    into v_group_id, v_group_name, v_owner_id
  from public.pose_quiz_groups g
  where g.join_code = upper(trim(p_code))
  limit 1;

  if v_group_id is null then
    raise exception 'INVALID_GROUP_CODE';
  end if;

  if v_owner_id <> v_user_id then
    insert into public.pose_quiz_group_members(group_id, user_id)
    values (v_group_id, v_user_id)
    on conflict (group_id, user_id) do nothing;
  end if;

  return query select v_group_id, v_group_name;
end;
$$;

revoke all on function public.join_pose_quiz_group(text) from public, anon;
grant execute on function public.join_pose_quiz_group(text) to authenticated;

-- =========================================================
-- 3. QUESTION BANK: SUBJECT -> LESSON -> QUESTION
-- =========================================================
create table if not exists public.pose_quiz_question_bank (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject_name text not null default 'Chưa phân loại',
  lesson_name text not null default 'Chưa phân loại',
  visibility text not null default 'private',
  group_id uuid references public.pose_quiz_groups(id) on delete cascade,
  question jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.pose_quiz_question_bank
  add column if not exists subject_name text not null default 'Chưa phân loại',
  add column if not exists visibility text not null default 'private',
  add column if not exists group_id uuid references public.pose_quiz_groups(id) on delete cascade;

alter table public.pose_quiz_question_bank
  drop constraint if exists pose_quiz_question_bank_visibility_check;

alter table public.pose_quiz_question_bank
  add constraint pose_quiz_question_bank_visibility_check
  check (visibility in ('private', 'public', 'group'));

alter table public.pose_quiz_question_bank
  drop constraint if exists pose_quiz_question_bank_group_visibility_check;

alter table public.pose_quiz_question_bank
  add constraint pose_quiz_question_bank_group_visibility_check
  check (
    (visibility = 'group' and group_id is not null)
    or
    (visibility in ('private', 'public') and group_id is null)
  );

create index if not exists pose_quiz_question_bank_user_lesson_idx
  on public.pose_quiz_question_bank(user_id, lesson_name);

create index if not exists pose_quiz_question_bank_subject_lesson_idx
  on public.pose_quiz_question_bank(subject_name, lesson_name);

create index if not exists pose_quiz_question_bank_group_idx
  on public.pose_quiz_question_bank(group_id)
  where group_id is not null;

alter table public.pose_quiz_question_bank enable row level security;

revoke all on table public.pose_quiz_question_bank from anon, authenticated;
grant select, insert, update, delete on table public.pose_quiz_question_bank to authenticated;

drop policy if exists "pose_quiz_bank_select_own" on public.pose_quiz_question_bank;
drop policy if exists "pose_quiz_bank_select_accessible" on public.pose_quiz_question_bank;
create policy "pose_quiz_bank_select_accessible"
on public.pose_quiz_question_bank
for select
to authenticated
using (
  user_id = (select auth.uid())
  or visibility = 'public'
  or (
    visibility = 'group'
    and group_id is not null
    and (select private.can_access_pose_quiz_group(group_id))
  )
);

drop policy if exists "pose_quiz_bank_insert_own" on public.pose_quiz_question_bank;
create policy "pose_quiz_bank_insert_own"
on public.pose_quiz_question_bank
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and (
    visibility in ('private', 'public')
    or (
      visibility = 'group'
      and group_id is not null
      and (select private.can_access_pose_quiz_group(group_id))
    )
  )
);

drop policy if exists "pose_quiz_bank_update_own" on public.pose_quiz_question_bank;
create policy "pose_quiz_bank_update_own"
on public.pose_quiz_question_bank
for update
to authenticated
using (user_id = (select auth.uid()))
with check (
  user_id = (select auth.uid())
  and (
    visibility in ('private', 'public')
    or (
      visibility = 'group'
      and group_id is not null
      and (select private.can_access_pose_quiz_group(group_id))
    )
  )
);

drop policy if exists "pose_quiz_bank_delete_own" on public.pose_quiz_question_bank;
create policy "pose_quiz_bank_delete_own"
on public.pose_quiz_question_bank
for delete
to authenticated
using (user_id = (select auth.uid()));
