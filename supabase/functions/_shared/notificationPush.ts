/**
 * De una entrega reclamada a la petición de APNs, y de las respuestas de
 * APNs al resultado de la entrega. Puro, para probarlo sin red ni Deno.
 *
 * Reglas que viven aquí:
 *   * La carga lleva SOLO ids y el tipo (lo que la app necesita para abrir
 *     la pantalla correcta); el texto va en aps.alert y ya viene decidido
 *     (con o sin vista previa) desde la base.
 *   * `type` y los ids conservan los nombres de siempre (group_id, event_id)
 *     para que la versión publicada de la app siga abriéndolos.
 *   * Prioridad 0 = aviso pasivo (sin sonido, no enciende la pantalla, APNs
 *     prioridad 5). Nunca "critical" ni "time-sensitive": no hay entitlement.
 *   * apns-collapse-id = id de la notificación: si una entrega se reintenta
 *     o una conversación manda su resumen, en el teléfono se REEMPLAZA el
 *     aviso anterior en vez de apilarse. Es la última red contra duplicados.
 */
import { reintentarEnSandbox, tokenMuerto, type ApnsRespuesta } from './apns.ts';
import type { Copy } from './notificationCopy.ts';

export interface ClaimedDelivery {
  delivery_id: string;
  notification_id: string;
  user_id: string;
  type: string;
  priority: number;
  count: number;
  locale: string | null;
  actor_id: string | null;
  actor_name: string | null;
  event_id: string | null;
  event_title: string | null;
  group_id: string | null;
  group_name: string | null;
  is_dm: boolean | null;
  preview: string | null;
  data: Record<string, unknown> | null;
  thread_id: string | null;
  expires_at: string | null;
  tokens: string[] | null;
}

export interface ApnsRequest {
  payload: Record<string, unknown>;
  priority: '10' | '5';
  collapseId: string;
  expiration: number;
}

/** Tipos cuya pantalla es la de una persona (quien pide, acepta, se une…). */
const ACTOR_TYPES = new Set(['friend_request', 'friend_accepted', 'contact_joined', 'invite_accepted', 'person_suggestion']);

export function buildApnsRequest(d: ClaimedDelivery, copy: Copy, nowMs = Date.now()): ApnsRequest {
  const passive = d.priority <= 0;
  const aps: Record<string, unknown> = {
    alert: { title: copy.title, body: copy.body },
    'thread-id': d.thread_id ?? d.type,
    'interruption-level': passive ? 'passive' : 'active',
  };
  if (!passive) aps.sound = 'default';

  const payload: Record<string, unknown> = {
    aps,
    type: d.type,
    notification_id: d.notification_id,
  };
  if (d.event_id) payload.event_id = d.event_id;
  if (d.group_id) payload.group_id = d.group_id;
  if (d.actor_id && ACTOR_TYPES.has(d.type)) {
    payload.user_id = d.actor_id;
    // Nombre de siempre para la solicitud de amistad (lo leía la app 1.x).
    if (d.type === 'friend_request') payload.requester_id = d.actor_id;
  }

  const exp = d.expires_at ? Math.floor(new Date(d.expires_at).getTime() / 1000) : Math.floor(nowMs / 1000) + 3600;
  return {
    payload,
    priority: passive ? '5' : '10',
    collapseId: d.notification_id,
    expiration: Math.max(exp, Math.floor(nowMs / 1000) + 60),
  };
}

export interface DeviceOutcome {
  token: string;
  /** Respuesta final (tras el reintento en sandbox, si lo hubo). */
  result: ApnsRespuesta;
  retriedInSandbox: boolean;
}

export interface DeliverySummary {
  ok: boolean;
  devicesSent: number;
  devicesFailed: number;
  deadTokens: string[];
  /** Vale la pena reintentar: fallos de Apple o de red, no del token. */
  retry: boolean;
  error: string | null;
}

/** Estados de APNs que son de Apple o de carga, no del dispositivo. */
const TRANSIENT = new Set([0, 429, 500, 503]);

export function summarize(outcomes: DeviceOutcome[]): DeliverySummary {
  const sent = outcomes.filter((o) => o.result.status === 200);
  const failed = outcomes.filter((o) => o.result.status !== 200);
  const dead = failed.filter((o) => tokenMuerto(o.result, o.retriedInSandbox)).map((o) => o.token);
  const firstError = failed[0] ? `${failed[0].result.status} ${failed[0].result.reason ?? ''}`.trim() : null;
  return {
    ok: sent.length > 0,
    devicesSent: sent.length,
    devicesFailed: failed.length,
    deadTokens: dead,
    retry: sent.length === 0 && failed.some((o) => TRANSIENT.has(o.result.status)),
    error: firstError,
  };
}

export { reintentarEnSandbox };
