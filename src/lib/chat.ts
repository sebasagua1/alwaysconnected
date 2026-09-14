/**
 * Piezas puras del chat: se usan en la lista de conversaciones y en el propio
 * chat, y van aparte para poder probarlas sin montar pantallas ni Supabase.
 */

/** Los campos de un mensaje que pueden cambiar después de enviarlo. */
export interface MessageChange {
  id: string;
  content: string;
  edited_at: string | null;
  deleted_at: string | null;
}

/**
 * Aplica una edición o un borrado llegado por tiempo real (o la respuesta del
 * servidor) sobre la lista pintada. Solo toca los campos que cambian: el
 * remitente, la fecha y el nombre ya cacheado se quedan como estaban.
 *
 * Devuelve la MISMA lista si el mensaje no está cargado (p. ej. uno antiguo que
 * no se ha paginado todavía), para que React no repinte por nada.
 */
export function applyMessageChange<T extends MessageChange>(list: T[], change: MessageChange): T[] {
  const i = list.findIndex((m) => m.id === change.id);
  if (i === -1) return list;
  const next = list.slice();
  next[i] = {
    ...list[i],
    content: change.content,
    edited_at: change.edited_at,
    deleted_at: change.deleted_at,
  };
  return next;
}

/**
 * Si lo escrito se puede guardar como edición. Vacío no, y sin cambios
 * tampoco: guardar lo mismo marcaría "Editado" sin haber editado nada.
 */
export function canSaveEdit(original: string, draft: string): boolean {
  const limpio = draft.trim();
  return limpio.length > 0 && limpio !== original.trim();
}

/**
 * Hora de la vista previa de una conversación, como en cualquier app de
 * mensajes: la hora si es de hoy, "ayer", el día de la semana si es de esta
 * semana y la fecha corta si es más vieja.
 */
export function formatChatTime(
  iso: string,
  locale: string,
  yesterdayLabel: string,
  now: Date = new Date(),
): string {
  const d = new Date(iso);
  const inicioDeHoy = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dias = Math.floor((inicioDeHoy.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);

  if (dias <= 0) {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  }
  if (dias === 1) return yesterdayLabel;
  if (dias < 7) return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(d);
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: '2-digit' }).format(d);
}
