/**
 * Piezas puras del chat de actividad: fusionar lo que llega por tres vías
 * (carga inicial, eco optimista y tiempo real) sin duplicar ni desordenar,
 * menciones y separadores. Van aparte para probarlas sin montar pantallas.
 */

export type SendState = 'sent' | 'sending' | 'failed';

export interface EventChatMessage {
  id: string;
  content: string;
  created_at: string;
  sender_id: string;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  mentions: string[];
  is_announcement: boolean;
  /** Solo en el cliente: los que salen de aquí y aún no confirma el servidor. */
  state?: SendState;
}

/** Lo que se pide de cada mensaje en todas las consultas. */
export const EVENT_MESSAGE_COLUMNS =
  'id, content, created_at, sender_id, edited_at, deleted_at, deleted_by, mentions, is_announcement';

/** Orden total: por fecha y, a igualdad, por id. Estable entre recargas. */
function compare(a: EventChatMessage, b: EventChatMessage): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Mete o reemplaza mensajes por id.
 *
 * El id lo genera el cliente al enviar (crypto.randomUUID) y viaja en el
 * INSERT, así que el eco optimista, la respuesta del servidor y el evento de
 * tiempo real son la MISMA fila: basta con el id para no duplicar, gane
 * quien gane la carrera.
 *
 * Lo que manda el servidor pisa lo local (queda en 'sent'), salvo que el
 * servidor mande algo más viejo que lo que ya se pintó de esa fila: un
 * UPDATE de tiempo real que llega después de un borrado no lo "desborra".
 */
export function mergeMessages(list: EventChatMessage[], incoming: EventChatMessage[]): EventChatMessage[] {
  if (incoming.length === 0) return list;
  const byId = new Map(list.map((m) => [m.id, m]));
  let changed = false;
  for (const m of incoming) {
    const prev = byId.get(m.id);
    if (prev && prev.deleted_at && !m.deleted_at && m.state !== 'failed' && m.state !== 'sending') {
      continue;
    }
    // El optimista guarda su hora local; la del servidor es la buena, pero
    // mientras no llegue se conserva la local para no saltar de sitio.
    byId.set(m.id, prev && m.state === undefined ? { ...m, state: 'sent' } : m);
    changed = true;
  }
  if (!changed) return list;
  return [...byId.values()].sort(compare);
}

/** Cambia solo el estado de envío de un mensaje local. */
export function setSendState(list: EventChatMessage[], id: string, state: SendState): EventChatMessage[] {
  const i = list.findIndex((m) => m.id === id);
  if (i === -1 || list[i].state === state) return list;
  const next = list.slice();
  next[i] = { ...list[i], state };
  return next;
}

/** Quita un mensaje (p. ej. al descartar uno que no se pudo enviar). */
export function dropMessage(list: EventChatMessage[], id: string): EventChatMessage[] {
  return list.some((m) => m.id === id) ? list.filter((m) => m.id !== id) : list;
}

/**
 * Dónde va la raya de "mensajes nuevos": el primer mensaje de OTRA persona
 * posterior a la última lectura. -1 si no hay nada nuevo.
 */
export function firstUnreadIndex(list: EventChatMessage[], lastReadAt: string | null, myId: string): number {
  if (!lastReadAt) return -1;
  return list.findIndex((m) => m.sender_id !== myId && m.created_at > lastReadAt && !m.deleted_at);
}

/** Clave de día local, para los separadores de fecha. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// ---------------------------------------------------------------- menciones

export interface Mentionable {
  id: string;
  name: string | null;
}

/** La etiqueta que se escribe tras la @: el primer nombre, sin espacios. */
export function mentionLabel(name: string | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return first.replace(/[^\p{L}\p{N}_.-]/gu, '');
}

/**
 * Si el cursor está escribiendo una mención, lo que va detrás de la @.
 * La @ tiene que abrir palabra (inicio o tras espacio): "correo@dominio" no
 * es una mención.
 */
export function activeMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = before.match(/(^|\s)@([\p{L}\p{N}_.-]{0,30})$/u);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

/** Candidatos para el autocompletado, sin uno mismo. */
export function mentionCandidates(members: Mentionable[], query: string, myId: string, limit = 5): Mentionable[] {
  const q = normalize(query);
  return members
    .filter((m) => m.id !== myId && mentionLabel(m.name))
    .filter((m) => !q || normalize(m.name ?? '').split(/\s+/).some((w) => w.startsWith(q)))
    .slice(0, limit);
}

/** Sustituye la mención a medias por la etiqueta completa y un espacio. */
export function insertMention(text: string, start: number, caret: number, member: Mentionable): { text: string; caret: number } {
  const label = `@${mentionLabel(member.name)} `;
  const next = text.slice(0, start) + label + text.slice(caret);
  return { text: next, caret: start + label.length };
}

/**
 * Qué menciones elegidas siguen en el texto al enviar. Quien borra "@Ana" a
 * mano deja de mencionarla, aunque la hubiera elegido de la lista.
 * El servidor vuelve a filtrar (miembros, bloqueos, máximo 10).
 */
export function mentionIdsInText(text: string, picked: Mentionable[]): string[] {
  const ids = new Set<string>();
  for (const p of picked) {
    const label = mentionLabel(p.name);
    if (!label) continue;
    const re = new RegExp(`(^|\\s)@${escapeRegExp(label)}(?![\\p{L}\\p{N}_])`, 'u');
    if (re.test(text)) ids.add(p.id);
  }
  return [...ids].slice(0, 10);
}

/**
 * Trocea el texto para resaltar las menciones de verdad (las que el servidor
 * guardó en `mentions`), no cualquier palabra que empiece por @.
 */
export function splitMentions(
  content: string,
  mentionIds: string[],
  names: Map<string, string | null>,
): Array<{ text: string; mention?: string }> {
  const labels = mentionIds
    .map((id) => ({ id, label: mentionLabel(names.get(id) ?? null) }))
    .filter((x) => x.label);
  if (labels.length === 0) return [{ text: content }];
  const re = new RegExp(`@(${labels.map((l) => escapeRegExp(l.label)).join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  const out: Array<{ text: string; mention?: string }> = [];
  let last = 0;
  for (const m of content.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > 0 && !/\s/.test(content[i - 1])) continue;
    if (i > last) out.push({ text: content.slice(last, i) });
    const who = labels.find((l) => l.label === m[1]);
    out.push({ text: m[0], mention: who?.id });
    last = i + m[0].length;
  }
  if (last < content.length) out.push({ text: content.slice(last) });
  return out;
}

function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Tope de caracteres por mensaje; lo exige también el servidor. */
export const MESSAGE_MAX_LENGTH = 2000;

/**
 * UUID v4 para el id del mensaje. `crypto.randomUUID` llega a Safari en
 * 15.4 y la app admite iOS 15.0, así que hay respaldo con getRandomValues.
 */
export function newMessageId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Normaliza una fila de la base (mentions puede venir null en filas viejas). */
export function toChatMessage(row: Partial<EventChatMessage> & { id: string }): EventChatMessage {
  return {
    id: row.id,
    content: row.content ?? '',
    created_at: row.created_at ?? new Date().toISOString(),
    sender_id: row.sender_id ?? '',
    edited_at: row.edited_at ?? null,
    deleted_at: row.deleted_at ?? null,
    deleted_by: row.deleted_by ?? null,
    mentions: Array.isArray(row.mentions) ? row.mentions : [],
    is_announcement: Boolean(row.is_announcement),
  };
}
