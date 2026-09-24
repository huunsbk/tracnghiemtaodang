import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@6.1.2";

const PROJECT_URL = Deno.env.get("SUPABASE_URL")!;
const MAIN_API = PROJECT_URL + "/functions/v1/pose-quiz-api";
const RECOVERY_API = PROJECT_URL + "/functions/v1/pose-quiz-recovery";
const BUCKET = "pose-quiz-media";
const JWKS = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));
const cors = { "Content-Type": "application/json; charset=utf-8" };

function secretKey() {
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modern) {
    try {
      const parsed = JSON.parse(modern);
      if (parsed.default) return parsed.default;
      const first = Object.values(parsed)[0];
      if (typeof first === "string") return first;
    } catch {}
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("Missing secret key");
  return legacy;
}

function publishableKey() {
  const modern = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (modern) {
    try {
      const parsed = JSON.parse(modern);
      if (parsed.default) return parsed.default;
      const first = Object.values(parsed)[0];
      if (typeof first === "string") return first;
    } catch {}
  }
  const legacy = Deno.env.get("SUPABASE_ANON_KEY");
  if (!legacy) throw new Error("Missing publishable key");
  return legacy;
}

const admin = createClient(PROJECT_URL, secretKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const pubKey = publishableKey();

async function verifyGitHubOidc(req: Request) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Missing GitHub OIDC token");
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: "https://token.actions.githubusercontent.com",
    audience: "pose-quiz-qa",
  });
  if (payload.repository !== "huunsbk/tracnghiemtaodang") throw new Error("Wrong repository");
  if (payload.ref !== "refs/heads/supabase-auth-cloud") throw new Error("Wrong branch");
  if (!["push", "workflow_dispatch", "pull_request"].includes(String(payload.event_name || ""))) {
    throw new Error("Unsupported GitHub event");
  }
  return payload;
}

