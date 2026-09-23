import { renderNotification, type Copy, type Locale } from '../../supabase/functions/_shared/notificationCopy';

/**
 * Piezas puras del centro de notificaciones: a dónde lleva cada aviso y
 * qué texto enseña. El texto sale del mismo módulo que usa la push
 * (supabase/functions/_shared/notificationCopy.ts), así que la bandeja y el
 * aviso del teléfono dicen lo mismo.
 */

export interface InboxItem {
  id: string;
  type: string;
  category: string;
  count: number;
  created_at: string;
  updated_at: string;
  read_at: string | null;
  data: Record<string, unknown> | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_avatar: string | null;
  event_id: string | null;
  event_title: string | null;
  event_starts_at: string | null;
  group_id: string | null;
  group_name: string | null;
  is_dm: boolean;
}

export function copyFor(item: InboxItem, locale: string): Copy {
  return renderNotification(
    {
      type: item.type,
      count: item.count,
      actor_name: item.actor_name,
      event_title: item.event_title,
      group_name: item.group_name,
      is_dm: item.is_dm,
      // En la bandeja nunca hay vista previa del mensaje: se lee en el chat.
      preview: null,
      data: item.data,
    },
    (locale.startsWith('en') ? 'en' : 'es') as Locale,
  );
}

const CHAT_TYPES = new Set(['event_message', 'chat_mention', 'organizer_announcement']);
const EVENT_TYPES = new Set([
  'join_request', 'approval', 'participant_joined', 'event_reminder', 'event_started', 'event_changed',
  'event_repeat', 'event_invite', 'friend_created_event', 'friend_joined_event', 'new_campus_event', 'spots_low',
]);

/**
 * La pantalla exacta de cada aviso. Devuelve null si ya no hay nada que
 * abrir (el evento dejó de verse, por ejemplo): la app se queda donde está.
 */
export function routeForNotification(n: Pick<InboxItem, 'type' | 'event_id' | 'group_id' | 'actor_id'> & { event_visible?: boolean }): string | null {
  if (CHAT_TYPES.has(n.type)) return n.event_id ? `/events/${n.event_id}/chat` : null;
  if (n.type === 'message') return n.group_id ? `/groups/${n.group_id}` : null;
  // Sin id (carga vieja o evento borrado), a la lista de mis eventos.
  if (EVENT_TYPES.has(n.type)) return n.event_id ? `/event/${n.event_id}` : '/events';
  switch (n.type) {
    case 'event_cancelled':
    case 'join_rejected':
      return '/events';
    case 'digest':
      return '/';
    case 'friend_request':
    case 'group_invite':
      return '/friends';
    case 'friend_accepted':
    case 'contact_joined':
    case 'invite_accepted':
    case 'person_suggestion':
      return n.actor_id ? `/friends?person=${n.actor_id}` : '/friends/find';
    case 'profile_incomplete':
    case 'verification_pending':
    case 'verification_reminder':
    case 'verification_approved':
    case 'verification_rejected':
    case 'security_alert':
      return '/profile';
    default:
      return null;
  }
}

/** Agrupa por día para los encabezados del centro ("Hoy", "Ayer", fecha). */
export function inboxSection(iso: string, now: Date = new Date()): 'today' | 'yesterday' | 'week' | 'older' {
  const d = new Date(iso);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= start) return 'today';
  if (t >= start - 86_400_000) return 'yesterday';
  if (t >= start - 6 * 86_400_000) return 'week';
  return 'older';
}

/** Mete o reemplaza por id y ordena por la última actividad (los agrupados suben). */
export function upsertInbox(list: InboxItem[], incoming: InboxItem[]): InboxItem[] {
  if (incoming.length === 0) return list;
  const byId = new Map(list.map((n) => [n.id, n]));
  for (const n of incoming) byId.set(n.id, { ...byId.get(n.id), ...n });
  return [...byId.values()].sort((a, b) =>
    a.updated_at === b.updated_at ? (a.id < b.id ? 1 : -1) : a.updated_at < b.updated_at ? 1 : -1,
  );
}
