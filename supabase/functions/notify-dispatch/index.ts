// Despachador de notificaciones push.
//
// Lo despierta la base (pg_net, nada más encolar algo urgente, y pg_cron
// cada minuto si hay algo pendiente o atascado) con la clave de servidor.
// No recibe nada de contenido: el cuerpo es {"kick":true}. Todo lo que
// necesita lo pide con claim_notification_deliveries, que ya descarta lo
// caducado, lo leído, lo que ya no le corresponde a esa persona y lo que
// está mirando en ese momento.
//
// Por cada entrega:
//   1. Texto en el idioma de la persona (_shared/notificationCopy.ts).
//   2. APNs a TODOS sus dispositivos: producción y, si el token es de un
//      build de desarrollo, sandbox (misma regla que send-push).
//   3. complete_notification_delivery con el resultado: enviada, reintento
//      con espera (errores de Apple o de red) o fallida; y los tokens que
//      ya no sirven, para que la base los borre.
//
// Idempotente: una entrega solo la tiene quien la reclamó (FOR UPDATE SKIP
// LOCKED) y un reintento lleva el mismo apns-collapse-id, así que en el
// teléfono reemplaza en vez de duplicar.
//
// En el registro solo van recuentos y códigos: ni textos ni tokens enteros.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { renderNotification, type Locale } from "../_shared/notificationCopy.ts";
import { buildApnsRequest, reintentarEnSandbox, summarize, type ClaimedDelivery, type DeviceOutcome } from "../_shared/notificationPush.ts";
import { APNS_HOSTS, apnsJwt, apnsSend, type ApnsConfig } from "../_shared/apnsClient.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SECRET_KEY = Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const FALLBACK_KEY = Deno.env.get("PUSH_SERVER_KEY") ?? "";
const SERVER_KEYS = [SERVICE_ROLE, SECRET_KEY, FALLBACK_KEY].filter((k) => k.length > 0);
const ADMIN_KEY = FALLBACK_KEY || SERVICE_ROLE || SECRET_KEY;

const APNS: ApnsConfig = {
  keyId: Deno.env.get("APNS_KEY_ID") ?? "",
  teamId: Deno.env.get("APNS_TEAM_ID") ?? "",
  bundleId: Deno.env.get("APNS_BUNDLE_ID") ?? "com.alwaysconnected.app",
  privateKey: Deno.env.get("APNS_PRIVATE_KEY") ?? "",
};

/** Tope de trabajo por llamada: la siguiente pasada del cron sigue. */
const BUDGET_MS = 25_000;
const BATCH = 100;
const CONCURRENCY = 8;

const makeAdmin = () => createClient(SUPABASE_URL, ADMIN_KEY, { auth: { persistSession: false } });
type Admin = ReturnType<typeof makeAdmin>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function deliver(admin: Admin, d: ClaimedDelivery, jwt: string) {
  const copy = renderNotification(d, (d.locale === "en" ? "en" : "es") as Locale);
  const req = buildApnsRequest(d, copy);
  const outcomes: DeviceOutcome[] = [];

  for (const token of d.tokens ?? []) {
    let r = await apnsSend(APNS_HOSTS.production, token, jwt, APNS, req.payload, req);
    const retried = reintentarEnSandbox(r);
    if (retried) r = await apnsSend(APNS_HOSTS.sandbox, token, jwt, APNS, req.payload, req);
    outcomes.push({ token, result: r, retriedInSandbox: retried });
    if (r.status !== 200) {
      console.warn(`APNs ${r.status} ${r.reason ?? ""} para ${token.slice(0, 6)}… (${d.type})` +
        (r.reason === "DeviceTokenNotForTopic" ? ` — revisa APNS_BUNDLE_ID (${APNS.bundleId})` : ""));
    }
  }

  const s = summarize(outcomes);
  const { error } = await admin.rpc("complete_notification_delivery", {
    _delivery_id: d.delivery_id,
    _ok: s.ok,
    _devices_sent: s.devicesSent,
    _devices_failed: s.devicesFailed,
    _error: s.error,
    _retry: s.retry,
    _dead_tokens: s.deadTokens,
  });
  if (error) console.error(`complete_notification_delivery: ${error.message}`);
  return s.ok;
}

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (SERVER_KEYS.length === 0 || !SERVER_KEYS.includes(bearer)) {
    // Solo la base (con la clave de Vault) despierta a esta función.
    return json({ error: "Unauthorized" }, 401);
  }
  if (!APNS.keyId || !APNS.teamId || !APNS.privateKey) {
    console.error("notify-dispatch: faltan APNS_KEY_ID, APNS_TEAM_ID o APNS_PRIVATE_KEY");
    return json({ error: "APNs no configurado" }, 500);
  }

  const admin = makeAdmin();
  const jwt = await apnsJwt(APNS);
  const start = Date.now();
  let sent = 0;
  let failed = 0;

  while (Date.now() - start < BUDGET_MS) {
    const { data, error } = await admin.rpc("claim_notification_deliveries", { _limit: BATCH });
    if (error) {
      console.error(`claim_notification_deliveries: ${error.message}`);
      break;
    }
    const rows = (data ?? []) as ClaimedDelivery[];
    if (rows.length === 0) break;

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const results = await Promise.all(rows.slice(i, i + CONCURRENCY).map((d) => deliver(admin, d, jwt)));
      for (const ok of results) {
        if (ok) sent++;
        else failed++;
      }
    }
    if (rows.length < BATCH) break;
  }

  console.log(`notify-dispatch: ${sent} enviadas, ${failed} sin enviar`);
  return json({ sent, failed });
});
