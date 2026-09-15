import { describe, it, expect } from 'vitest';
import {
  matchesFilter, filterEvents, whenInterval, countActiveFilters, dependsOnClock, dayGroupKey, startsSoon,
  DEFAULT_ADVANCED_FILTERS, type EventFilter,
} from '@/lib/eventFilter';
import type { MapEvent } from '@/stores/eventStore';

const ev = (over: Partial<MapEvent> = {}): MapEvent => ({
  id: 'e1',
  creator_id: 'c1',
  title: 'Partido de fútbol',
  category: 'sports',
  location: { lng: -100.28, lat: 25.65 },
  address: null,
  description: null,
  starts_at: '2026-09-01T18:00:00+00:00',
  ends_at: '2026-09-01T20:00:00+00:00',
  max_spots: 10,
  current_spots: 3,
  privacy: 'open',
  is_active: true,
  ...over,
});

const todo = { category: null, query: '' };

describe('matchesFilter', () => {
  it('sin filtros lo enseña todo', () => {
    expect(matchesFilter(ev(), todo)).toBe(true);
  });

  it('filtra por categoría', () => {
    expect(matchesFilter(ev(), { ...todo, category: 'sports' })).toBe(true);
    expect(matchesFilter(ev(), { ...todo, category: 'study' })).toBe(false);
  });

  it('busca dentro del título, no solo por el principio', () => {
    expect(matchesFilter(ev(), { ...todo, query: 'fútbol' })).toBe(true);
    expect(matchesFilter(ev(), { ...todo, query: 'Partido' })).toBe(true);
  });

  it('la búsqueda no distingue mayúsculas', () => {
    expect(matchesFilter(ev(), { ...todo, query: 'FÚTBOL' })).toBe(true);
  });

  it('los espacios sueltos no vacían el mapa', () => {
    // Se escribe un espacio y se borra: sin el trim, "   " no casaba con nada
    // y desaparecían todos los pines.
    expect(matchesFilter(ev(), { ...todo, query: '   ' })).toBe(true);
    expect(matchesFilter(ev(), { ...todo, query: '  fútbol  ' })).toBe(true);
  });

  it('categoría y búsqueda se aplican a la vez', () => {
    expect(matchesFilter(ev(), { category: 'sports', query: 'fútbol' })).toBe(true);
    expect(matchesFilter(ev(), { category: 'study', query: 'fútbol' })).toBe(false);
    expect(matchesFilter(ev(), { category: 'sports', query: 'cine' })).toBe(false);
  });
});