async function signIn(email: string, password: string) {
  const client = createClient(PROJECT_URL, pubKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw error || new Error("No test session");
  return data.session.access_token;
}

async function api(token: string, action: string, payload: any = {}) {
  const res = await fetch(MAIN_API + "?action=" + encodeURIComponent(action), {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      apikey: pubKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(action + ": " + (data?.error?.message || res.statusText));
  }
  return data;
}

async function recovery(action: string, payload: any = {}) {
  const res = await fetch(RECOVERY_API, {
    method: "POST",
    headers: { apikey: pubKey, "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    const err: any = new Error(action + ": " + (data?.error?.message || res.statusText));
    err.status = res.status;
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

function qaB64(bytes: Uint8Array) {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function qaRecoveryState(uid: string, purpose: string) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secretKey()),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const payload = qaB64(new TextEncoder().encode(JSON.stringify({
    purpose, uid, exp: Math.floor(Date.now() / 1000) + 600, nonce: crypto.randomUUID()
  })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return payload + "." + qaB64(sig);
}

async function apiFile(token: string, action: string, file: File, payload: any = {}) {
  const form = new FormData();
  form.append("file", file);
  if (payload && Object.keys(payload).length) form.append("payload", JSON.stringify(payload));
  const res = await fetch(MAIN_API + "?action=" + encodeURIComponent(action), {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      apikey: pubKey,
      "x-pose-action": action,
    },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(action + ": " + (data?.error?.message || res.statusText));
  }
  return data;
}

function assert(condition: any, message: string) {
  if (!condition) throw new Error("ASSERT: " + message);
}

function hasUrlDeep(value: any): boolean {
  if (Array.isArray(value)) return value.some(hasUrlDeep);
  if (!value || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, "url")) return true;
  return Object.values(value).some(hasUrlDeep);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: false, error: "POST only" }), { status: 405, headers: cors });

  const report: Array<{ name: string; ok: boolean; detail?: string }> = [];
  let userA: any = null;
  let userB: any = null;

  const step = async (name: string, fn: () => Promise<any>) => {
    try {
      const value = await fn();
      report.push({ name, ok: true });
      return value;
    } catch (error) {
      report.push({ name, ok: false, detail: String((error as any)?.message || error) });
      throw error;
    }
  };

  try {
    const oidc = await verifyGitHubOidc(req);
    report.push({ name: "github_oidc", ok: true, detail: String(oidc.run_id || "") });

    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const emailA = `posequiz.qa.a.${suffix}@example.com`;
    const emailB = `posequiz.qa.b.${suffix}@example.com`;
    const password = "Qa!" + crypto.randomUUID() + "9x";

    userA = await step("create_test_user_a", async () => {
      const { data, error } = await admin.auth.admin.createUser({ email: emailA, password, email_confirm: true });
      if (error || !data.user) throw error || new Error("User A not created");
      return data.user;
    });
    userB = await step("create_test_user_b", async () => {
      const { data, error } = await admin.auth.admin.createUser({ email: emailB, password, email_confirm: true });
      if (error || !data.user) throw error || new Error("User B not created");
      return data.user;
    });

    const tokenA = await step("sign_in_user_a", () => signIn(emailA, password));
    const tokenB = await step("sign_in_user_b", () => signIn(emailB, password));

    await step("backend_bootstrap", async () => {
      const r = await api(tokenA, "bootstrap");
      assert(r.ok === true, "bootstrap failed");
    });


    await step("smart_paste_import_preview", async () => {
      const text = [
        "Câu 1. Thiết bị nào dùng để nhập văn bản?",
        "A. Chuột",
        "B. Bàn phím",
        "C. Loa",
        "D. Máy in",
        "Đáp án: B",
        "",
        "Câu 2. 2 + 3 bằng bao nhiêu?",
        "A. 4",
        "B. 5",
        "C. 6",
        "D. 7",
        "Đáp án: B",
      ].join("\n");
      const r = await api(tokenA, "questions.import.preview", {
        text,
        pose_mapping: {
          A: "RAISE_LEFT",
          B: "RAISE_RIGHT",
          C: "BOTH_UP",
          D: "CROSS_ARMS",
        },
      });
      assert(r.total === 2 && r.valid_count === 2 && r.invalid_count === 0, "smart paste counts wrong");
      assert(r.items?.[0]?.question?.answers?.[1]?.isCorrect === true, "smart paste correct answer wrong");
      assert(r.items?.[0]?.question?.answers?.[1]?.pose === "RAISE_RIGHT", "smart paste pose mapping wrong");
    });

    await step("tabular_paste_import_preview_and_error", async () => {
      const text = [
        "Câu hỏi\tA\tB\tC\tD\tĐáp án",
        "Thiết bị xuất?\tMàn hình\tBàn phím\tChuột\tMicro\tA",
        "Câu lỗi\t1\t2\t3\t4\tE",
      ].join("\n");
      const r = await api(tokenA, "questions.import.preview", { text });
      assert(r.total === 2 && r.valid_count === 1 && r.invalid_count === 1, "tabular preview validation counts wrong");
      assert((r.items?.[1]?.errors || []).length > 0, "invalid row has no error");
    });

    await step("excel_import_preview", async () => {
      const binary = atob("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");
      const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
      const file = new File([bytes], "questions.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const r = await apiFile(tokenA, "questions.import.preview", file, {
        pose_mapping: {
          A: "RAISE_LEFT",
          B: "RAISE_RIGHT",
          C: "BOTH_UP",
          D: "CROSS_ARMS",
        },
      });
      assert(r.source === "excel", "excel source not reported");
      assert(r.total === 2 && r.valid_count === 2, "excel preview counts wrong");
      assert(r.items?.[1]?.question?.answers?.[1]?.isCorrect === true, "excel correct answer wrong");
    });

    await step("account_profile_get", async () => {
      const r = await api(tokenA, "account.profile.get");
      assert(r.profile?.email === emailA, "profile email mismatch");
      assert(r.profile?.user_id === userA.id, "profile user id mismatch");
    });

    await step("account_profile_update", async () => {
      const r = await api(tokenA, "account.profile.update", {
        display_name: "Giáo viên QA",
        school_name: "Trường QA",
      });
      assert(r.profile?.display_name === "Giáo viên QA", "display name not saved");
      assert(r.profile?.school_name === "Trường QA", "school name not saved");
    });

    await step("account_avatar_upload_and_delete", async () => {
      const file = new File([Uint8Array.from([137,80,78,71,13,10,26,10])], "avatar.png", { type: "image/png" });
      const uploaded = await apiFile(tokenA, "account.avatar.upload", file);
      assert(uploaded.profile?.avatar_path, "avatar path missing");
      assert(uploaded.profile?.avatar_url, "avatar signed url missing");
      const removed = await api(tokenA, "account.avatar.delete");
      assert(!removed.profile?.avatar_path, "avatar path not cleared");
    });

    await step("profile_table_direct_access_is_blocked", async () => {
      const res = await fetch(PROJECT_URL + "/rest/v1/pose_quiz_profiles?select=user_id&limit=1", {
        headers: { apikey: pubKey, Authorization: "Bearer " + tokenA },
      });
      assert(res.status === 401 || res.status === 403, "browser can query profile table directly");
    });

    const recoveryCaps = await step("recovery_capabilities", async () => {
      const r = await recovery("capabilities");
      assert(typeof r.email === "boolean" && typeof r.sms === "boolean", "capabilities malformed");
      return r;
    });

    await step("recovery_email_nonexistent_is_generic", async () => {
      const r = await recovery("email.begin", {
        email: "missing." + suffix + "@example.com",
        redirect_to: "https://rawcdn.githack.com/huunsbk/tracnghiemtaodang/qa/index.html",
      });
      assert(r.ok === true, "nonexistent email recovery should be generic success");
    });

    if (recoveryCaps.sms === false) {
      await step("sms_unconfigured_is_reported", async () => {
        let rejected = false;
        try {
          await recovery("phone.begin", { phone: "+12025550123" });
        } catch (err) {
          rejected = (err as any)?.status === 503;
        }
        assert(rejected, "SMS unavailable but phone recovery was not rejected clearly");
      });
    } else {
      report.push({ name: "sms_provider_enabled", ok: true, detail: "Provider enabled; real handset OTP requires manual test number." });
    }

    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9WlZkAAAAASUVORK5CYII=";
    const wav = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
    const lessonData = {
      subject: "Tin học QA",
      title: "Bài backend QA",
      bankVisibility: "private",
      bankGroupId: "",
      timeLimit: 20,
      checkInterval: 3,
      numAnswers: 4,
      poseAssets: { NONE: png, RAISE_LEFT: null, RAISE_RIGHT: null, BOTH_UP: null, CROSS_ARMS: null },
      questions: [{
        id: 1,
        text: "Câu backend QA",
        image: png,
        audio: { data: wav, name: "question.wav" },
        answers: [
          { text: "A", pose: "NONE", isCorrect: true, image: null },
          { text: "B", pose: "RAISE_LEFT", isCorrect: false, image: null },
          { text: "C", pose: "RAISE_RIGHT", isCorrect: false, image: null },
          { text: "D", pose: "BOTH_UP", isCorrect: false, image: null }
        ]
      }],
      audio: {
        correct: { data: wav, name: "correct.wav" },
        wrong: { data: wav, name: "wrong.wav" },
        bgm: { data: wav, name: "bgm.wav" },
        bgmVolume: 0.25,
        feedbackVolume: 0.8,
        questionVolume: 0.9,
        defaultFeedback: true
      },
      theme: {
        background: png,
        overlay: 0.62,
        fit: "cover"
      }
    };

    const savedLesson = await step("lesson_save_with_media_migration", async () => {
      const r = await api(tokenA, "lessons.save", {
        subject_name: "Tin học QA",
        title: "Bài backend QA",
        data: lessonData,
      });
      assert(r.item?.id, "lesson id missing");
      assert(r.item.data?.questions?.[0]?.image?.path, "question image not migrated to Storage");
      assert(r.item.data?.questions?.[0]?.image?.url, "question image signed URL missing");
      assert(r.item.data?.questions?.[0]?.audio?.data?.path, "question audio not migrated");
      assert(r.item.data?.audio?.bgm?.data?.path, "BGM not migrated");
      assert(r.item.data?.audio?.bgmVolume === 0.25, "BGM volume not preserved");
      assert(r.item.data?.audio?.feedbackVolume === 0.8, "feedback volume not preserved");
      assert(r.item.data?.theme?.background?.path, "lesson background not migrated");
      assert(r.item.data?.theme?.overlay === 0.62, "background overlay not preserved");
      return r.item;
    });

    await step("lesson_list", async () => {
      const r = await api(tokenA, "lessons.list");
      assert(r.items.some((x: any) => x.id === savedLesson.id), "saved lesson absent");
    });

    await step("lesson_get", async () => {
      const r = await api(tokenA, "lessons.get", { id: savedLesson.id });
      assert(r.item?.data?.questions?.[0]?.image?.url, "signed URL absent on get");
    });

    await step("game_backend_scores_correct_answer", async () => {
      const started = await api(tokenA, "game.start", { data: lessonData });
      assert(started.game_token && started.total === 1, "game start token/total invalid");
      const checked = await api(tokenA, "game.check", {
        game_token: started.game_token,
        detected_pose: "NONE",
      });
      assert(checked.correct === true, "correct pose was not accepted");
      assert(checked.score === 1, "backend did not increment score");
      assert(checked.finished === true, "single-question game should finish");
    });

    await step("game_backend_scores_wrong_answer", async () => {
      const started = await api(tokenA, "game.start", { data: lessonData });
      const checked = await api(tokenA, "game.check", {
        game_token: started.game_token,
        detected_pose: "RAISE_LEFT",
      });
      assert(checked.correct === false, "wrong pose was accepted");
      assert(checked.score === 0, "backend incremented score for wrong answer");
    });

    await step("game_token_tamper_is_rejected", async () => {
      const started = await api(tokenA, "game.start", { data: lessonData });
      const original = String(started.game_token);
      const last = original.slice(-1);
      const tampered = original.slice(0, -1) + (last === "A" ? "Q" : "A");
      let rejected = false;
      try {
        await api(tokenA, "game.check", {
          game_token: tampered,
          detected_pose: "NONE",
        });
      } catch {
        rejected = true;
      }
      assert(rejected, "tampered game token was accepted");
    });

    await step("direct_media_upload", async () => {
      const file = new File([Uint8Array.from([137,80,78,71,13,10,26,10])], "qa.png", { type: "image/png" });
      const r = await apiFile(tokenA, "media.upload", file);
      assert(r.asset?.path && r.asset?.url, "media asset missing path/url");
    });

    await step("storage_bucket_is_private", async () => {
      const { data, error } = await admin.storage.getBucket(BUCKET);
      if (error) throw error;
      assert(data?.public === false, "media bucket became public");
    });

    await step("authenticated_direct_table_access_is_blocked", async () => {
      const res = await fetch(PROJECT_URL + "/rest/v1/pose_quiz_sets?select=id&limit=1", {
        headers: {
          apikey: pubKey,
          Authorization: "Bearer " + tokenA,
        },
      });
      assert(res.status === 401 || res.status === 403, "authenticated browser can query business table directly");
    });

    await step("authenticated_direct_storage_upload_is_blocked", async () => {
      const res = await fetch(PROJECT_URL + "/storage/v1/object/" + BUCKET + "/users/" + userA.id + "/qa-bypass.png", {
        method: "POST",
        headers: {
          apikey: pubKey,
          Authorization: "Bearer " + tokenA,
          "Content-Type": "image/png",
        },
        body: Uint8Array.from([137,80,78,71,13,10,26,10]),
      });
      assert(res.status === 400 || res.status === 401 || res.status === 403, "authenticated browser can upload Storage directly");
    });

    const group = await step("group_create", async () => {
      const r = await api(tokenA, "groups.create", { name: "Nhóm backend QA" });
      assert(r.group?.join_code?.length === 8, "join code invalid");
      return r.group;
    });

    await step("group_join_by_code", async () => {
      await api(tokenB, "groups.join", { code: group.join_code });
      const r = await api(tokenB, "groups.list");
      assert(r.groups.some((g: any) => g.id === group.id), "joined group not visible");
    });

    const privateSave = await step("bank_private_save", () => api(tokenA, "bank.save", {
      subject_name: "Tin học QA", lesson_name: "Bài QA", visibility: "private",
      questions: [lessonData.questions[0]], pose_assets: savedLesson.data.poseAssets
    }));
    const publicSave = await step("bank_public_save", () => api(tokenA, "bank.save", {
      subject_name: "Tin học QA", lesson_name: "Bài QA", visibility: "public",
      questions: [{ ...lessonData.questions[0], text: "Câu công khai QA" }], pose_assets: savedLesson.data.poseAssets
    }));
    const groupSave = await step("bank_group_save", () => api(tokenA, "bank.save", {
      subject_name: "Tin học QA", lesson_name: "Bài QA", visibility: "group", group_id: group.id,
      questions: [{ ...lessonData.questions[0], text: "Câu nhóm QA" }], pose_assets: savedLesson.data.poseAssets
    }));
    assert(privateSave.count === 1 && publicSave.count === 1 && groupSave.count === 1, "bank insert counts wrong");

    let visibleToB: any[] = [];
    await step("bank_visibility_for_member", async () => {
      const r = await api(tokenB, "bank.list");
      visibleToB = r.items || [];
      assert(visibleToB.some((x: any) => x.visibility === "public" && x.user_id === userA.id), "public question hidden");
      assert(visibleToB.some((x: any) => x.visibility === "group" && x.group_id === group.id), "group question hidden");
      assert(!visibleToB.some((x: any) => x.visibility === "private" && x.user_id === userA.id), "private question leaked");
    });

    await step("bank_filters_are_backend_enforced", async () => {
      const r = await api(tokenB, "bank.list", {
        subject_name: "Tin học QA",
        lesson_name: "Bài QA",
        source: "PUBLIC",
        search: "công khai",
      });
      assert((r.items || []).length >= 1, "public filter returned nothing");
      assert((r.items || []).every((x: any) =>
        x.subject_name === "Tin học QA" &&
        x.lesson_name === "Bài QA" &&
        x.visibility === "public" &&
        String(x.question?.text || "").toLocaleLowerCase("vi").includes("công khai")
      ), "backend bank filters returned a mismatched row");
    });

    await step("bank_resolve_checks_access", async () => {
      const allowedIds = visibleToB
        .filter((x: any) => x.user_id === userA.id)
        .map((x: any) => x.id)
        .slice(0, 2);
      const resolved = await api(tokenB, "bank.resolve", { ids: allowedIds });
      assert((resolved.questions || []).length === allowedIds.length, "accessible bank questions did not resolve");

      const ownerRows = await api(tokenA, "bank.list", { source: "MINE" });
      const privateRow = (ownerRows.items || []).find((x: any) => x.visibility === "private" && x.user_id === userA.id);
      assert(privateRow?.id, "private owner row missing for access test");
      let rejected = false;
      try {
        await api(tokenB, "bank.resolve", { ids: [privateRow.id] });
      } catch {
        rejected = true;
      }
      assert(rejected, "member resolved another user's private question");
    });

    await step("bank_non_owner_cannot_delete", async () => {
      const ids = visibleToB.filter((x: any) => x.user_id === userA.id).map((x: any) => x.id);
      const r = await api(tokenB, "bank.delete", { ids });
      assert(r.count === 0, "non-owner deleted shared questions");
    });

    await step("document_export_strips_signed_urls", async () => {
      const r = await api(tokenA, "document.export", { data: savedLesson.data });
      assert(!hasUrlDeep(r.data), "export persisted transient signed URL");
    });

    await step("document_import_migrates_legacy_media", async () => {
      const file = new File([JSON.stringify(lessonData)], "legacy.json", { type: "application/json" });
      const r = await apiFile(tokenA, "document.import", file);
      assert(r.data?.questions?.[0]?.image?.path, "legacy image was not migrated");
      assert(r.data?.questions?.[0]?.audio?.data?.path, "legacy audio was not migrated");
    });

    await step("group_delete_makes_questions_private", async () => {
      await api(tokenA, "groups.delete", { group_id: group.id });
      const afterB = await api(tokenB, "bank.list");
      assert(!(afterB.items || []).some((x: any) => x.group_id === group.id), "deleted group content still visible to former member");
      const afterA = await api(tokenA, "bank.list");
      assert((afterA.items || []).some((x: any) => x.question?.text === "Câu nhóm QA" && x.visibility === "private" && !x.group_id), "group question was not preserved as private");
    });

    await step("lesson_delete", async () => {
      await api(tokenA, "lessons.delete", { id: savedLesson.id });
      const r = await api(tokenA, "lessons.list");
      assert(!r.items.some((x: any) => x.id === savedLesson.id), "lesson still present");
    });

    await step("account_password_wrong_current_is_rejected", async () => {
      let rejected = false;
      try {
        await api(tokenA, "account.password.change", {
          current_password: "DefinitelyWrong!123",
          new_password: "QaNew!" + suffix + "8A",
        });
      } catch {
        rejected = true;
      }
      assert(rejected, "wrong current password was accepted");
    });

    const changedPassword = "QaNew!" + suffix + "8A";
    await step("account_password_change_and_relogin", async () => {
      await api(tokenA, "account.password.change", {
        current_password: password,
        new_password: changedPassword,
      });
      const nextToken = await signIn(emailA, changedPassword);
      assert(!!nextToken, "new password cannot sign in");
      let oldRejected = false;
      try { await signIn(emailA, password); } catch { oldRejected = true; }
      assert(oldRejected, "old password still signs in");
    });

    await step("email_recovery_signed_state_resets_password", async () => {
      const state = await qaRecoveryState(userB.id, "email_password_recovery");
      const resetPassword = "QaReset!" + suffix + "8B";
      await recovery("email.complete", { recovery_state: state, new_password: resetPassword });
      const nextToken = await signIn(emailB, resetPassword);
      assert(!!nextToken, "recovery password cannot sign in");
    });

    await step("email_recovery_tampered_state_is_rejected", async () => {
      const state = await qaRecoveryState(userB.id, "email_password_recovery");
      const tampered = state.slice(0, -1) + (state.endsWith("A") ? "B" : "A");
      let rejected = false;
      try {
        await recovery("email.complete", { recovery_state: tampered, new_password: "QaTamper!123" });
      } catch {
        rejected = true;
      }
      assert(rejected, "tampered recovery state was accepted");
    });

    return new Response(JSON.stringify({ ok: true, report }, null, 2), { status: 200, headers: cors });
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: String((error as any)?.message || error),
      report,
    }, null, 2), { status: 500, headers: cors });
  } finally {
    try {
      const ids = [userA?.id, userB?.id].filter(Boolean);
      if (ids.length) {
        const { data: media } = await admin.from("pose_quiz_media").select("storage_path").in("user_id", ids);
        const paths = (media || []).map((m: any) => m.storage_path).filter(Boolean);
        if (paths.length) await admin.storage.from(BUCKET).remove(paths);
        await admin.from("pose_quiz_question_bank").delete().in("user_id", ids);
        await admin.from("pose_quiz_sets").delete().in("user_id", ids);
        await admin.from("pose_quiz_group_members").delete().in("user_id", ids);
        await admin.from("pose_quiz_groups").delete().in("owner_id", ids);
        await admin.from("pose_quiz_media").delete().in("user_id", ids);
        await admin.from("pose_quiz_profiles").delete().in("user_id", ids);
      }
      if (userA?.id) await admin.auth.admin.deleteUser(userA.id);
      if (userB?.id) await admin.auth.admin.deleteUser(userB.id);
    } catch (cleanupError) {
      console.error("QA cleanup failed", cleanupError);
    }
  }
});
