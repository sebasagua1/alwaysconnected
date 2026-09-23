// Buscar contactos que ya están en Always Connected, sin ver la agenda.
//
// Dos acciones, siempre con la sesión de la persona (JWT):
//
//   { action: "match", items: [{ ref, kind, h }], keep? }
//     `h` es SHA-256("tipo:valor normalizado"), calculado en el teléfono. Aquí
//     se firma con HMAC y CONTACTS_HMAC_KEY y se compara en la base. `ref` es
//     una etiqueta opaca que pone la app para saber qué contacto era: aquí no
//     significa nada y solo se devuelve.
//
//   { action: "register" }
//     Registra los identificadores VERIFICADOS de quien llama (correo
//     confirmado, teléfono confirmado), leídos de auth.users, para que sus
//     contactos puedan encontrarle. Solo si eligió ser encontrable (lo
//     comprueba la base).
//
// Lo que NO hace, a propósito:
//   * No recibe ni guarda correos o teléfonos en claro (solo el SHA-256 del
//     teléfono, que se descarta tras firmarlo).
//   * No escribe en el registro ningún identificador, digest ni ref: solo
//     recuentos y códigos de error.
//   * No decide quién es visible: eso (encontrable, mismo campus, bloqueos,
//     cuota) vive en la base, en contacts_consume_quota y contacts_match.
//
// Secretos (Edge Functions → Secrets):
//   CONTACTS_HMAC_KEY   32+ caracteres aleatorios. Si cambia, todas las
//                       huellas guardadas dejan de coincidir hasta que cada
//                       persona vuelva a abrir la app.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  digestInput, hmacHex, isAppleRelayEmail, normalizeEmail, normalizePhone, serverMessage, sha256Hex,
  type IdentifierKind,
} from "../_shared/contactIdentity.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
// Mismo orden de preferencia que send-push: Supabase inyecta unas claves u
// otras según el proyecto.
const ADMIN_KEY = Deno.env.get("PUSH_SERVER_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  Deno.env.get("SUPABASE_SECRET_KEY") || "";
const HMAC_KEY = Deno.env.get("CONTACTS_HMAC_KEY") ?? "";
const APP_ORIGIN = Deno.env.get("APP_ORIGIN") ?? "*";
const NATIVE_ORIGINS = ["capacitor://localhost", "http://localhost"];

const MAX_ITEMS = 500;
const HEX64 = /^[0-9a-f]{64}$/;

function resolveOrigin(req: Request): string {
  if (APP_ORIGIN === "*") return "*";
  const origin = req.headers.get("Origin") ?? "";
  return origin === APP_ORIGIN || NATIVE_ORIGINS.includes(origin) ? origin : APP_ORIGIN;
}

type Item = { ref: string; kind: IdentifierKind; h: string };

/** Valida sin confiar en nada: tipos, longitudes y formato. */
function parseItems(raw: unknown): Item[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS) return null;
  const out: Item[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") return null;
    const { ref, kind, h } = x as Record<string, unknown>;
    if (typeof ref !== "string" || ref.length === 0 || ref.length > 64) return null;
    if (kind !== "email" && kind !== "phone") return null;
    if (typeof h !== "string" || !HEX64.test(h)) return null;
    out.push({ ref, kind, h });
  }
  return out;
}

serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": resolveOrigin(req),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  if (HMAC_KEY.length < 32 || !ADMIN_KEY) {
    console.error("contacts-match: falta CONTACTS_HMAC_KEY (32+ caracteres) o la clave de servidor.");
    return json({ error: "CONTACTS_NOT_CONFIGURED" }, 503);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "NOT_AUTHENTICATED" }, 401);

  const asUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: who, error: authError } = await asUser.auth.getUser();
  if (authError || !who.user) return json({ error: "NOT_AUTHENTICATED" }, 401);
  const userId = who.user.id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "INVALID_REQUEST" }, 400);
  }

  const admin = createClient(SUPABASE_URL, ADMIN_KEY, { auth: { persistSession: false } });

  // ------------------------------------------------------------ register
  if (body.action === "register") {
    const { data: full, error } = await admin.auth.admin.getUserById(userId);
    if (error || !full.user) return json({ error: "NOT_AUTHENTICATED" }, 401);
    const u = full.user;

    const items: { kind: IdentifierKind; digest: string }[] = [];
    const email = u.email_confirmed_at ? normalizeEmail(u.email) : null;
    if (email && !isAppleRelayEmail(email)) {
      const sha = await sha256Hex(digestInput("email", email));
      items.push({ kind: "email", digest: await hmacHex(HMAC_KEY, `email:${sha}`) });
    }
    // auth.users.phone va sin "+" (formato E.164 sin el signo).
    const phone = u.phone_confirmed_at && u.phone ? normalizePhone(`+${u.phone.replace(/^\+/, "")}`) : null;
    if (phone) {
      const sha = await sha256Hex(digestInput("phone", phone));
      items.push({ kind: "phone", digest: await hmacHex(HMAC_KEY, `phone:${sha}`) });
    }

    const { data: notified, error: rpcError } = await admin.rpc("contacts_register_identifiers", {
      _user_id: userId,
      _items: items,
    });
    if (rpcError) {
      console.error(`contacts-match register: ${rpcError.code ?? ""} ${rpcError.message}`);
      return json({ error: "CONTACTS_UNAVAILABLE" }, 500);
    }
    return json({ registered: items.length, notified: notified ?? 0 });
  }

  // ------------------------------------------------------------ match
  if (body.action !== "match") return json({ error: "INVALID_REQUEST" }, 400);

  const items = parseItems(body.items);
  if (!items) return json({ error: "INVALID_REQUEST" }, 400);
  if (items.length === 0) return json({ matches: [], checked: 0 });

  // Firmar: un digest por (tipo, sha). Varias refs pueden compartirlo (el
  // mismo número guardado en dos contactos).
  const refsByDigest = new Map<string, string[]>();
  for (const it of items) {
    const msg = serverMessage(it.kind, it.h);
    if (!msg) continue;
    const digest = await hmacHex(HMAC_KEY, msg);
    const refs = refsByDigest.get(digest) ?? [];
    refs.push(it.ref);
    refsByDigest.set(digest, refs);
  }
  const digests = [...refsByDigest.keys()];

  // La cuota va ANTES de mirar nada: una petición rechazada no enseña nada.
  const { error: quotaError } = await admin.rpc("contacts_consume_quota", { _user_id: userId, _count: digests.length });
  if (quotaError) {
    const code = /CONTACTS_RATE_LIMIT|CONTACTS_BATCH_TOO_LARGE/.exec(quotaError.message)?.[0] ?? "CONTACTS_UNAVAILABLE";
    console.warn(`contacts-match: cuota ${code} (${digests.length} huellas)`);
    return json({ error: code }, code === "CONTACTS_UNAVAILABLE" ? 500 : 429);
  }

  const { data: rows, error: matchError } = await admin.rpc("contacts_match", {
    _user_id: userId,
    _digests: digests,
    _keep: body.keep === true,
  });
  if (matchError) {
    console.error(`contacts-match: ${matchError.code ?? ""} ${matchError.message}`);
    return json({ error: "CONTACTS_UNAVAILABLE" }, 500);
  }

  // Una fila por persona, con todas las refs que la encontraron.
  type Row = {
    digest: string; user_id: string; name: string; avatar_url: string | null; campus_name: string | null;
    relation: string; friendship_id: string | null;
  };
  const byUser = new Map<string, Omit<Row, "digest"> & { refs: string[] }>();
  for (const r of (rows ?? []) as Row[]) {
    const prev = byUser.get(r.user_id);
    const refs = refsByDigest.get(r.digest) ?? [];
    if (prev) prev.refs.push(...refs);
    else {
      byUser.set(r.user_id, {
        user_id: r.user_id, name: r.name, avatar_url: r.avatar_url, campus_name: r.campus_name,
        relation: r.relation, friendship_id: r.friendship_id, refs: [...refs],
      });
    }
  }

  console.log(`contacts-match: ${digests.length} huellas, ${byUser.size} coincidencias`);
  return json({ matches: [...byUser.values()], checked: digests.length });
});
