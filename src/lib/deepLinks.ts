import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';

/**
 * Enlaces profundos y salto desde una notificación.
 *
 * Dos entradas, un solo destino: convertir algo que viene de FUERA de la app
 * en una ruta interna. Por eso todo pasa por una lista blanca en vez de
 * navegar a lo que llegue — un enlace lo escribe quien quiera.
 *
 * Solo funciona en nativo. En web, `appUrlOpen` no existe y las rutas ya las
 * resuelve el navegador.
 */

const isNative = Capacitor.isNativePlatform();

/** Declarado en ios/App/App/Info.plist como CFBundleURLSchemes. */
export const APP_URL_SCHEME = 'alwaysconnected';

/**
 * A dónde vuelven los correos de Supabase (confirmación y recuperación) cuando
 * quien se registró está en la app. Tiene que estar escrito EXACTAMENTE así en
 * Authentication → URL Configuration → Redirect URLs del dashboard, o Supabase
 * ignora el `emailRedirectTo` y manda a la Site URL, que es la web.
 */
export const AUTH_CALLBACK_URL = `${APP_URL_SCHEME}://auth-callback`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rutas sin parámetros que la app sabe abrir. Ver las <Route> de App.tsx. */
const STATIC_ROUTES = new Set(['/', '/events', '/friends', '/profile']);

/**
 * Valida un camino contra las rutas reales de la app.
 * Devuelve null para cualquier cosa que no reconozca.
 */
export function routeFromPath(path: string): string | null {
  const clean = '/' + path.replace(/^\/+/, '').split('?')[0].split('#')[0];

  if (STATIC_ROUTES.has(clean)) return clean;

  // El id se comprueba de verdad: sin esto, "/groups/../../algo" sería ruta.
  const group = clean.match(/^\/groups\/([^/]+)$/);
  if (group && UUID.test(group[1])) return clean;

  // El chat de una actividad.
  const eventChat = clean.match(/^\/events\/([^/]+)\/chat$/);
  if (eventChat && UUID.test(eventChat[1])) return clean;

  return null;
}

/**
 * `alwaysconnected://groups/<id>` o `https://<dominio>/groups/<id>`.
 *
 * En un esquema propio el primer segmento cae en `host`, no en `pathname`,
 * así que hay que recomponerlo.
 */
export function routeFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === `${APP_URL_SCHEME}:`) {
      return routeFromPath(`${parsed.host}${parsed.pathname}`);
    }
    return routeFromPath(parsed.pathname);
  } catch {
    return null;
  }
}

/**
 * Traduce el `data` de una notificación a la pantalla que la responde.
 *
 * Los tipos los fija supabase/migrations/20260827000000_push-triggers.sql;
 * si añades uno allí, añádelo aquí o la notificación abrirá el mapa.
 */
export function routeFromPushData(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;

  switch (d.type) {
    case 'message':
      return typeof d.group_id === 'string' ? routeFromPath(`/groups/${d.group_id}`) : null;
    // Chat de actividad: mensajes agrupados, menciones y avisos del
    // organizador abren el chat de esa actividad (20260923000000).
    case 'event_message':
    case 'chat_mention':
    case 'organizer_announcement':
      return typeof d.event_id === 'string' ? routeFromPath(`/events/${d.event_id}/chat`) : null;
    // Las invitaciones a grupos se responden arriba de la pestaña Amigos.
    case 'friend_request':
    case 'group_invite':
      return '/friends';
    // El plan repetido aparece en el mapa, como cualquier evento nuevo.
    case 'event_repeat':
      return '/';
    // Ambas se atienden desde "Mis eventos": ahí están los que organizas, con
    // sus solicitudes, y los que te han aprobado.
    //
    // 'event_started' va al mismo sitio y no al mapa: el aviso es para
    // registrar asistencia, y el botón vive dentro de la hoja del evento.
    // En "Mis eventos" el que acaba de empezar está arriba en "Próximos";
    // en el mapa habría que buscar el pin.
    case 'join_request':
    case 'approval':
    case 'event_started':
      return '/events';
    default:
      return null;
  }
}

