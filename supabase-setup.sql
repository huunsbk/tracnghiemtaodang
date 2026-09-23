-- AI Pose Quiz backend schema fallback
-- Schema is applied separately from the Edge Function runtime.
-- pose-quiz-api only verifies/creates the private Storage bucket at runtime.
-- Use this file as the canonical schema definition for restore/synchronization.
-- IMPORTANT: browser roles anon/authenticated are deliberately revoked from business tables.


create table if not exists public.pose_quiz_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject_name text not null default 'Chưa phân loại',
  title text not null default 'Bài dạy chưa đặt tên',
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pose_quiz_sets
  add column if not exists subject_name text not null default 'Chưa phân loại';

create index if not exists pose_quiz_sets_user_id_idx
  on public.pose_quiz_sets(user_id);

create table if not exists public.pose_quiz_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  join_code text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists pose_quiz_groups_owner_idx
  on public.pose_quiz_groups(owner_id);

create table if not exists public.pose_quiz_group_members (
  group_id uuid not null references public.pose_quiz_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index if not exists pose_quiz_group_members_user_idx
  on public.pose_quiz_group_members(user_id);

create table if not exists public.pose_quiz_question_bank (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject_name text not null default 'Chưa phân loại',
  lesson_name text not null default 'Chưa phân loại',
  visibility text not null default 'private',
  group_id uuid references public.pose_quiz_groups(id),
  question jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pose_quiz_question_bank
  add column if not exists subject_name text not null default 'Chưa phân loại',
  add column if not exists visibility text not null default 'private',
  add column if not exists group_id uuid,
  add column if not exists updated_at timestamptz not null default now();

alter table public.pose_quiz_question_bank
  drop constraint if exists pose_quiz_question_bank_visibility_check;

alter table public.pose_quiz_question_bank
  add constraint pose_quiz_question_bank_visibility_check
  check (visibility in ('private', 'public', 'group'));

create index if not exists pose_quiz_question_bank_user_idx
  on public.pose_quiz_question_bank(user_id);

create index if not exists pose_quiz_question_bank_subject_lesson_idx
  on public.pose_quiz_question_bank(subject_name, lesson_name);

create index if not exists pose_quiz_question_bank_group_idx
  on public.pose_quiz_question_bank(group_id)
  where group_id is not null;

create table if not exists public.pose_quiz_media (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists pose_quiz_media_user_idx
  on public.pose_quiz_media(user_id);

alter table public.pose_quiz_sets enable row level security;
alter table public.pose_quiz_groups enable row level security;
alter table public.pose_quiz_group_members enable row level security;
alter table public.pose_quiz_question_bank enable row level security;
alter table public.pose_quiz_media enable row level security;

revoke all on table public.pose_quiz_sets from anon, authenticated;
revoke all on table public.pose_quiz_groups from anon, authenticated;
revoke all on table public.pose_quiz_group_members from anon, authenticated;
revoke all on table public.pose_quiz_question_bank from anon, authenticated;
revoke all on table public.pose_quiz_media from anon, authenticated;

grant all on table public.pose_quiz_sets to service_role;
grant all on table public.pose_quiz_groups to service_role;
grant all on table public.pose_quiz_group_members to service_role;
grant all on table public.pose_quiz_question_bank to service_role;
grant all on table public.pose_quiz_media to service_role;


-- Media files themselves are stored in the private Storage bucket:
--   pose-quiz-media
-- The Edge Function creates/updates that bucket automatically.
-- Do not make this bucket public.
