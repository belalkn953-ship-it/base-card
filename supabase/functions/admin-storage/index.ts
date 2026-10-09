import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const allowedOrigins = new Set(["https://belalkn953-ship-it.github.io", "http://localhost:5173", "http://127.0.0.1:5173"]);
const cors = (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "https://belalkn953-ship-it.github.io",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-basecard-admin-pin-session",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
};
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !anon || !serviceKey) return json(req, { error: "server_not_configured" }, 503);
  const authorization = req.headers.get("Authorization") || "";
  const userClient = createClient(url, anon, { global: { headers: { Authorization: authorization } } });
  const { data: authData, error: authError } = await userClient.auth.getUser();
  if (authError || !authData.user) return json(req, { error: "sign_in_required" }, 401);
  const pinSession = req.headers.get("x-basecard-admin-pin-session") || "";
  if (!/^[0-9a-f-]{36}$/.test(pinSession)) return json(req, { error: "admin_pin_required" }, 403);
  const { data: pinValid, error: pinError } = await userClient.rpc("admin_pin_session_valid", { p_session_token: pinSession });
  if (pinError || pinValid !== true) return json(req, { error: "admin_pin_expired" }, 403);

  const admin = createClient(url, serviceKey);
  const contentType = req.headers.get("content-type") || "";
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    let form: FormData;
    try { form = await req.formData(); } catch { return json(req, { error: "invalid_upload" }, 400); }
    const file = form.get("file");
    if (!(file instanceof File) || file.size < 1 || file.size > 4 * 1024 * 1024) return json(req, { error: "invalid_file_size" }, 400);
    const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
    const extension = extensions[file.type.toLowerCase()];
    if (!extension) return json(req, { error: "unsupported_image_type" }, 415);
    const path = `${authData.user.id}/sham-cash-qr-${crypto.randomUUID()}.${extension}`;
    const { error } = await admin.storage.from("site-assets").upload(path, file, { upsert: false, contentType: file.type, cacheControl: "3600" });
    if (error) return json(req, { error: "upload_failed" }, 500);
    const { data } = admin.storage.from("site-assets").getPublicUrl(path);
    return json(req, { ok: true, path, public_url: data.publicUrl });
  }

  let body: { action?: string; path?: string };
  try { body = await req.json(); } catch { return json(req, { error: "invalid_json" }, 400); }
  if (body.action === "receipt_signed_url") {
    const path = String(body.path || "");
    if (!/^[0-9a-f-]{36}\/[^/\\]{1,240}$/i.test(path) || path.includes("..")) return json(req, { error: "invalid_receipt_path" }, 400);
    const { data, error } = await admin.storage.from("receipts").createSignedUrl(path, 300);
    if (error || !data?.signedUrl) return json(req, { error: "receipt_unavailable" }, 404);
    return json(req, { ok: true, signed_url: data.signedUrl });
  }
  return json(req, { error: "unsupported_action" }, 400);
});
