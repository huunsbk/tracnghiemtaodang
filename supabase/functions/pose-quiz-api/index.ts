import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import ExcelJS from "npm:exceljs@4.4.0";
import { Buffer } from "node:buffer";

const BUCKET = "pose-quiz-media";
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_IMPORT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_QUESTIONS = 500;
const SIGNED_URL_TTL = 60 * 60;
const SCHEMA_VERSION = "2026-09-24-import-theme-secure-excel-v1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;

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

function getPublicKey() {
  const key = Deno.env.get("SUPABASE_ANON_KEY");
  if (!key) throw new Error("Missing Supabase public key");
  return key;
}

function bearerToken(req: Request) {
  return (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

async function authUserRequest(req: Request, path: string, body: any) {
  const token = bearerToken(req);
  if (!token) throw Object.assign(new Error("Chưa đăng nhập."), { status: 401 });
  const response = await fetch(`${supabaseUrl}/auth/v1/${path}`, {
    method: path === "user" ? "PUT" : "POST",
    headers: {
      apikey: getPublicKey(),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let payload: any = {};
  try { payload = await response.json(); } catch (_) {}
  if (!response.ok) {
    const message = payload?.msg || payload?.message || payload?.error_description || payload?.error || "Xác thực không thành công.";
    const err: any = new Error(message);
    err.status = response.status;
    err.authCode = payload?.code || payload?.error_code || null;
    throw err;
  }
  return payload;
}

function normalizePhone(value: string) {
  let phone = String(value || "").trim().replace(/[\s().-]/g, "");
  if (phone.startsWith("00")) phone = "+" + phone.slice(2);
  if (phone.startsWith("0")) phone = "+84" + phone.slice(1);
  if (!phone.startsWith("+")) throw Object.assign(new Error("Số điện thoại cần ở dạng 0xxxxxxxxx hoặc +mã_quốc_gia."), { status: 400 });
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw Object.assign(new Error("Số điện thoại không hợp lệ."), { status: 400 });
  }
  return phone;
}

async function ensureProfile(userId: string) {
  const { data, error } = await admin.from("pose_quiz_profiles")
    .upsert({ user_id: userId, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
    .select("user_id,display_name,school_name,avatar_path,created_at,updated_at")
    .single();
  if (error) throw error;
  return data;
}

async function profilePayload(user: any) {
  const profile = await ensureProfile(user.id);
  let avatarUrl: string | null = null;
  if (profile.avatar_path) {
    const signed = await signPaths([profile.avatar_path]);
    avatarUrl = signed.get(profile.avatar_path) || null;
  }
  return {
    user_id: user.id,
    email: user.email || "",
    email_confirmed: !!user.email_confirmed_at,
    phone: user.phone || "",
    phone_confirmed: !!user.phone_confirmed_at,
    display_name: profile.display_name || "",
    school_name: profile.school_name || "",
    avatar_path: profile.avatar_path || null,
    avatar_url: avatarUrl,
    updated_at: profile.updated_at,
  };
}

const GAME_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const textEncoder = new TextEncoder();
let gameSigningKeyPromise: Promise<CryptoKey> | null = null;

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodeGamePayload(payload: any) {
  return toBase64Url(textEncoder.encode(JSON.stringify(payload)));
}

function decodeGamePayload(value: string) {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(value)));
}

async function gameSigningKey() {
  if (!gameSigningKeyPromise) {
    gameSigningKeyPromise = crypto.subtle.importKey(
      "raw",
      textEncoder.encode(getSecretKey()),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }
  return gameSigningKeyPromise;
}

async function signGamePayload(payload: any) {
  const encoded = encodeGamePayload(payload);
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    await gameSigningKey(),
    textEncoder.encode(encoded),
  ));
  return encoded + "." + toBase64Url(signature);
}

async function verifyGameToken(token: string, userId: string) {
  const [encoded, signatureText, extra] = String(token || "").split(".");
  if (!encoded || !signatureText || extra) {
    throw Object.assign(new Error("Phiên chơi không hợp lệ."), { status: 400 });
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await gameSigningKey(),
    fromBase64Url(signatureText),
    textEncoder.encode(encoded),
  );
  if (!valid) throw Object.assign(new Error("Phiên chơi đã bị thay đổi hoặc không hợp lệ."), { status: 403 });
  const payload = decodeGamePayload(encoded);
  if (payload.uid !== userId) throw Object.assign(new Error("Phiên chơi không thuộc tài khoản này."), { status: 403 });
  if (!payload.exp || Number(payload.exp) < Math.floor(Date.now() / 1000)) {
    throw Object.assign(new Error("Phiên chơi đã hết hạn."), { status: 410 });
  }
  return payload;
}

let bootstrapPromise: Promise<void> | null = null;

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

function ensureSettingsShape(input: any) {
  const data = input && typeof input === "object" ? input : {};
  const poseAssets = data.poseAssets && typeof data.poseAssets === "object" ? data.poseAssets : {};
  const globalAudio = data.audio && typeof data.audio === "object" ? data.audio : {};
  const theme = data.theme && typeof data.theme === "object" ? data.theme : {};
  const questions = Array.isArray(data.questions) && data.questions.length
    ? data.questions
    : [{
        id: Date.now(),
        text: "Nhập nội dung câu hỏi...",
        image: null,
        audio: { data: null, name: "" },
        answers: Array.from({ length: 4 }, (_, idx) => ({
          text: `Đáp án ${idx + 1}`,
          pose: "NONE",
          isCorrect: idx === 0,
          image: null,
        })),
      }];

  return {
    ...data,
    subject: String(data.subject || "Chưa phân loại"),
    title: String(data.title || "Bài dạy chưa đặt tên"),
    bankVisibility: ["private", "public", "group"].includes(data.bankVisibility)
      ? data.bankVisibility
      : "private",
    bankGroupId: data.bankGroupId || "",
    timeLimit: Number(data.timeLimit || 20),
    checkInterval: Number(data.checkInterval || 3),
    numAnswers: Number(data.numAnswers || 4),
    poseAssets: {
      NONE: poseAssets.NONE || null,
      RAISE_LEFT: poseAssets.RAISE_LEFT || null,
      RAISE_RIGHT: poseAssets.RAISE_RIGHT || null,
      BOTH_UP: poseAssets.BOTH_UP || null,
      CROSS_ARMS: poseAssets.CROSS_ARMS || null,
    },
    questions: questions.map((question: any, qIdx: number) => {
      const answers = Array.isArray(question?.answers) ? question.answers : [];
      return {
        ...question,
        id: question?.id || Date.now() + qIdx,
        text: String(question?.text || "Nhập nội dung câu hỏi..."),
        image: question?.image || null,
        audio: {
          data: question?.audio?.data || null,
          name: question?.audio?.name || "",
        },
        answers: Array.from({ length: Math.max(4, answers.length) }, (_, idx) => {
          const answer = answers[idx] || {};
          return {
            ...answer,
            text: String(answer.text || `Đáp án ${idx + 1}`),
            pose: answer.pose || "NONE",
            isCorrect: typeof answer.isCorrect === "boolean" ? answer.isCorrect : idx === 0,
            image: answer.image || null,
          };
        }),
      };
    }),
    audio: {
      correct: {
        data: globalAudio.correct?.data || null,
        name: globalAudio.correct?.name || "",
      },
      wrong: {
        data: globalAudio.wrong?.data || null,
        name: globalAudio.wrong?.name || "",
      },
      bgm: {
        data: globalAudio.bgm?.data || null,
        name: globalAudio.bgm?.name || "",
      },
      bgmVolume: Math.min(1, Math.max(0, Number(globalAudio.bgmVolume ?? 0.3))),
      feedbackVolume: Math.min(1, Math.max(0, Number(globalAudio.feedbackVolume ?? 0.9))),
      questionVolume: Math.min(1, Math.max(0, Number(globalAudio.questionVolume ?? 1))),
      defaultFeedback: globalAudio.defaultFeedback !== false,
    },
    theme: {
      background: theme.background || null,
      overlay: Math.min(0.95, Math.max(0.2, Number(theme.overlay ?? 0.68))),
      fit: ["cover", "contain"].includes(theme.fit) ? theme.fit : "cover",
    },
  };
}


const IMPORT_POSES = ["RAISE_LEFT", "RAISE_RIGHT", "BOTH_UP", "CROSS_ARMS"];
const DEFAULT_IMPORT_MAPPING: Record<string, string> = {
  A: "RAISE_LEFT",
  B: "RAISE_RIGHT",
  C: "BOTH_UP",
  D: "CROSS_ARMS",
};

function importHeader(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("vi")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]/g, "");
}

function normalizeImportMapping(input: any) {
  const mapping: Record<string, string> = { ...DEFAULT_IMPORT_MAPPING };
  for (const letter of ["A", "B", "C", "D"]) {
    const candidate = String(input?.[letter] || "").trim().toUpperCase();
    if (IMPORT_POSES.includes(candidate)) mapping[letter] = candidate;
  }
  const errors: string[] = [];
  if (new Set(Object.values(mapping)).size !== 4) {
    errors.push("Mỗi đáp án A–D phải dùng một tư thế khác nhau.");
  }
  return { mapping, errors };
}

function normalizeCorrectAnswer(raw: unknown, answers: string[]) {
  let value = String(raw ?? "").trim();
  value = value.replace(/^(?:đáp\s*án|dap\s*an|answer|correct)\s*[:\-]?\s*/i, "").trim();
  const direct = value.toUpperCase().replace(/[^A-D1-4]/g, "");
  if (/^[A-D]$/.test(direct)) return direct;
  if (/^[1-4]$/.test(direct)) return String.fromCharCode(64 + Number(direct));
  const target = importHeader(value);
  const idx = answers.findIndex((answer) => importHeader(answer) === target && target);
  return idx >= 0 ? String.fromCharCode(65 + idx) : "";
}

function buildImportItem(
  row: number,
  questionText: unknown,
  answerValues: unknown[],
  correctRaw: unknown,
  mapping: Record<string, string>,
) {
  const question = String(questionText ?? "").trim();
  const answers = answerValues.slice(0, 4).map((value) => String(value ?? "").trim());
  const errors: string[] = [];
  if (!question) errors.push("Thiếu nội dung câu hỏi.");
  answers.forEach((answer, idx) => {
    if (!answer) errors.push(`Thiếu đáp án ${String.fromCharCode(65 + idx)}.`);
  });
  const correctLetter = normalizeCorrectAnswer(correctRaw, answers);
  if (!correctLetter) errors.push("Đáp án đúng phải là A, B, C, D, 1–4 hoặc đúng nội dung một đáp án.");

  const normalizedQuestion = {
    id: crypto.randomUUID(),
    text: question || "Câu hỏi chưa có nội dung",
    image: null,
    audio: { data: null, name: "" },
    answers: answers.map((text, idx) => {
      const letter = String.fromCharCode(65 + idx);
      return {
        text: text || `Đáp án ${letter}`,
        pose: mapping[letter] || DEFAULT_IMPORT_MAPPING[letter],
        isCorrect: letter === correctLetter,
        image: null,
      };
    }),
  };

  return {
    row,
    valid: errors.length === 0,
    errors,
    correct: correctLetter,
    question: normalizedQuestion,
  };
}

function detectHeaderMap(row: unknown[]) {
  const keys = row.map(importHeader);
  const find = (aliases: string[]) => keys.findIndex((key) => aliases.includes(key));
  const map = {
    question: find(["cauhoi", "question", "noidung", "noidungcauhoi"]),
    A: find(["a", "dapana", "phuongan", "phuonga"]),
    B: find(["b", "dapanb", "phuongb"]),
    C: find(["c", "dapanc", "phuongc"]),
    D: find(["d", "dapand", "phuongd"]),
    correct: find(["dapan", "dapandung", "correct", "answer", "ketqua"]),
  };
  return Object.values(map).every((idx) => idx >= 0) ? map : null;
}

function parseImportRows(rowsInput: unknown[][], mapping: Record<string, string>) {
  const rows = rowsInput
    .map((row) => Array.isArray(row) ? row : [])
    .filter((row) => row.some((cell) => String(cell ?? "").trim() !== ""));
  const errors: string[] = [];
  if (!rows.length) return { items: [], errors: ["Không có dữ liệu câu hỏi."] };

  const headerMap = detectHeaderMap(rows[0]);
  const start = headerMap ? 1 : 0;
  const items: any[] = [];

  for (let i = start; i < rows.length && items.length < MAX_IMPORT_QUESTIONS; i++) {
    const row = rows[i];
    let q: unknown;
    let answers: unknown[];
    let correct: unknown;
    if (headerMap) {
      q = row[headerMap.question];
      answers = [row[headerMap.A], row[headerMap.B], row[headerMap.C], row[headerMap.D]];
      correct = row[headerMap.correct];
    } else {
      const first = String(row[0] ?? "").trim();
      const hasStt = row.length >= 7 && /^\d+$/.test(first);
      const offset = hasStt ? 1 : 0;
      q = row[offset];
      answers = [row[offset + 1], row[offset + 2], row[offset + 3], row[offset + 4]];
      correct = row[offset + 5];
    }
    if ([q, ...answers, correct].every((value) => String(value ?? "").trim() === "")) continue;
    items.push(buildImportItem(i + 1, q, answers, correct, mapping));
  }

  if (rows.length - start > MAX_IMPORT_QUESTIONS) {
    errors.push(`Chỉ đọc tối đa ${MAX_IMPORT_QUESTIONS} câu trong một lần nhập.`);
  }
  return { items, errors };
}

function parseWordLikeText(text: string, mapping: Record<string, string>) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const records: any[] = [];
  let current: any = null;
  let lastAnswer = "";
  const flush = () => {
    if (!current) return;
    records.push(current);
    current = null;
    lastAnswer = "";
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (current?.correct && Object.keys(current.answers || {}).length >= 4) flush();
      continue;
    }

    const qMatch = line.match(/^(?:câu|cau)\s*\d+\s*[\.\):\-]?\s*(.+)$/i)
      || line.match(/^\d+\s*[\.\)]\s*(.+)$/);
    if (qMatch) {
      flush();
      current = { question: qMatch[1].trim(), answers: {}, correct: "" };
      continue;
    }

    const answerMatch = line.match(/^([A-D])\s*[\.\):\-]\s*(.+)$/i);
    if (answerMatch) {
      if (!current) current = { question: "", answers: {}, correct: "" };
      lastAnswer = answerMatch[1].toUpperCase();
      current.answers[lastAnswer] = answerMatch[2].trim();
      continue;
    }

    const correctMatch = line.match(/^(?:đáp\s*án|dap\s*an|answer|correct)\s*[:\-]?\s*(.+)$/i);
    if (correctMatch) {
      if (!current) current = { question: "", answers: {}, correct: "" };
      current.correct = correctMatch[1].trim();
      continue;
    }

    if (current) {
      if (lastAnswer) current.answers[lastAnswer] = (current.answers[lastAnswer] + " " + line).trim();
      else current.question = (current.question + " " + line).trim();
    }
  }
  flush();

  const items = records.slice(0, MAX_IMPORT_QUESTIONS).map((record, idx) =>
    buildImportItem(
      idx + 1,
      record.question,
      ["A", "B", "C", "D"].map((letter) => record.answers?.[letter] || ""),
      record.correct,
      mapping,
    )
  );
  const errors: string[] = [];
  if (!items.length) errors.push("Không nhận diện được câu hỏi. Hãy dùng mẫu Câu 1, A., B., C., D., Đáp án: B.");
  if (records.length > MAX_IMPORT_QUESTIONS) errors.push(`Chỉ đọc tối đa ${MAX_IMPORT_QUESTIONS} câu trong một lần nhập.`);
  return { items, errors };
}

