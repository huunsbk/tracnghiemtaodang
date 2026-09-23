import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import postgres from "npm:postgres@3.4.7";

const BUCKET = "pose-quiz-media";
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const SIGNED_URL_TTL = 60 * 60;
const SCHEMA_VERSION = "2026-09-23-backend-v1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const dbUrl = Deno.env.get("SUPABASE_DB_URL")!;

function getSecretKey() {
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modern) {
    try {
      const parsed = JSON.parse(modern);
      if (parsed.default) return parsed.default;
      const first = Object.values(parsed)[0];
      if (typeof first === "string") return first;
    } catch (_) {}
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("Missing Supabase secret key");
  return legacy;
}

const admin = createClient(supabaseUrl, getSecretKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const sql = postgres(dbUrl, { prepare: false, max: 1, idle_timeout: 20 });

let bootstrapPromise: Promise<void> | null = null;

const SCHEMA_SQL = `
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
`;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function fail(message: string, status = 400, code = "BAD_REQUEST") {
  return json({ ok: false, error: { code, message } }, status);
}

async function ensureBackend() {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      await sql.unsafe(SCHEMA_SQL);
      const { data: bucket, error: bucketError } = await admin.storage.getBucket(BUCKET);
      if (bucketError && !String(bucketError.message || "").toLowerCase().includes("not found")) {
        console.warn("getBucket:", bucketError.message);
      }
      if (!bucket) {
        const { error } = await admin.storage.createBucket(BUCKET, {
          public: false,
          allowedMimeTypes: ["image/*", "audio/*"],
          fileSizeLimit: "20MB",
        });
        if (error && !String(error.message || "").toLowerCase().includes("already exists")) {
          throw error;
        }
      } else {
        await admin.storage.updateBucket(BUCKET, {
          public: false,
          allowedMimeTypes: ["image/*", "audio/*"],
          fileSizeLimit: "20MB",
        });
      }
    })().catch((error) => {
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}

async function requireUser(req: Request) {
  const header = req.headers.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw Object.assign(new Error("Chưa đăng nhập."), { status: 401 });
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw Object.assign(new Error("Phiên đăng nhập không hợp lệ."), { status: 401 });
  return data.user;
}

function safeName(name: string) {
  return (name || "file")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100) || "file";
}

function assetExtension(mime: string) {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
  };
  return map[mime] || (mime.startsWith("image/") ? "img" : "audio");
}

async function uploadBytes(userId: string, bytes: Uint8Array, mime: string, fileName: string) {
  if (!mime.startsWith("image/") && !mime.startsWith("audio/")) {
    throw Object.assign(new Error("Chỉ chấp nhận tệp ảnh hoặc âm thanh."), { status: 415 });
  }
  if (bytes.byteLength > MAX_MEDIA_BYTES) {
    throw Object.assign(new Error("Tệp vượt quá giới hạn 20 MB."), { status: 413 });
  }

  const clean = safeName(fileName);
  const ext = clean.includes(".") ? clean.split(".").pop() : assetExtension(mime);
  const path = `users/${userId}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${ext}`;

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: mime, upsert: false, cacheControl: "3600" });
  if (uploadError) throw uploadError;

  const { error: metaError } = await admin.from("pose_quiz_media").insert({
    user_id: userId,
    storage_path: path,
    file_name: clean,
    mime_type: mime,
    size_bytes: bytes.byteLength,
  });
  if (metaError) {
    await admin.storage.from(BUCKET).remove([path]);
    throw metaError;
  }

  const signed = await signPaths([path]);
  return {
    storage: BUCKET,
    path,
    name: clean,
    mime,
    size: bytes.byteLength,
    url: signed.get(path) || null,
  };
}

async function uploadDataUrl(userId: string, value: string, hint: string) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(value);
  if (!match) return value;
  const mime = match[1];
  const raw = atob(match[2]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return uploadBytes(userId, bytes, mime, `${hint}.${assetExtension(mime)}`);
}

function isAsset(value: any) {
  return !!value && typeof value === "object" && typeof value.path === "string" && value.storage === BUCKET;
}

async function normalizeMedia(value: any, userId: string, hint = "asset"): Promise<any> {
  if (typeof value === "string") {
    if (value.startsWith("data:image/") || value.startsWith("data:audio/")) {
      return uploadDataUrl(userId, value, hint);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item, i) => normalizeMedia(item, userId, `${hint}_${i}`)));
  }
  if (!value || typeof value !== "object") return value;
  if (isAsset(value)) {
    return {
      storage: BUCKET,
      path: value.path,
      name: value.name || "media",
      mime: value.mime || "application/octet-stream",
      size: Number(value.size || 0),
    };
  }
  const out: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "url" || key === "signedUrl") continue;
    out[key] = await normalizeMedia(item, userId, `${hint}_${key}`);
  }
  return out;
}

