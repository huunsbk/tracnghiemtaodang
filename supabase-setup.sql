-- AI Pose Quiz cloud storage for Supabase project MotionClass
-- Run this in Supabase SQL Editor if the automated migration has not been applied.

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
