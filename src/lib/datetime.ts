/** Combina una fecha (se ignora su hora) con un "HH:MM". */
export function combineDateTime(date: Date, time: string): Date {
  const [hours, mins] = time.split(':').map(Number);
  const d = new Date(date);
  d.setHours(hours || 0, mins || 0, 0, 0);
  return d;
}

/** La hora de un Date en el "HH:MM" que guardan los formularios. */
export function toTimeValue(date: Date): string {
  return `${date.getHours().toString().padStart(2, '0')}:${date
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

/* -------------------------------------------------------------------------
   Cómo se escribe CUÁNDO es un evento.

   Antes había tres formatos distintos: la ficha y Mis eventos decían
   «sep 28, 7:02 PM» (orden y «PM» ingleses en pantalla en español), la lista
   «dom 28 sep · 19:02», y Mis eventos añadía «en alrededor de 2 horas». Todo
   pasa ahora por aquí.
   ------------------------------------------------------------------------- */

/**
 * El locale con región que corresponde al idioma de la app.
 *
 * La app solo distingue «es» y «en», pero la hora se escribe distinto en cada
 * país: «19:00» en España, «7:00 p.m.» en México o Colombia. Si el sistema
 * está en una variante de ese idioma, se usa la del sistema.
 */
export function regionalLocale(lang: string): string {
  const base = (lang || 'es').slice(0, 2).toLowerCase();
  const sistema = typeof navigator !== 'undefined'
    ? (navigator.languages?.length ? navigator.languages : [navigator.language])
    : [];
  const match = sistema.find((l) => l && l.toLowerCase().startsWith(`${base}-`));
  if (match) return match;
  return base === 'en' ? 'en-US' : 'es-MX';
}

/** Si en ese locale la hora va de 0 a 23 o de 1 a 12 con a.m./p.m. */
export function uses24h(lang: string): boolean {
  // hourCycle existe en todos los motores actuales, pero el lib de TS de este
  // proyecto no lo declara.
  const opts = new Intl.DateTimeFormat(regionalLocale(lang), { hour: 'numeric' }).resolvedOptions() as
    Intl.ResolvedDateTimeFormatOptions & { hourCycle?: string };
  const cycle = opts.hourCycle;
  return cycle === 'h23' || cycle === 'h24';
}

/** Las dos marcas de 12 h en ese idioma: «a.m.»/«p.m.» o «AM»/«PM». */
export function meridiemLabels(lang: string): [string, string] {
  const fmt = new Intl.DateTimeFormat(regionalLocale(lang), { hour: 'numeric', hour12: true });
  const periodo = (h: number) =>
    fmt.formatToParts(new Date(2020, 0, 1, h)).find((p) => p.type === 'dayPeriod')?.value ?? (h < 12 ? 'AM' : 'PM');
  return [periodo(9), periodo(21)];
}

/** «19:00» o «7:00 p.m.», según la región. */
export function formatTime(d: Date, lang: string): string {
  return new Intl.DateTimeFormat(regionalLocale(lang), { hour: 'numeric', minute: '2-digit' }).format(d);
}

function mismoDia(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** «sáb 27 sep» / «Sat, Sep 27». */
export function formatShortDay(d: Date, lang: string): string {
  const en = lang.startsWith('en');
  const partes = new Intl.DateTimeFormat(en ? 'en-US' : 'es-MX', { weekday: 'short', day: 'numeric', month: 'short' })
    .formatToParts(d);
  const val = (type: string) => partes.find((p) => p.type === type)?.value ?? '';
  // Intl pone comas y a veces «sept.»; se arma a mano para que quede igual
  // en todos los motores.
  const mes = val('month').replace(/\.$/, '').slice(0, 3);
  const dia = val('weekday').replace(/\.$/, '');
  return en ? `${dia}, ${mes} ${val('day')}` : `${dia} ${val('day')} ${mes}`;
}

export interface WhenLabels {
  now: string;
  today: string;
  tomorrow: string;
  /** Con {{time}}: «hasta {{time}}». */
  until: (time: string) => string;
}

/**
 * «Ahora · hasta 21:00», «Hoy · 19:00 – 21:00», «Mañana · 10:00» o
 * «sáb 27 sep · 18:00 – 20:00».
 *
 * `range` añade la hora de fin: la ficha del evento no decía nunca a qué hora
 * terminaba.
 */
export function formatEventWhen(
  startIso: string,
  endIso: string | null,
  lang: string,
  labels: WhenLabels,
  { range = false, now = new Date() }: { range?: boolean; now?: Date } = {},
): string {
  const start = new Date(startIso);
  const end = endIso ? new Date(endIso) : null;

  if (end && start <= now && now < end) {
    return `${labels.now} · ${labels.until(formatTime(end, lang))}`;
  }

  const manana = new Date(now);
  manana.setDate(now.getDate() + 1);
  const dia = mismoDia(start, now)
    ? labels.today
    : mismoDia(start, manana)
      ? labels.tomorrow
      : formatShortDay(start, lang);

  const horas = range && end
    ? `${formatTime(start, lang)} – ${formatTime(end, lang)}`
    : formatTime(start, lang);
  return `${dia} · ${horas}`;
}

/**
 * «en 20 min» cuando falta menos de una hora, y nada en otro caso: con
 * «Hoy · 19:00» ya está dicho, y el «en alrededor de 2 horas» de antes solo
 * repetía la fecha con peores palabras.
 */
export function startsSoonMinutes(startIso: string, now: Date = new Date()): number | null {
  const min = Math.round((new Date(startIso).getTime() - now.getTime()) / 60_000);
  return min > 0 && min < 60 ? min : null;
}