function collectPaths(value: any, paths = new Set<string>()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectPaths(item, paths));
  } else if (value && typeof value === "object") {
    if (isAsset(value)) paths.add(value.path);
    Object.values(value).forEach((item) => collectPaths(item, paths));
  }
  return paths;
}

async function signPaths(paths: string[]) {
  const unique = [...new Set(paths)].filter(Boolean);
  const map = new Map<string, string>();
  if (!unique.length) return map;
  const { data, error } = await admin.storage.from(BUCKET).createSignedUrls(unique, SIGNED_URL_TTL);
  if (error) throw error;
  for (const item of data || []) {
    if (item.path && item.signedUrl) map.set(item.path, item.signedUrl);
  }
  return map;
}

function attachSignedUrls(value: any, signed: Map<string, string>): any {
  if (Array.isArray(value)) return value.map((item) => attachSignedUrls(item, signed));
  if (!value || typeof value !== "object") return value;
  if (isAsset(value)) return { ...value, url: signed.get(value.path) || null };
  const out: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) out[key] = attachSignedUrls(item, signed);
  return out;
}

async function hydrateMedia<T>(value: T): Promise<T> {
  const paths = [...collectPaths(value)];
  const signed = await signPaths(paths);
  return attachSignedUrls(value, signed);
}

async function groupAccess(userId: string, groupId: string) {
  const { data: group, error } = await admin.from("pose_quiz_groups")
    .select("id,owner_id,name,join_code")
    .eq("id", groupId)
    .maybeSingle();
  if (error) throw error;
  if (!group) return false;
  if (group.owner_id === userId) return true;
  const { data: member, error: memberError } = await admin.from("pose_quiz_group_members")
    .select("group_id")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (memberError) throw memberError;
  return !!member;
}

async function accessibleGroupIds(userId: string) {
  const [{ data: owned, error: ownedError }, { data: memberships, error: memberError }] = await Promise.all([
    admin.from("pose_quiz_groups").select("id").eq("owner_id", userId),
    admin.from("pose_quiz_group_members").select("group_id").eq("user_id", userId),
  ]);
  if (ownedError) throw ownedError;
  if (memberError) throw memberError;
  return [...new Set([
    ...(owned || []).map((x) => x.id),
    ...(memberships || []).map((x) => x.group_id),
  ])];
}

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

async function parseJson(req: Request) {
  const type = req.headers.get("content-type") || "";
  if (!type.includes("application/json")) return {};
  return await req.json();
}

