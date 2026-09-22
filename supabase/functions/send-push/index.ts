// Envío de notificaciones push por APNs con autenticación por token (.p8).
//
// Quién puede llamar:
//   · Con la service_role (o sea, desde la propia base): puede enviar a
//     cualquier user_id. Es la vía que usarán los disparadores.
//   · Con el JWT de una persona: solo puede enviarse a SÍ MISMA. Sirve para
//     probar desde la app sin abrir un agujero.
//
// El .p8 nunca sale de los secretos de Supabase.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { reintentarEnSandbox, tokenMuerto } from "../_shared/apns.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

// Supabase está migrando de las claves JWT (anon / service_role) a las
// nuevas (sb_publishable_ / sb_secret_), y según el proyecto inyecta unas,
// otras o las dos. Comparar solo contra SUPABASE_SERVICE_ROLE_KEY hacía que
// la función devolviera 401 con una clave perfectamente válida, sin decir
// por qué. Se aceptan las dos, y se avisa si no hay ninguna.
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SECRET_KEY = Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
// Último recurso, y el único que no depende de lo que Supabase decida
// inyectar: un secreto puesto a mano en los ajustes de la función. Si un día
// dejan de inyectarse las dos de arriba, basta con rellenar esta.
const FALLBACK_KEY = Deno.env.get("PUSH_SERVER_KEY") ?? "";
const ANON_KEY =
  Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";

/** Las claves que identifican al servidor llamándose a sí mismo. */
const SERVER_KEYS = [SERVICE_ROLE, SECRET_KEY, FALLBACK_KEY].filter((k) => k.length > 0);

/** La que sirve para hablar con la base saltándose la RLS. */
const ADMIN_KEY = FALLBACK_KEY || SERVICE_ROLE || SECRET_KEY;
const APP_ORIGIN = Deno.env.get("APP_ORIGIN") ?? "*";

// El origen de la app nativa no es configurable por secreto: lo fija
// Capacitor y es siempre el mismo. Ver la misma trampa (y el mismo arreglo)
// en supabase/functions/delete-account/index.ts — de ahí llegaba "Failed to
// send a request to the Edge Function" pese a tener el JWT bueno.
const NATIVE_ORIGINS = ["capacitor://localhost", "http://localhost"];

function resolveOrigin(req: Request): string {
  if (APP_ORIGIN === "*") return "*";
  const origin = req.headers.get("Origin") ?? "";
  return origin === APP_ORIGIN || NATIVE_ORIGINS.includes(origin) ? origin : APP_ORIGIN;
}

const APNS_KEY_ID = Deno.env.get("APNS_KEY_ID")!;
const APNS_TEAM_ID = Deno.env.get("APNS_TEAM_ID")!;
const APNS_BUNDLE_ID = Deno.env.get("APNS_BUNDLE_ID") ?? "com.alwaysconnected.app";
const APNS_PRIVATE_KEY = Deno.env.get("APNS_PRIVATE_KEY")!;

// ---------------------------------------------------------------- JWT ES256

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// APNs acepta el mismo token durante una hora y se molesta si se regenera muy
// seguido, así que se reutiliza mientras siga fresco.
let cachedJwt: { value: string; madeAt: number } | null = null;
const JWT_TTL_MS = 45 * 60 * 1000;

async function apnsJwt(): Promise<string> {
  if (cachedJwt && Date.now() - cachedJwt.madeAt < JWT_TTL_MS) return cachedJwt.value;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(APNS_PRIVATE_KEY),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: "ES256", kid: APNS_KEY_ID })));
  const payload = b64url(
    enc.encode(JSON.stringify({ iss: APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) })),
  );
  // WebCrypto firma ECDSA en formato r||s, que es justo lo que espera ES256.
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${payload}`)),
  );

  const value = `${header}.${payload}.${b64url(sig)}`;
  cachedJwt = { value, madeAt: Date.now() };
  return value;
}

// ---------------------------------------------------------------- APNs

const HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

type SendResult = { token: string; ok: boolean; status: number; reason?: string };

// Cuánto tiempo guarda APNs el aviso si el teléfono está apagado, sin
// cobertura o con la batería a cero. SIN esta cabecera el valor por defecto es
// 0, que significa "inténtalo una vez y, si no entra, tíralo": justo el caso
// de alguien que deja el móvil en la mochila y luego dice que no le llegan las
// notificaciones. Una hora es lo razonable para avisos sociales — pasado ese
// rato, la solicitud o el mensaje ya se ven mejor abriendo la app.
const APNS_EXPIRATION_SECONDS = 60 * 60;

async function pushTo(
  host: string,
  token: string,
  jwt: string,
  payload: unknown,
): Promise<{ status: number; reason?: string }> {
  const res = await fetch(`${host}/3/device/${token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": APNS_BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + APNS_EXPIRATION_SECONDS),
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (res.status === 200) return { status: 200 };
  let reason: string | undefined;
  try {
    reason = (await res.json())?.reason;
  } catch {
    reason = undefined;
  }
  return { status: res.status, reason };
}

serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": resolveOrigin(req),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
  const bearer = authHeader.slice("Bearer ".length);

  let body: { user_id?: string; title?: string; body?: string; data?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body inválido" }, 400);
  }

  if (SERVER_KEYS.length === 0) {
    console.error(
      "Ni SUPABASE_SERVICE_ROLE_KEY ni SUPABASE_SECRET_KEY están definidas: " +
        "nadie puede autenticarse como servidor.",
    );
    return json({ error: "Función mal configurada: falta la clave de servidor" }, 500);
  }

  const esServidor = SERVER_KEYS.includes(bearer);

  // Diagnóstico: SOLO con clave de servidor.
  //
  // Antes iba aquí arriba, sin comprobar nada más que si la cabecera empezaba
  // por "Bearer ". Cualquiera podía llamarlo y lo que devolvía era un oráculo:
  // `coincide_con_alguna` confirmaba sí o no si un candidato ERA la clave del
  // servidor, gratis, sin límite de intentos y con la longitud exacta servida
  // de antemano. Adivinar una clave deja de ser a ciegas cuando algo te dice
  // si has acertado.
  //
  // Ya no salen ni longitudes ni comparaciones: solo si cada secreto está
  // puesto, que es lo único que hacía falta para depurar un despliegue. Para
  // el caso de "mi clave no encaja" está el registro de abajo, que se lee
  // desde el panel de la función y no desde internet.
  if ((body as { diagnostico?: boolean }).diagnostico === true) {
    if (!esServidor) {
      console.warn(
        `Diagnóstico rechazado: bearer de ${bearer.length} caracteres que ` +
          `empieza por "${bearer.slice(0, 3)}". No coincide con ninguna clave de servidor.`,
      );
      return json({ error: "Unauthorized" }, 401);
    }
    return json({
      service_role_definida: SERVICE_ROLE.length > 0,
      secret_key_definida: SECRET_KEY.length > 0,
      push_server_key_definida: FALLBACK_KEY.length > 0,
      anon_definida: ANON_KEY.length > 0,
      apns_configurado: Boolean(APNS_KEY_ID && APNS_TEAM_ID && APNS_PRIVATE_KEY),
    });
  }

  // Después del diagnóstico a propósito: si faltan los secretos de APNs, esto
  // cortaba antes de llegar, justo en el caso en que uno querría diagnosticar.
  if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_PRIVATE_KEY) {
    return json({ error: "APNs no configurado: faltan secretos" }, 500);
  }

  if (!body.title || !body.body) return json({ error: "Faltan title y body" }, 400);

  const admin = createClient(SUPABASE_URL, ADMIN_KEY);

  // Quién manda decide a quién se puede enviar.
  let targetUserId: string;
  if (esServidor) {
    if (!body.user_id) return json({ error: "Falta user_id" }, 400);
    targetUserId = body.user_id;
  } else {
    const anon = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error } = await anon.auth.getUser();
    if (error || !userData.user) {
      // Sin esto, una clave de servidor que no coincide y un JWT caducado
      // devolvían el mismo "Unauthorized" pelado.
      console.warn("Bearer rechazado: no es clave de servidor ni JWT válido.");
      return json({ error: "Unauthorized", hint: "El bearer no es una clave de servidor válida ni un JWT de usuario" }, 401);
    }
    // Con JWT de persona el destinatario es siempre quien llama, aunque el
    // body diga otra cosa.
    targetUserId = userData.user.id;
  }

  const { data: tokens, error: tokErr } = await admin
    .from("device_tokens")
    .select("token")
    .eq("user_id", targetUserId);
  if (tokErr) return json({ error: tokErr.message }, 500);
  if (!tokens?.length) return json({ sent: 0, results: [], note: "Sin dispositivos registrados" });

  const jwt = await apnsJwt();
  const payload = {
    aps: { alert: { title: body.title, body: body.body }, sound: "default" },
    ...(body.data ?? {}),
  };

  const results: SendResult[] = [];
  for (const { token } of tokens) {
    // Producción primero; si el token es de un build de desarrollo, APNs lo
    // rechaza y se reintenta en sandbox. Así la misma función sirve para tu
    // iPhone de pruebas y para TestFlight sin configurar nada. Cuál de los dos
    // motivos de rechazo manda Apple no es predecible: ver reintentarEnSandbox.
    let r = await pushTo(HOSTS.production, token, jwt, payload);
    const huboReintento = reintentarEnSandbox(r);
    if (huboReintento) {
      r = await pushTo(HOSTS.sandbox, token, jwt, payload);
    }

    // Tokens que ya no sirven: se limpian para no arrastrarlos en cada envío.
    if (tokenMuerto(r, huboReintento)) {
      await admin.from("device_tokens").delete().eq("token", token);
    }

    // Al registro de la función, no solo a la respuesta: los envíos de verdad
    // los dispara la base con pg_net, que descarta el cuerpo. Sin esta línea,
    // un "no me llegan las notificaciones" por TopicDisallowed (bundle id que
    // no cuadra) o InvalidProviderToken (.p8 de otro equipo) no deja rastro en
    // ningún sitio y no hay por dónde empezar a mirar.
    if (r.status !== 200) {
      console.error(
        `APNs rechazó ${token.slice(0, 8)}… para ${targetUserId}: ` +
          `${r.status} ${r.reason ?? "sin motivo"}` +
          (huboReintento ? " (falló en producción y en sandbox)" : "") +
          (r.reason === "DeviceTokenNotForTopic"
            ? ` — comprueba que APNS_BUNDLE_ID (${APNS_BUNDLE_ID}) sea el Bundle ID de la app`
            : ""),
      );
    }

    results.push({ token: token.slice(0, 8) + "…", ok: r.status === 200, status: r.status, reason: r.reason });
  }

  return json({ sent: results.filter((r) => r.ok).length, results });
});
