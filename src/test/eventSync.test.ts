import { describe, it, expect } from 'vitest';
import { toMapEvent, sameInstant, needsServerCheck, type EventRow } from '@/lib/eventSync';
import type { MapEvent } from '@/stores/eventStore';

/** Un evento tal y como quedó en la lista tras pasar por PostgREST. */
const known = (over: Partial<MapEvent> = {}): MapEvent => ({
  id: 'e1',
  creator_id: 'c1',
  title: 'Partido',
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

/** La misma fila tal y como llega por el socket. */
const row = (over: Partial<EventRow> = {}): EventRow => ({
  id: 'e1',
  creator_id: 'c1',
  title: 'Partido',
  category: 'sports',
  lng: -100.28,
  lat: 25.65,
  address: null,
  description: null,
  starts_at: '2026-09-01T18:00:00+00:00',
  ends_at: '2026-09-01T20:00:00+00:00',
  max_spots: 10,
  current_spots: 3,
  privacy: 'open',
  is_active: true,
  is_recurring: false,
  recurrence_rule: null,
  repeated_from: null,
  institution_id: 'i1',
  created_at: '2026-08-01T00:00:00+00:00',
  start_push_sent_at: null,
  recommended_at: null,
  ...over,
});

describe('sameInstant', () => {
  it('reconoce el mismo instante escrito de otra forma', () => {
    // Es el caso real: PostgREST devuelve una y el socket puede devolver otra.
    // Comparando cadenas darían distinto y la optimización no se aplicaría nunca.
    expect(sameInstant('2026-09-01T20:00:00+00:00', '2026-09-01T20:00:00.000Z')).toBe(true);
  });

  it('distingue instantes de verdad distintos', () => {
    expect(sameInstant('2026-09-01T20:00:00Z', '2026-09-01T21:00:00Z')).toBe(false);
  });

  it('ante algo que no es una fecha, cae a comparar el texto', () => {
    expect(sameInstant('vaya', 'vaya')).toBe(true);
    expect(sameInstant('vaya', 'otra')).toBe(false);
  });
});

describe('toMapEvent', () => {
  it('junta lng y lat en location', () => {
    expect(toMapEvent(row()).location).toEqual({ lng: -100.28, lat: 25.65 });
  });

  it('sin coordenadas deja location en null, y no en un punto en el golfo de Guinea', () => {
    expect(toMapEvent(row({ lng: null, lat: null })).location).toBeNull();
    expect(toMapEvent(row({ lat: null })).location).toBeNull();
  });

  it('no confunde una coordenada 0 con una coordenada ausente', () => {
    expect(toMapEvent(row({ lng: 0, lat: 0 })).location).toEqual({ lng: 0, lat: 0 });
  });
});

describe('needsServerCheck', () => {
  // El camino frecuente, y la razón de ser de todo esto.
  it('el aforo cambiando se aplica sin preguntar', () => {
    expect(needsServerCheck(known(), row({ current_spots: 4 }))).toBe(false);
  });

  it('editar título o sitio tampoco obliga a preguntar', () => {
    expect(needsServerCheck(known(), row({ title: 'Otro', lng: -99 }))).toBe(false);
  });

  it('un evento que no estaba en la lista siempre se pregunta', () => {
    // Es lo que impide que el payload conceda visibilidad por su cuenta.
    expect(needsServerCheck(undefined, row())).toBe(true);
  });

  it('si cambia la privacidad se pregunta: la amistad no se puede comprobar aquí', () => {
    expect(needsServerCheck(known(), row({ privacy: 'friends' }))).toBe(true);
    expect(needsServerCheck(known({ privacy: 'friends' }), row({ privacy: 'open' }))).toBe(true);
  });

  it('si lo cancelan se pregunta', () => {
    expect(needsServerCheck(known(), row({ is_active: false }))).toBe(true);
  });

  it('si mueven la hora de fin se pregunta', () => {
    expect(needsServerCheck(known(), row({ ends_at: '2026-09-01T23:00:00+00:00' }))).toBe(true);
  });

  it('la misma hora de fin en otro formato NO obliga a preguntar', () => {
    expect(needsServerCheck(known(), row({ ends_at: '2026-09-01T20:00:00.000Z' }))).toBe(false);
  });
});