/**
 * Saca los parámetros de auth de un enlace de correo, vengan por donde vengan.
 *
 * Con el flujo implícito —el que usa el cliente hoy— Supabase devuelve la
 * sesión en el fragmento (#access_token=…); con PKCE la devuelve en la query
 * (?code=…). Se miran los dos: si algún día se cambia `flowType`, el enlace no
 * debe dejar de funcionar en silencio.
 *
 * Devuelve null si la URL no es un callback de auth.
 */
export function authParamsFromUrl(url: string): URLSearchParams | null {
  try {
    const parsed = new URL(url);
    const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    if (hash.has('access_token') || hash.has('error') || hash.has('error_description')) {
      return hash;
    }
    const query = parsed.searchParams;
    if (query.has('code') || query.has('error') || query.has('error_description')) {
      return query;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Abre la sesión que trae el enlace del correo.
 *
 * Devuelve true si la URL era un callback de auth —también cuando falla—, para
 * que quien llama no siga buscándole una ruta dentro: no la tiene.
 *
 * Hace falta hacerlo a mano porque `detectSessionInUrl` de supabase-js mira
 * `window.location`, y un `appUrlOpen` no cambia la URL del webview.
 */
export async function consumeAuthCallback(url: string): Promise<boolean> {
  const params = authParamsFromUrl(url);
  if (!params) return false;

  const failure = params.get('error_description') ?? params.get('error');
  if (failure) {
    // Lo normal es que el enlace haya caducado o ya se usara. No hay sesión
    // que abrir, pero la URL era nuestra: se da por consumida igual.
    console.error('consumeAuthCallback:', failure);
    return true;
  }

  try {
    // La bandera ANTES de tocar la sesión: setSession emite SIGNED_IN, no
    // PASSWORD_RECOVERY, así que el evento que vigila App.tsx no llega nunca y
    // sin esto se entraría a la app sin llegar a cambiar la contraseña.
    if (params.get('type') === 'recovery') {
      useAuthStore.getState().setPasswordRecovery(true);
    }

    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    if (accessToken && refreshToken) {
      const { error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      if (error) throw error;
      return true;
    }

    const code = params.get('code');
    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) throw error;
      return true;
    }

    return true;
  } catch (err) {
    console.error('consumeAuthCallback:', err);
    return true;
  }
}

// ---------------------------------------------------------------------------

let navigate: ((route: string) => void) | null = null;
let pendingRoute: string | null = null;

/**
 * Conecta el router. Lo llama un componente de dentro de <BrowserRouter>.
 *
 * Guarda la ruta pendiente porque en un arranque en frío —la app estaba
 * cerrada y se abre tocando la notificación— el evento llega antes de que
 * exista router al que pedirle nada.
 */
export function setDeepLinkNavigator(fn: ((route: string) => void) | null): void {
  navigate = fn;
  if (fn && pendingRoute) {
    const route = pendingRoute;
    pendingRoute = null;
    fn(route);
  }
}

function go(route: string | null): void {
  if (!route) return;
  if (navigate) navigate(route);
  else pendingRoute = route;
}

/** Todo enlace entrante pasa por aquí: primero sesión, luego ruta. */
async function handleUrl(url: string): Promise<void> {
  if (await consumeAuthCallback(url)) return;
  go(routeFromUrl(url));
}

let started = false;

/** Idempotente: se llama en cada arranque con sesión, como registerPush. */
export async function initDeepLinks(): Promise<void> {
  if (!isNative || started) return;
  started = true;

  try {
    await CapacitorApp.addListener('appUrlOpen', ({ url }) => {
      handleUrl(url).catch((err) => console.error('appUrlOpen:', err));
    });

    await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      go(routeFromPushData(action.notification?.data));
    });

    // Si la app se abrió DESDE un enlace, ese appUrlOpen ya pasó sin oyente.
    const launch = await CapacitorApp.getLaunchUrl();
    if (launch?.url) await handleUrl(launch.url);
  } catch (err) {
    // Que un enlace no abra la pantalla correcta no debe tumbar el arranque.
    console.error('initDeepLinks:', err);
  }
}