describe('filterEvents', () => {
  it('conserva el orden de la lista', () => {
    const lista = [ev({ id: 'a' }), ev({ id: 'b', title: 'Cine' }), ev({ id: 'c' })];
    expect(filterEvents(lista, todo).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('deja fuera lo que no casa', () => {
    const lista = [ev({ id: 'a' }), ev({ id: 'b', title: 'Cine', category: 'social' })];
    expect(filterEvents(lista, { category: null, query: 'cine' }).map((e) => e.id)).toEqual(['b']);
  });
});

describe('filtros de cuándo, hora, duración y tipo', () => {
  // Martes 15 de septiembre de 2026, 10:00 hora local. Todo en hora local para
  // que la prueba no dependa de la zona horaria de la máquina.
  const now = new Date(2026, 8, 15, 10, 0);
  const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString();
  const en = (d: number, h: number, horas = 1, m = 0, over: Partial<MapEvent> = {}) =>
    ev({ starts_at: at(d, h, m), ends_at: new Date(new Date(2026, 8, d, h, m).getTime() + horas * 3_600_000).toISOString(), ...over });
  const pasa = (e: MapEvent, f: Partial<EventFilter>) => matchesFilter(e, { ...todo, ...f }, now);

  it('"Ahora": lo que ya empezó y lo que empieza en menos de una hora', () => {
    expect(pasa(en(15, 9, 2), { when: 'now' })).toBe(true); // empezó a las 9, sigue
    expect(pasa(en(15, 10, 1, 50), { when: 'now' })).toBe(true);
    expect(pasa(en(15, 11, 1, 30), { when: 'now' })).toBe(false);
  });

  it('"Próximas 3 h" y "Hoy"', () => {
    expect(pasa(en(15, 12, 1, 30), { when: 'next3h' })).toBe(true);
    expect(pasa(en(15, 14), { when: 'next3h' })).toBe(false);
    expect(pasa(en(15, 22), { when: 'today' })).toBe(true);
    expect(pasa(en(16, 8), { when: 'today' })).toBe(false);
  });

  it('"Mañana", "Fin de semana" y "Próximos 7 días"', () => {
    expect(pasa(en(16, 13), { when: 'tomorrow' })).toBe(true);
    expect(pasa(en(15, 13), { when: 'tomorrow' })).toBe(false);
    expect(pasa(en(19, 11), { when: 'weekend' })).toBe(true); // sábado
    expect(pasa(en(20, 18), { when: 'weekend' })).toBe(true); // domingo
    expect(pasa(en(21, 9), { when: 'weekend' })).toBe(false); // lunes
    expect(pasa(en(21, 9), { when: 'week' })).toBe(true);
    expect(pasa(en(23, 14), { when: 'week' })).toBe(false);
  });

  it('en domingo, "Fin de semana" es el de hoy y no el siguiente', () => {
    const domingo = new Date(2026, 8, 20, 10, 0);
    const [from, to] = whenInterval({ when: 'weekend', rangeFrom: null, rangeTo: null }, domingo)!;
    expect(from).toEqual(new Date(2026, 8, 19));
    expect(to).toEqual(new Date(2026, 8, 21));
  });

  it('rango de días: incluye el último día entero y acepta un solo día', () => {
    const rango = { when: 'range' as const, rangeFrom: '2026-09-17', rangeTo: '2026-09-18' };
    expect(pasa(en(17, 11), rango)).toBe(true);
    expect(pasa(en(18, 23), rango)).toBe(true);
    expect(pasa(en(19, 0, 1, 30), rango)).toBe(false);
    expect(pasa(en(17, 11), { when: 'range', rangeFrom: '2026-09-17', rangeTo: null })).toBe(true);
    expect(pasa(en(18, 11), { when: 'range', rangeFrom: '2026-09-17', rangeTo: null })).toBe(false);
    // Rango sin fechas: no filtra nada en vez de vaciar el mapa.
    expect(pasa(en(30, 11), { when: 'range', rangeFrom: null, rangeTo: null })).toBe(true);
  });

  it('hora de inicio: mañana, tarde y noche se combinan', () => {
    expect(pasa(en(16, 8), { dayParts: ['morning'] })).toBe(true);
    expect(pasa(en(16, 12), { dayParts: ['morning'] })).toBe(false);
    expect(pasa(en(16, 18, 1, 59), { dayParts: ['afternoon'] })).toBe(true);
    expect(pasa(en(16, 19), { dayParts: ['afternoon', 'evening'] })).toBe(true);
    expect(pasa(en(16, 2), { dayParts: ['evening'] })).toBe(true);
  });

  it('duración por los tramos del formulario de crear', () => {
    expect(pasa(en(16, 10, 0.5), { durations: ['short'] })).toBe(true);
    expect(pasa(en(16, 10, 1), { durations: ['short'] })).toBe(true);
    expect(pasa(en(16, 10, 2), { durations: ['medium'] })).toBe(true);
    expect(pasa(en(16, 10, 3), { durations: ['medium'] })).toBe(false);
    expect(pasa(en(16, 10, 4), { durations: ['short', 'long'] })).toBe(true);
  });

  it('tipo de experiencia: acceso, tamaño y lugares libres', () => {
    expect(pasa(ev({ privacy: 'private' }), { access: 'approval' })).toBe(true);
    expect(pasa(ev({ privacy: 'friends' }), { access: 'approval' })).toBe(false);
    expect(pasa(ev({ privacy: 'friends' }), { access: 'direct' })).toBe(true);
    expect(pasa(ev({ max_spots: 5 }), { size: 'small' })).toBe(true);
    expect(pasa(ev({ max_spots: 6 }), { size: 'small' })).toBe(false);
    expect(pasa(ev({ max_spots: 6 }), { size: 'large' })).toBe(true);
    expect(pasa(ev({ max_spots: 4, current_spots: 4 }), { onlyWithSpots: true })).toBe(false);
    expect(pasa(ev({ max_spots: 4, current_spots: 3 }), { onlyWithSpots: true })).toBe(true);
  });

  it('todo junto se aplica a la vez', () => {
    const f = { when: 'tomorrow' as const, dayParts: ['afternoon' as const], durations: ['short' as const], category: 'sports' };
    expect(pasa(en(16, 13, 1), f)).toBe(true);
    expect(pasa(en(16, 13, 2), f)).toBe(false);
    expect(pasa(en(16, 9, 1), f)).toBe(false);
  });

  it('cuenta los grupos activos y sabe cuándo depende del reloj', () => {
    expect(countActiveFilters(DEFAULT_ADVANCED_FILTERS)).toBe(0);
    expect(countActiveFilters({ ...DEFAULT_ADVANCED_FILTERS, when: 'today', dayParts: ['morning', 'evening'], onlyWithSpots: true })).toBe(3);
    // "Elegir días" sin días elegidos todavía no filtra, así que no cuenta.
    expect(countActiveFilters({ ...DEFAULT_ADVANCED_FILTERS, when: 'range' })).toBe(0);
    expect(dependsOnClock({ when: 'now' })).toBe(true);
    expect(dependsOnClock({ when: 'range' })).toBe(false);
  });

  it('agrupa por día y avisa de lo que está en curso o empieza pronto', () => {
    expect(dayGroupKey(en(15, 9, 3), now)).toBe('today');
    expect(dayGroupKey(en(16, 9), now)).toBe('tomorrow');
    expect(dayGroupKey(en(23, 9), now)).toBe('2026-09-23');
    expect(startsSoon(en(15, 9, 2), now)).toEqual({ kind: 'live' });
    expect(startsSoon(en(15, 10, 1, 25), now)).toEqual({ kind: 'soon', minutes: 25 });
    expect(startsSoon(en(15, 12), now)).toBeNull();
  });
});