function parsePastedQuestions(text: string, mapping: Record<string, string>) {
  const clean = String(text || "").trim();
  if (!clean) return { items: [], errors: ["Hãy dán nội dung câu hỏi trước."] };
  if (clean.includes("\t")) {
    const rows = clean.split(/\r?\n/).map((line) => line.split("\t"));
    return parseImportRows(rows, mapping);
  }
  return parseWordLikeText(clean, mapping);
}

async function parseExcelQuestions(file: File, mapping: Record<string, string>) {
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw Object.assign(new Error("File Excel vượt quá giới hạn 8 MB."), { status: 413 });
  }
  const ext = String(file.name || "").toLowerCase().split(".").pop();
  if (ext !== "xlsx") {
    throw Object.assign(new Error("Chỉ hỗ trợ Excel .xlsx. Với .xls hoặc Word, hãy sao chép nội dung rồi dùng Dán nhanh."), { status: 415 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes));
  } catch (_) {
    throw Object.assign(new Error("File Excel .xlsx không hợp lệ hoặc bị hỏng."), { status: 400 });
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw Object.assign(new Error("File Excel không có trang tính."), { status: 400 });

  const rows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    for (let col = 1; col <= 8; col++) {
      const cell = row.getCell(col);
      values.push(String(cell.text ?? "").trim());
    }
    if (values.some((value) => value !== "")) rows.push(values);
  });
  return parseImportRows(rows, mapping);
}

