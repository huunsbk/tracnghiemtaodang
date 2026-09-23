import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@6.1.2";

const PROJECT_URL = Deno.env.get("SUPABASE_URL")!;
const MAIN_API = PROJECT_URL + "/functions/v1/pose-quiz-api";
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

async function apiFile(token: string, action: string, file: File) {
  const form = new FormData();
  form.append("file", file);
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
        bgm: { data: wav, name: "bgm.wav" }
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
      const tampered = original.slice(0, -1) + (last === "A" ? "B" : "A");
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
      }
      if (userA?.id) await admin.auth.admin.deleteUser(userA.id);
      if (userB?.id) await admin.auth.admin.deleteUser(userB.id);
    } catch (cleanupError) {
      console.error("QA cleanup failed", cleanupError);
    }
  }
});
