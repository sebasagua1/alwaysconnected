import type { MapEvent } from '@/stores/eventStore';

/**
 * Qué eventos se enseñan, según la categoría, lo escrito en el buscador y los
 * filtros de cuándo, duración y tipo.
 *
 * Vive aquí y no en cada pantalla porque lo usan dos: los marcadores del mapa
 * y la vista de lista. Escrito por duplicado, cualquier retoque en uno dejaba
 * al otro enseñando algo distinto sobre los mismos datos.
 *
 * Todo se calcula con la hora local del teléfono: "hoy" y "mañana" son los de
 * quien mira, no los del servidor.
 */

/**
 * Cuándo. Los atajos existen para no tener que recorrer la lista a mano: quien
 * quiere algo ya toca "Ahora" y listo.
 */
export type WhenPreset = 'any' | 'now' | 'next3h' | 'today' | 'tomorrow' | 'weekend' | 'week' | 'range';
export const WHEN_PRESETS: WhenPreset[] = ['now', 'next3h', 'today', 'tomorrow', 'weekend', 'week', 'range'];

/** Parte del día en que EMPIEZA el evento. */
export type DayPart = 'morning' | 'afternoon' | 'evening';
export const DAY_PARTS: DayPart[] = ['morning', 'afternoon', 'evening'];

/** Por los tramos que ofrece el formulario de crear (30 min a 4 h). */
export type DurationBucket = 'short' | 'medium' | 'long';
export const DURATION_BUCKETS: DurationBucket[] = ['short', 'medium', 'long'];

/** Entrada directa (público o amigos) o con aprobación de quien organiza. */
export type AccessKind = 'direct' | 'approval';
/** Íntimo: hasta 5 lugares. Grupal: 6 o más. */
export type GroupSize = 'small' | 'large';

export const SMALL_GROUP_MAX = 5;
/** "Ahora" también incluye lo que empieza dentro de este margen. */
export const NOW_WINDOW_MIN = 60;

export interface AdvancedFilters {
  when: WhenPreset;
  /** 'YYYY-MM-DD', ambos incluidos. Solo cuentan con when = 'range'. */
  rangeFrom: string | null;
  rangeTo: string | null;
  dayParts: DayPart[];
  durations: DurationBucket[];
  access: AccessKind | null;
  size: GroupSize | null;
  onlyWithSpots: boolean;
}

export const DEFAULT_ADVANCED_FILTERS: AdvancedFilters = {
  when: 'any',
  rangeFrom: null,
  rangeTo: null,
  dayParts: [],
  durations: [],
  access: null,
  size: null,
  onlyWithSpots: false,
};