function importPreviewResponse(
  parsed: { items: any[]; errors: string[] },
  mappingInfo: { mapping: Record<string, string>; errors: string[] },
  source: string,
) {
  const validCount = parsed.items.filter((item) => item.valid).length;
  return {
    ok: true,
    source,
    total: parsed.items.length,
    valid_count: validCount,
    invalid_count: parsed.items.length - validCount,
    items: parsed.items,
    errors: parsed.errors,
    pose_mapping: mappingInfo.mapping,
    mapping_errors: mappingInfo.errors,
  };
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

async function accessibleBankRows(userId: string) {
  const groupIds = await accessibleGroupIds(userId);
  const fields = "id,user_id,subject_name,lesson_name,visibility,group_id,question,created_at,updated_at";
  const ownPromise = admin.from("pose_quiz_question_bank")
    .select(fields)
    .eq("user_id", userId);
  const publicPromise = admin.from("pose_quiz_question_bank")
    .select(fields)
    .eq("visibility", "public");
  const groupPromise = groupIds.length
    ? admin.from("pose_quiz_question_bank")
        .select(fields)
        .eq("visibility", "group")
        .in("group_id", groupIds)
    : Promise.resolve({ data: [], error: null } as any);

  const [own, pub, grp] = await Promise.all([ownPromise, publicPromise, groupPromise]);
  if (own.error) throw own.error;
  if (pub.error) throw pub.error;
  if (grp.error) throw grp.error;

  const map = new Map<string, any>();
  for (const row of [...(own.data || []), ...(pub.data || []), ...(grp.data || [])]) {
    map.set(row.id, row);
  }
  return [...map.values()].sort((a, b) =>
    String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at))
  );
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

  if (action === "account.profile.get") {
    return { ok: true, profile: await profilePayload(user) };
  }

  if (action === "account.profile.update") {
    const displayName = String(body.display_name || "").trim();
    const schoolName = String(body.school_name || "").trim();
    if (displayName.length > 120) throw Object.assign(new Error("Tên hiển thị tối đa 120 ký tự."), { status: 400 });
    if (schoolName.length > 240) throw Object.assign(new Error("Tên trường tối đa 240 ký tự."), { status: 400 });
    const { error } = await admin.from("pose_quiz_profiles").upsert({
      user_id: userId,
      display_name: displayName,
      school_name: schoolName,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (error) throw error;
    const { data: fresh, error: userError } = await admin.auth.admin.getUserById(userId);
    if (userError || !fresh.user) throw userError || new Error("Không tải lại được tài khoản.");
    return { ok: true, profile: await profilePayload(fresh.user) };
  }

  if (action === "account.avatar.upload") {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw Object.assign(new Error("Không tìm thấy ảnh đại diện."), { status: 400 });
    if (!String(file.type || "").startsWith("image/")) {
      throw Object.assign(new Error("Ảnh đại diện phải là tệp ảnh."), { status: 415 });
    }
    if (file.size > 5 * 1024 * 1024) {
      throw Object.assign(new Error("Ảnh đại diện tối đa 5 MB."), { status: 413 });
    }
    const previous = await ensureProfile(userId);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const asset = await uploadBytes(userId, bytes, file.type || "image/jpeg", file.name || "avatar.jpg");
    const { error } = await admin.from("pose_quiz_profiles").upsert({
      user_id: userId,
      avatar_path: asset.path,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (error) {
      await admin.storage.from(BUCKET).remove([asset.path]);
      await admin.from("pose_quiz_media").delete().eq("storage_path", asset.path);
      throw error;
    }
    if (previous.avatar_path && previous.avatar_path !== asset.path) {
      await admin.storage.from(BUCKET).remove([previous.avatar_path]);
      await admin.from("pose_quiz_media").delete().eq("storage_path", previous.avatar_path);
    }
    const { data: fresh } = await admin.auth.admin.getUserById(userId);
    return { ok: true, profile: await profilePayload(fresh.user || user) };
  }

  if (action === "account.avatar.delete") {
    const previous = await ensureProfile(userId);
    const { error } = await admin.from("pose_quiz_profiles")
      .update({ avatar_path: null, updated_at: new Date().toISOString() })
      .eq("user_id", userId);
    if (error) throw error;
    if (previous.avatar_path) {
      await admin.storage.from(BUCKET).remove([previous.avatar_path]);
      await admin.from("pose_quiz_media").delete().eq("storage_path", previous.avatar_path);
    }
    const { data: fresh } = await admin.auth.admin.getUserById(userId);
    return { ok: true, profile: await profilePayload(fresh.user || user) };
  }

  if (action === "account.password.change") {
    const currentPassword = String(body.current_password || "");
    const newPassword = String(body.new_password || "");
    if (newPassword.length < 8) throw Object.assign(new Error("Mật khẩu mới cần ít nhất 8 ký tự."), { status: 400 });
    if (currentPassword === newPassword) throw Object.assign(new Error("Mật khẩu mới phải khác mật khẩu hiện tại."), { status: 400 });
    const email = String(user.email || "").trim();
    if (!email) throw Object.assign(new Error("Tài khoản chưa có email để xác minh mật khẩu hiện tại."), { status: 400 });

    const verifier = createClient(supabaseUrl, getPublicKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: verifyError } = await verifier.auth.signInWithPassword({
      email,
      password: currentPassword,
    });
    if (verifyError) {
      throw Object.assign(new Error("Mật khẩu hiện tại không đúng."), { status: 403 });
    }

    const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
      password: newPassword,
    });
    if (updateError) throw updateError;
    return { ok: true, message: "Đã đổi mật khẩu." };
  }

  if (action === "account.phone.begin") {
    const phone = normalizePhone(body.phone);
    try {
      await authUserRequest(req, "user", { phone });
    } catch (err) {
      const msg = String((err as any)?.message || "");
      if (/sms|phone provider|unsupported|not enabled|provider/i.test(msg)) {
        throw Object.assign(new Error("Dịch vụ SMS chưa được cấu hình hoặc chưa sẵn sàng trên Supabase."), { status: 503 });
      }
      throw err;
    }
    return { ok: true, phone, message: "Đã gửi mã OTP đến số điện thoại mới." };
  }

  if (action === "account.phone.verify") {
    const phone = normalizePhone(body.phone);
    const token = String(body.token || "").trim();
    if (!/^\d{6,10}$/.test(token)) throw Object.assign(new Error("Mã OTP không hợp lệ."), { status: 400 });
    try {
      await authUserRequest(req, "verify", { phone, token, type: "phone_change" });
    } catch (err) {
      throw Object.assign(new Error("Mã OTP không đúng hoặc đã hết hạn."), { status: (err as any)?.status || 400 });
    }
    const { data: fresh, error } = await admin.auth.admin.getUserById(userId);
    if (error || !fresh.user) throw error || new Error("Không tải lại được tài khoản.");
    return { ok: true, profile: await profilePayload(fresh.user) };
  }

  if (action === "game.start") {
    let rawSettings = body.data || {};
    if (body.lesson_id) {
      const { data: lesson, error } = await admin.from("pose_quiz_sets")
        .select("data")
        .eq("id", body.lesson_id)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      if (!lesson) throw Object.assign(new Error("Không tìm thấy bài dạy để bắt đầu."), { status: 404 });
      rawSettings = lesson.data;
    }

    const settings = ensureSettingsShape(rawSettings);
    const questions = settings.questions || [];
    if (!questions.length) throw Object.assign(new Error("Bài dạy chưa có câu hỏi."), { status: 400 });

    const correctPoses = questions.map((question: any) => {
      const correct = (question.answers || []).find((answer: any) => answer.isCorrect);
      return String(correct?.pose || "NONE");
    });

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      v: 1,
      uid: userId,
      sid: crypto.randomUUID(),
      exp: now + GAME_TOKEN_TTL_SECONDS,
      index: 0,
      score: 0,
      total: questions.length,
      correct_poses: correctPoses,
    };

    return {
      ok: true,
      game_token: await signGamePayload(payload),
      index: 0,
      score: 0,
      total: questions.length,
    };
  }

  if (action === "game.check") {
    const payload = await verifyGameToken(String(body.game_token || ""), userId);
    const index = Number(payload.index || 0);
    const total = Number(payload.total || 0);
    if (index < 0 || index >= total || !Array.isArray(payload.correct_poses)) {
      throw Object.assign(new Error("Trạng thái phiên chơi không hợp lệ."), { status: 400 });
    }

    const detectedPose = String(body.detected_pose || "NONE");
    const expectedPose = String(payload.correct_poses[index] || "NONE");
    const correct = detectedPose === expectedPose;
    const score = Number(payload.score || 0) + (correct ? 1 : 0);
    const nextIndex = index + 1;
    const finished = nextIndex >= total;

    let nextToken: string | null = null;
    if (!finished) {
      nextToken = await signGamePayload({
        ...payload,
        index: nextIndex,
        score,
        exp: Math.floor(Date.now() / 1000) + GAME_TOKEN_TTL_SECONDS,
      });
    }

    return {
      ok: true,
      correct,
      feedback: correct ? "correct" : "wrong",
      score,
      total,
      finished,
      next_index: finished ? index : nextIndex,
      game_token: nextToken,
    };
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
    return { ok: true, item: { ...data, data: await hydrateMedia(ensureSettingsShape(data.data)) } };
  }

  if (action === "lessons.save") {
    const id = body.id || null;
    const subjectName = String(body.subject_name || body.data?.subject || "Chưa phân loại").trim() || "Chưa phân loại";
    const title = String(body.title || body.data?.title || "Bài dạy chưa đặt tên").trim() || "Bài dạy chưa đặt tên";
    const shaped = ensureSettingsShape(body.data || {});
    shaped.subject = subjectName;
    shaped.title = title;
    const normalized = await normalizeMedia(shaped, userId, "lesson");

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
    const allRows = await accessibleBankRows(userId);
    const subjectFilter = String(body.subject_name || "ALL");
    const lessonFilter = String(body.lesson_name || "ALL");
    const sourceFilter = String(body.source || "ALL");
    const keyword = String(body.search || "").trim().toLocaleLowerCase("vi");

    const subjects = [...new Set(
      allRows.map((row: any) => row.subject_name || "Chưa phân loại")
    )].sort((a, b) => String(a).localeCompare(String(b), "vi"));

    const lessonSource = subjectFilter === "ALL"
      ? allRows
      : allRows.filter((row: any) => (row.subject_name || "Chưa phân loại") === subjectFilter);
    const lessons = [...new Set(
      lessonSource.map((row: any) => row.lesson_name || "Chưa phân loại")
    )].sort((a, b) => String(a).localeCompare(String(b), "vi"));

    const rows = allRows.filter((row: any) => {
      if (subjectFilter !== "ALL" && (row.subject_name || "Chưa phân loại") !== subjectFilter) return false;
      if (lessonFilter !== "ALL" && (row.lesson_name || "Chưa phân loại") !== lessonFilter) return false;
      if (sourceFilter === "MINE" && row.user_id !== userId) return false;
      if (sourceFilter === "PUBLIC" && row.visibility !== "public") return false;
      if (sourceFilter === "GROUP" && row.visibility !== "group") return false;
      if (keyword && !String(row.question?.text || "").toLocaleLowerCase("vi").includes(keyword)) return false;
      return true;
    });

    return {
      ok: true,
      items: await hydrateMedia(rows),
      facets: { subjects, lessons },
    };
  }

  if (action === "bank.resolve") {
    const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean).slice(0, 200) : [];
    if (!ids.length) return { ok: true, questions: [] };

    const accessible = await accessibleBankRows(userId);
    const byId = new Map(accessible.map((row: any) => [row.id, row]));
    const selected = ids
      .map((id: string) => byId.get(id))
      .filter(Boolean);

    if (selected.length !== ids.length) {
      throw Object.assign(new Error("Một hoặc nhiều câu hỏi không còn quyền truy cập."), { status: 403 });
    }

    const questions = selected.map((row: any) => ({
      ...structuredClone(row.question),
      id: crypto.randomUUID(),
    }));

    return { ok: true, questions: await hydrateMedia(questions) };
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


  if (action === "questions.import.preview") {
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw Object.assign(new Error("Không tìm thấy file Excel."), { status: 400 });
      let payload: any = {};
      const payloadText = form.get("payload");
      if (typeof payloadText === "string" && payloadText.trim()) {
        try { payload = JSON.parse(payloadText); } catch (_) {
          throw Object.assign(new Error("Thiết lập import không hợp lệ."), { status: 400 });
        }
      }
      const mappingInfo = normalizeImportMapping(payload.pose_mapping);
      const parsed = await parseExcelQuestions(file, mappingInfo.mapping);
      return importPreviewResponse(parsed, mappingInfo, "excel");
    }

    const mappingInfo = normalizeImportMapping(body.pose_mapping);
    const parsed = parsePastedQuestions(String(body.text || ""), mappingInfo.mapping);
    return importPreviewResponse(parsed, mappingInfo, "paste");
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
    const normalized = await normalizeMedia(ensureSettingsShape(parsed), userId, "import");
    return { ok: true, data: await hydrateMedia(normalized) };
  }

  if (action === "document.export") {
    const normalized = await normalizeMedia(ensureSettingsShape(body.data || {}), userId, "export");
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