async function handleAction(action: string, body: any, user: any, req: Request) {
  const userId = user.id;

  if (action === "bootstrap" || action === "health") {
    return { ok: true, version: SCHEMA_VERSION, user: { id: user.id, email: user.email } };
  }

  if (action === "media.upload") {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw Object.assign(new Error("Không tìm thấy tệp tải lên."), { status: 400 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const asset = await uploadBytes(userId, bytes, file.type || "application/octet-stream", file.name);
    return { ok: true, asset };
  }

  if (action === "lessons.list") {
    const { data, error } = await admin.from("pose_quiz_sets")
      .select("id,subject_name,title,created_at,updated_at,data")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return {
      ok: true,
      items: (data || []).map((item) => ({
        id: item.id,
        subject_name: item.subject_name,
        title: item.title,
        created_at: item.created_at,
        updated_at: item.updated_at,
        question_count: Array.isArray(item.data?.questions) ? item.data.questions.length : 0,
      })),
    };
  }

  if (action === "lessons.get") {
    const { id } = body;
    const { data, error } = await admin.from("pose_quiz_sets")
      .select("id,subject_name,title,data,created_at,updated_at")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error("Không tìm thấy bài dạy."), { status: 404 });
    return { ok: true, item: { ...data, data: await hydrateMedia(data.data) } };
  }

  if (action === "lessons.save") {
    const id = body.id || null;
    const subjectName = String(body.subject_name || body.data?.subject || "Chưa phân loại").trim() || "Chưa phân loại";
    const title = String(body.title || body.data?.title || "Bài dạy chưa đặt tên").trim() || "Bài dạy chưa đặt tên";
    const normalized = await normalizeMedia(body.data || {}, userId, "lesson");
    normalized.subject = subjectName;
    normalized.title = title;

    let saved;
    if (id) {
      const { data: existing, error: checkError } = await admin.from("pose_quiz_sets")
        .select("id").eq("id", id).eq("user_id", userId).maybeSingle();
      if (checkError) throw checkError;
      if (!existing) throw Object.assign(new Error("Không có quyền cập nhật bài dạy này."), { status: 403 });
      const { data, error } = await admin.from("pose_quiz_sets")
        .update({ subject_name: subjectName, title, data: normalized, updated_at: new Date().toISOString() })
        .eq("id", id).eq("user_id", userId)
        .select("id,subject_name,title,data,created_at,updated_at").single();
      if (error) throw error;
      saved = data;
    } else {
      const { data, error } = await admin.from("pose_quiz_sets")
        .insert({ user_id: userId, subject_name: subjectName, title, data: normalized })
        .select("id,subject_name,title,data,created_at,updated_at").single();
      if (error) throw error;
      saved = data;
    }
    return { ok: true, item: { ...saved, data: await hydrateMedia(saved.data) } };
  }

  if (action === "lessons.delete") {
    const { id } = body;
    const { data, error } = await admin.from("pose_quiz_sets")
      .delete().eq("id", id).eq("user_id", userId).select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error("Không tìm thấy bài dạy hoặc không có quyền xóa."), { status: 404 });
    return { ok: true, id };
  }

  if (action === "groups.list") {
    const ids = await accessibleGroupIds(userId);
    if (!ids.length) return { ok: true, groups: [] };
    const { data: groups, error } = await admin.from("pose_quiz_groups")
      .select("id,name,join_code,owner_id,created_at").in("id", ids).order("created_at", { ascending: false });
    if (error) throw error;
    const { data: members, error: memberError } = await admin.from("pose_quiz_group_members")
      .select("group_id").in("group_id", ids);
    if (memberError) throw memberError;
    const counts = new Map<string, number>();
    for (const row of members || []) counts.set(row.group_id, (counts.get(row.group_id) || 0) + 1);
    return {
      ok: true,
      groups: (groups || []).map((g) => ({
        ...g,
        is_owner: g.owner_id === userId,
        member_count: (counts.get(g.id) || 0) + 1,
      })),
    };
  }

  if (action === "groups.create") {
    const name = String(body.name || "").trim();
    if (!name) throw Object.assign(new Error("Tên nhóm không được để trống."), { status: 400 });
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = randomCode();
      const { data, error } = await admin.from("pose_quiz_groups")
        .insert({ owner_id: userId, name, join_code: code })
        .select("id,name,join_code,owner_id,created_at").single();
      if (!error) return { ok: true, group: { ...data, is_owner: true, member_count: 1 } };
      if (!String(error.message || "").toLowerCase().includes("duplicate")) throw error;
    }
    throw new Error("Không tạo được mã nhóm duy nhất.");
  }

  if (action === "groups.join") {
    const code = String(body.code || "").trim().toUpperCase();
    const { data: group, error } = await admin.from("pose_quiz_groups")
      .select("id,name,join_code,owner_id").eq("join_code", code).maybeSingle();
    if (error) throw error;
    if (!group) throw Object.assign(new Error("Mã nhóm không đúng."), { status: 404 });
    if (group.owner_id !== userId) {
      const { error: joinError } = await admin.from("pose_quiz_group_members")
        .upsert({ group_id: group.id, user_id: userId }, { onConflict: "group_id,user_id", ignoreDuplicates: true });
      if (joinError) throw joinError;
    }
    return { ok: true, group };
  }

  if (action === "groups.leave") {
    const groupId = body.group_id;
    const { data: group, error } = await admin.from("pose_quiz_groups")
      .select("id,owner_id").eq("id", groupId).maybeSingle();
    if (error) throw error;
    if (!group) throw Object.assign(new Error("Nhóm không tồn tại."), { status: 404 });
    if (group.owner_id === userId) throw Object.assign(new Error("Chủ nhóm không thể rời nhóm; hãy xóa nhóm nếu không còn sử dụng."), { status: 400 });
    const { error: leaveError } = await admin.from("pose_quiz_group_members")
      .delete().eq("group_id", groupId).eq("user_id", userId);
    if (leaveError) throw leaveError;
    return { ok: true };
  }

  if (action === "groups.delete") {
    const groupId = body.group_id;
    const { data: group, error } = await admin.from("pose_quiz_groups")
      .select("id,owner_id").eq("id", groupId).eq("owner_id", userId).maybeSingle();
    if (error) throw error;
    if (!group) throw Object.assign(new Error("Chỉ chủ nhóm mới được xóa nhóm."), { status: 403 });
    const { error: bankError } = await admin.from("pose_quiz_question_bank")
      .update({ visibility: "private", group_id: null, updated_at: new Date().toISOString() })
      .eq("group_id", groupId);
    if (bankError) throw bankError;
    const { error: deleteError } = await admin.from("pose_quiz_groups").delete().eq("id", groupId);
    if (deleteError) throw deleteError;
    return { ok: true };
  }

  if (action === "bank.list") {
    const groupIds = await accessibleGroupIds(userId);
    const ownPromise = admin.from("pose_quiz_question_bank")
      .select("id,user_id,subject_name,lesson_name,visibility,group_id,question,created_at,updated_at")
      .eq("user_id", userId);
    const publicPromise = admin.from("pose_quiz_question_bank")
      .select("id,user_id,subject_name,lesson_name,visibility,group_id,question,created_at,updated_at")
      .eq("visibility", "public");
    const groupPromise = groupIds.length
      ? admin.from("pose_quiz_question_bank")
          .select("id,user_id,subject_name,lesson_name,visibility,group_id,question,created_at,updated_at")
          .eq("visibility", "group").in("group_id", groupIds)
      : Promise.resolve({ data: [], error: null } as any);

    const [own, pub, grp] = await Promise.all([ownPromise, publicPromise, groupPromise]);
    if (own.error) throw own.error;
    if (pub.error) throw pub.error;
    if (grp.error) throw grp.error;
    const map = new Map<string, any>();
    for (const row of [...(own.data || []), ...(pub.data || []), ...(grp.data || [])]) map.set(row.id, row);
    const rows = [...map.values()].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    const hydrated = await hydrateMedia(rows);
    return { ok: true, items: hydrated };
  }

  if (action === "bank.save") {
    const subjectName = String(body.subject_name || "Chưa phân loại").trim() || "Chưa phân loại";
    const lessonName = String(body.lesson_name || "Chưa phân loại").trim() || "Chưa phân loại";
    const visibility = ["private", "public", "group"].includes(body.visibility) ? body.visibility : "private";
    const groupId = visibility === "group" ? body.group_id : null;
    if (visibility === "group") {
      if (!groupId || !(await groupAccess(userId, groupId))) {
        throw Object.assign(new Error("Không có quyền chia sẻ vào nhóm đã chọn."), { status: 403 });
      }
    }
    const questions = Array.isArray(body.questions) ? body.questions : [];
    if (!questions.length) throw Object.assign(new Error("Không có câu hỏi để lưu."), { status: 400 });
    const poseAssets = await normalizeMedia(body.pose_assets || {}, userId, "pose");

    const payload = [];
    for (let i = 0; i < questions.length; i++) {
      const normalized = await normalizeMedia(questions[i], userId, `question_${i + 1}`);
      normalized.audio = normalized.audio || { data: null, name: "" };
      normalized.answers = (normalized.answers || []).map((answer: any) => ({
        ...answer,
        image: answer.image || poseAssets?.[answer.pose] || null,
      }));
      payload.push({
        user_id: userId,
        subject_name: subjectName,
        lesson_name: lessonName,
        visibility,
        group_id: groupId,
        question: normalized,
        updated_at: new Date().toISOString(),
      });
    }
    const { data, error } = await admin.from("pose_quiz_question_bank")
      .insert(payload)
      .select("id");
    if (error) throw error;
    return { ok: true, count: data?.length || 0 };
  }

  if (action === "bank.delete") {
    const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];
    if (!ids.length) return { ok: true, count: 0 };
    const { data, error } = await admin.from("pose_quiz_question_bank")
      .delete().eq("user_id", userId).in("id", ids).select("id");
    if (error) throw error;
    return { ok: true, count: data?.length || 0 };
  }

  if (action === "document.import") {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw Object.assign(new Error("Không tìm thấy tệp JSON."), { status: 400 });
    const text = await file.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) {
      throw Object.assign(new Error("File JSON không hợp lệ."), { status: 400 });
    }
    const normalized = await normalizeMedia(parsed, userId, "import");
    return { ok: true, data: await hydrateMedia(normalized) };
  }

  if (action === "document.export") {
    const normalized = await normalizeMedia(body.data || {}, userId, "export");
    return { ok: true, data: normalized };
  }

  throw Object.assign(new Error("Lệnh backend không hợp lệ."), { status: 404 });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("Chỉ hỗ trợ POST.", 405, "METHOD_NOT_ALLOWED");

  try {
    const user = await requireUser(req);
    await ensureBackend();

    const url = new URL(req.url);
    const contentType = req.headers.get("content-type") || "";
    let action = url.searchParams.get("action") || "";
    let body: any = {};

    if (contentType.includes("application/json")) {
      body = await parseJson(req);
      action = action || body.action || "";
    } else if (contentType.includes("multipart/form-data")) {
      action = action || req.headers.get("x-pose-action") || "";
    }

    const result = await handleAction(action, body, user, req);
    return json(result);
  } catch (error) {
    const status = Number((error as any)?.status || 500);
    const message = (error as any)?.message || "Lỗi backend không xác định.";
    console.error("pose-quiz-api", status, message);
    return fail(message, status, status === 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR");
  }
});
