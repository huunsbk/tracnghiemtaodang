import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const publicKey = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
const publicClient = createClient(supabaseUrl, publicKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const encoder = new TextEncoder();
let signingKeyPromise: Promise<CryptoKey> | null = null;

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}
function fail(message: string, status = 400, code = "RECOVERY_ERROR") {
  return json({ ok: false, error: { code, message } }, status);
}
function b64(bytes: Uint8Array) {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
function unb64(value: string) {
  const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function signingKey() {
  if (!signingKeyPromise) {
    signingKeyPromise = crypto.subtle.importKey(
      "raw", encoder.encode(getSecretKey()),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
    );
  }
  return signingKeyPromise;
}
async function signState(payload: any) {
  const encoded = b64(encoder.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(), encoder.encode(encoded)));
  return encoded + "." + b64(sig);
}
async function verifyState(token: string, purpose: string) {
  const [encoded, sig, extra] = String(token || "").split(".");
  if (!encoded || !sig || extra) throw Object.assign(new Error("Liên kết khôi phục không hợp lệ."), { status: 400 });
  const valid = await crypto.subtle.verify("HMAC", await signingKey(), unb64(sig), encoder.encode(encoded));
  if (!valid) throw Object.assign(new Error("Liên kết khôi phục đã bị thay đổi."), { status: 403 });
  const payload = JSON.parse(new TextDecoder().decode(unb64(encoded)));
  if (payload.purpose !== purpose || Number(payload.exp || 0) < Math.floor(Date.now() / 1000)) {
    throw Object.assign(new Error("Liên kết hoặc mã khôi phục đã hết hạn."), { status: 410 });
  }
  return payload;
}
function normalizePhone(value: string) {
  let phone = String(value || "").trim().replace(/[\s().-]/g, "");
  if (phone.startsWith("00")) phone = "+" + phone.slice(2);
  if (phone.startsWith("0")) phone = "+84" + phone.slice(1);
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw Object.assign(new Error("Số điện thoại không hợp lệ."), { status: 400 });
  return phone;
}
function safeRedirect(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Redirect phải dùng HTTPS.");
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  const allowed =
    (host === "huunsbk.github.io" && path.startsWith("/tracnghiemtaodang")) ||
    (host === "rawcdn.githack.com" && path.startsWith("/huunsbk/tracnghiemtaodang/")) ||
    host === "tracnghiemtaodang.vercel.app";
  if (!allowed) throw Object.assign(new Error("Địa chỉ khôi phục không được phép."), { status: 400 });
  url.hash = "";
  url.search = "";
  return url.toString();
}
async function findUserByEmail(email: string) {
  const target = email.trim().toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const found = data.users.find((u: any) => String(u.email || "").toLowerCase() === target);
    if (found) return found;
    if (data.users.length < 1000) break;
  }
  return null;
}
async function authCapabilities() {
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/settings`, { headers: { apikey: publicKey } });
    const settings: any = await response.json();
    return {
      email: settings?.external?.email !== false,
      sms: settings?.external?.phone === true,
    };
  } catch (_) {
    return { email: true, sms: false };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("Chỉ hỗ trợ POST.", 405, "METHOD_NOT_ALLOWED");

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    if (action === "capabilities") {
      return json({ ok: true, ...(await authCapabilities()) });
    }

    if (action === "email.begin") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return fail("Email không hợp lệ.", 400);
      }
      const redirectBase = safeRedirect(String(body.redirect_to || ""));
      const user = await findUserByEmail(email);
      if (user) {
        const state = await signState({
          purpose: "email_password_recovery",
          uid: user.id,
          exp: Math.floor(Date.now() / 1000) + 30 * 60,
          nonce: crypto.randomUUID(),
        });
        const redirect = new URL(redirectBase);
        redirect.searchParams.set("recovery_state", state);
        const { error } = await publicClient.auth.resetPasswordForEmail(email, { redirectTo: redirect.toString() });
        if (error) throw error;
      }
      return json({ ok: true, message: "Nếu email đã đăng ký, hệ thống sẽ gửi liên kết khôi phục." });
    }

    if (action === "email.complete") {
      const state = await verifyState(String(body.recovery_state || ""), "email_password_recovery");
      const password = String(body.new_password || "");
      if (password.length < 8) return fail("Mật khẩu mới cần ít nhất 8 ký tự.", 400);
      const { error } = await admin.auth.admin.updateUserById(state.uid, { password });
      if (error) throw error;
      return json({ ok: true, message: "Đã tạo mật khẩu mới. Hãy đăng nhập lại." });
    }

    if (action === "phone.begin") {
      const capabilities = await authCapabilities();
      if (!capabilities.sms) return fail("Khôi phục bằng SMS chưa được cấu hình trên hệ thống.", 503, "SMS_NOT_CONFIGURED");
      const phone = normalizePhone(body.phone);
      const { error } = await publicClient.auth.signInWithOtp({
        phone,
        options: { shouldCreateUser: false },
      });
      if (error) {
        const msg = String(error.message || "");
        if (/provider|sms|phone.*disabled|not enabled|unsupported/i.test(msg)) {
          return fail("Dịch vụ SMS chưa sẵn sàng.", 503, "SMS_NOT_CONFIGURED");
        }
        // Không tiết lộ số có tồn tại hay không.
      }
      return json({ ok: true, phone, message: "Nếu số điện thoại đã đăng ký, mã OTP sẽ được gửi." });
    }

    if (action === "phone.verify") {
      const phone = normalizePhone(body.phone);
      const token = String(body.token || "").trim();
      if (!/^\d{6,10}$/.test(token)) return fail("Mã OTP không hợp lệ.", 400);
      const client = createClient(supabaseUrl, publicKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { data, error } = await client.auth.verifyOtp({ phone, token, type: "sms" });
      if (error || !data.user) return fail("Mã OTP không đúng hoặc đã hết hạn.", 400);
      const state = await signState({
        purpose: "phone_password_recovery",
        uid: data.user.id,
        exp: Math.floor(Date.now() / 1000) + 10 * 60,
        nonce: crypto.randomUUID(),
      });
      try { await client.auth.signOut({ scope: "local" }); } catch (_) {}
      return json({ ok: true, recovery_token: state });
    }

    if (action === "phone.complete") {
      const state = await verifyState(String(body.recovery_token || ""), "phone_password_recovery");
      const password = String(body.new_password || "");
      if (password.length < 8) return fail("Mật khẩu mới cần ít nhất 8 ký tự.", 400);
      const { error } = await admin.auth.admin.updateUserById(state.uid, { password });
      if (error) throw error;
      return json({ ok: true, message: "Đã tạo mật khẩu mới. Hãy đăng nhập lại." });
    }

    return fail("Lệnh khôi phục không hợp lệ.", 404, "UNKNOWN_ACTION");
  } catch (error) {
    const status = Number((error as any)?.status || 500);
    const message = String((error as any)?.message || "Lỗi khôi phục tài khoản.");
    console.error("pose-quiz-recovery", status, message);
    return fail(message, status, status >= 500 ? "INTERNAL_ERROR" : "RECOVERY_ERROR");
  }
});
