// Envía el código de verificación al correo institucional.
//
// Lo que NO hace, a propósito:
//   * No crea usuarios ni identidades en Supabase Auth. No llama a
//     signInWithOtp ni a linkIdentity: el correo institucional es una
//     credencial secundaria de la MISMA cuenta (Apple, Google o correo), no
//     otra forma de iniciar sesión.
//   * No decide nada: las reglas (dominio confirmado, límites, enfriamiento,
//     institución del perfil) viven en start_institution_verification, en la
//     base. Esta función solo valida el JWT, pasa el usuario del token y manda
//     el correo.
//   * No guarda ni registra el correo ni el código. Los logs solo llevan el
//     estado.
//
// Confirmar el código no pasa por aquí: la app llama directamente a la RPC
// confirm_institution_verification con su sesión.
//
// Cómo se envía (Edge Functions → Secrets). Se usa el primero que esté completo:
//   1. Resend, con dominio propio:
//        RESEND_API_KEY, VERIFICATION_EMAIL_FROM ("Always Connected <codigos@tudominio>")
//   2. SMTP de Gmail, provisional mientras no hay dominio (2026-09-15):
//        SMTP_USER       la cuenta, p. ej. always.connected.support@gmail.com
//        SMTP_PASSWORD   contraseña de APLICACIÓN de Google (no la de la cuenta)
//        SMTP_HOST       opcional, smtp.gmail.com
//        VERIFICATION_EMAIL_FROM opcional; en Gmail tiene que ser la misma cuenta
//   Y siempre:
//        VERIFICATION_IP_SALT  cadena aleatoria para el hash de IP
// Sin ninguno completo responde EMAIL_NOT_CONFIGURED y no deja ningún desafío
// vivo.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildVerificationEmail,
  clientIp,
  hashIp,
  isAppleRelayDomain,
  normalizeInstitutionalEmail,
} from "../_shared/institutionalEmail.ts";
import { smtpSend } from "../_shared/smtp.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const APP_ORIGIN = Deno.env.get("APP_ORIGIN") ?? "*";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const EMAIL_FROM = Deno.env.get("VERIFICATION_EMAIL_FROM");
const SMTP_USER = Deno.env.get("SMTP_USER");
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD");
const SMTP_HOST = Deno.env.get("SMTP_HOST") ?? "smtp.gmail.com";
const IP_SALT = Deno.env.get("VERIFICATION_IP_SALT") ?? "always-connected";
const APP_NAME = "Always Connected";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NATIVE_ORIGINS = ["capacitor://localhost", "http://localhost"];

function resolveOrigin(req: Request): string {
  if (APP_ORIGIN === "*") return "*";
  const origin = req.headers.get("Origin") ?? "";
  return origin === APP_ORIGIN || NATIVE_ORIGINS.includes(origin) ? origin : APP_ORIGIN;
}

const provider: "resend" | "smtp" | null =
  RESEND_API_KEY && EMAIL_FROM ? "resend" : SMTP_USER && SMTP_PASSWORD ? "smtp" : null;

async function sendEmail(to: string, subject: string, text: string, html: string): Promise<boolean> {
  if (provider === "resend") {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, text, html }),
    });
    return res.ok;
  }
  // Gmail reescribe un From ajeno a la cuenta, así que por defecto es la cuenta.
  const conn = await Deno.connectTls({ hostname: SMTP_HOST, port: 465 });
  await smtpSend(
    conn,
    { user: SMTP_USER!, password: SMTP_PASSWORD! },
    { from: EMAIL_FROM ?? `${APP_NAME} <${SMTP_USER}>`, to, subject, text, html },
    { heloName: "always-connected.supabase" },
  );
  return true;
}

serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": resolveOrigin(req),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  const json = (body: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ status: "METHOD_NOT_ALLOWED" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ status: "NOT_AUTHENTICATED" }, 401);
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: { user }, error: authError } = await anon.auth.getUser(authHeader.slice(7));
  if (authError || !user) return json({ status: "NOT_AUTHENTICATED" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ status: "INVALID_REQUEST" }, 400);
  }
  const universityId = String(body.university_id ?? "");
  const campusId = body.campus_id == null ? null : String(body.campus_id);
  const studentId = body.student_id == null || body.student_id === "" ? null : String(body.student_id).slice(0, 40);
  const lang = body.lang === "en" ? "en" : "es";
  if (!UUID.test(universityId) || (campusId !== null && !UUID.test(campusId))) {
    return json({ status: "INVALID_REQUEST" }, 400);
  }

  const normalized = normalizeInstitutionalEmail(body.email);
  if (!normalized.ok) return json({ status: "INVALID_EMAIL" });
  if (isAppleRelayDomain(normalized.domain)) return json({ status: "PERSONAL_EMAIL" });

  if (!provider) {
    console.error("institution-verification: EMAIL_NOT_CONFIGURED");
    return json({ status: "EMAIL_NOT_CONFIGURED" });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const ip = clientIp(req.headers);
  const { data, error } = await admin.rpc("start_institution_verification", {
    _user_id: user.id,
    _university_id: universityId,
    _campus_id: campusId,
    _email: normalized.email,
    _student_id: studentId,
    _ip_hash: ip ? await hashIp(ip, IP_SALT) : null,
  });
  if (error || !data?.[0]) {
    console.error("institution-verification: rpc failed", error?.code ?? "no_row");
    return json({ status: "SERVER_ERROR" }, 500);
  }

  const row = data[0] as {
    status: string; challenge_id: string | null; code: string | null; email_masked: string | null;
    expires_at: string | null; resend_after: string | null;
  };
  const publicBody = {
    status: row.status,
    email_masked: row.email_masked,
    expires_at: row.expires_at,
    resend_after: row.resend_after,
  };
  if (row.status !== "SENT") {
    console.log("institution-verification:", row.status);
    // 200 con el estado en el cuerpo: son respuestas de negocio, no fallos, y
    // supabase-js oculta el cuerpo de las que no son 2xx.
    return json(publicBody);
  }

  const mail = buildVerificationEmail({ code: row.code!, appName: APP_NAME, lang, minutes: 10 });
  let sent = false;
  try {
    sent = await sendEmail(normalized.email, mail.subject, mail.text, mail.html);
  } catch (e) {
    // Solo el tipo y la etapa (SmtpError), nunca el correo ni la contraseña.
    console.error("institution-verification: send error", provider, e instanceof Error ? e.message : "unknown");
    sent = false;
  }
  if (!sent) {
    await admin.rpc("cancel_institution_challenge", { _challenge_id: row.challenge_id });
    console.error("institution-verification: EMAIL_SEND_FAILED");
    return json({ status: "EMAIL_SEND_FAILED" });
  }

  console.log("institution-verification: SENT");
  return json(publicBody);
});