export interface EventFilter extends Partial<AdvancedFilters> {
  category: string | null;
  /** Tal cual lo escribe la persona; aquí se normaliza. */
  query: string;
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** 'YYYY-MM-DD' en hora local. */
export const toDateKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const fromDateKey = (key: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * El intervalo [from, to) que cubre cada atajo, o null si no limita nada.
 *
 * Fin de semana: el próximo sábado y domingo; si ya es fin de semana, el
 * actual. "Esta semana" son los próximos 7 días y no "hasta el domingo": un
 * domingo por la noche, "hasta el domingo" dejaba la lista vacía.
 */
export function whenInterval(f: Pick<AdvancedFilters, 'when' | 'rangeFrom' | 'rangeTo'>, now: Date): [Date, Date] | null {
  const today = startOfDay(now);
  switch (f.when) {
    case 'now':
      return [now, new Date(now.getTime() + NOW_WINDOW_MIN * MIN)];
    case 'next3h':
      return [now, new Date(now.getTime() + 3 * HOUR)];
    case 'today':
      return [today, addDays(today, 1)];
    case 'tomorrow':
      return [addDays(today, 1), addDays(today, 2)];
    case 'weekend': {
      const dow = today.getDay(); // 0 domingo, 6 sábado
      const saturday = dow === 0 ? addDays(today, -1) : addDays(today, (6 - dow) % 7);
      return [saturday, addDays(saturday, 2)];
    }
    case 'week':
      return [today, addDays(today, 7)];
    case 'range': {
      const from = f.rangeFrom ? fromDateKey(f.rangeFrom) : null;
      const to = f.rangeTo ? fromDateKey(f.rangeTo) : from;
      if (!from || !to) return null;
      const [a, b] = from <= to ? [from, to] : [to, from];
      return [a, addDays(b, 1)];
    }
    default:
      return null;
  }
}

/**
 * Coincide si el evento está ocurriendo en algún momento del intervalo, no
 * solo si empieza dentro: un partido que empezó hace 20 minutos sí es "ahora".
 */
const overlaps = (event: MapEvent, [from, to]: [Date, Date]) =>
  new Date(event.starts_at) < to && new Date(event.ends_at) > from;

export const dayPartOf = (d: Date): DayPart => {
  const h = d.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 19) return 'afternoon';
  return 'evening';
};

export const durationBucketOf = (event: MapEvent): DurationBucket => {
  const mins = (new Date(event.ends_at).getTime() - new Date(event.starts_at).getTime()) / MIN;
  if (mins <= 60) return 'short';
  if (mins <= 120) return 'medium';
  return 'long';
};

export const matchesFilter = (event: MapEvent, filter: EventFilter, now: Date = new Date()): boolean => {
  const { category, query } = filter;
  if (category && event.category !== category) return false;
  const q = query.trim().toLowerCase();
  if (q && !event.title.toLowerCase().includes(q)) return false;

  const interval = filter.when ? whenInterval({ when: filter.when, rangeFrom: filter.rangeFrom ?? null, rangeTo: filter.rangeTo ?? null }, now) : null;
  if (interval && !overlaps(event, interval)) return false;

  if (filter.dayParts?.length && !filter.dayParts.includes(dayPartOf(new Date(event.starts_at)))) return false;
  if (filter.durations?.length && !filter.durations.includes(durationBucketOf(event))) return false;

  if (filter.access === 'approval' && event.privacy !== 'private') return false;
  if (filter.access === 'direct' && event.privacy === 'private') return false;

  if (filter.size === 'small' && event.max_spots > SMALL_GROUP_MAX) return false;
  if (filter.size === 'large' && event.max_spots <= SMALL_GROUP_MAX) return false;

  if (filter.onlyWithSpots && event.current_spots >= event.max_spots) return false;
  return true;
};

export const filterEvents = (events: MapEvent[], filter: EventFilter, now: Date = new Date()): MapEvent[] =>
  events.filter((e) => matchesFilter(e, filter, now));

/** Cuántos grupos de filtros avanzados están activos, para el globo del botón. */
export const countActiveFilters = (f: AdvancedFilters): number =>
  [
    f.when !== 'any' && whenInterval(f, new Date()) !== null,
    f.dayParts.length > 0,
    f.durations.length > 0,
    f.access !== null,
    f.size !== null,
    f.onlyWithSpots,
  ].filter(Boolean).length;

/** Si hace falta recalcular con el paso del tiempo ("Ahora" caduca solo). */
export const dependsOnClock = (f: Pick<AdvancedFilters, 'when'>): boolean => f.when !== 'any' && f.when !== 'range';

/**
 * Cómo se agrupa la lista: una cabecera por día. Devuelve 'today', 'tomorrow'
 * o la clave del día. Lo que ya está en curso cae en 'today' aunque empezara
 * ayer.
 */
export function dayGroupKey(event: MapEvent, now: Date): string {
  const today = startOfDay(now);
  const start = new Date(event.starts_at);
  if (start < addDays(today, 1)) return 'today';
  if (start < addDays(today, 2)) return 'tomorrow';
  return toDateKey(start);
}

/** "En curso", "en 25 min" o null si falta más de una hora. */
export function startsSoon(event: MapEvent, now: Date): { kind: 'live' } | { kind: 'soon'; minutes: number } | null {
  const start = new Date(event.starts_at).getTime();
  const end = new Date(event.ends_at).getTime();
  const t = now.getTime();
  if (start <= t && t < end) return { kind: 'live' };
  const minutes = Math.ceil((start - t) / MIN);
  if (minutes > 0 && minutes <= NOW_WINDOW_MIN) return { kind: 'soon', minutes };
  return null;
}
