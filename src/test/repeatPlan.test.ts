import { describe, it, expect } from 'vitest';
import { buildRepeatDraft, nextSameSlot } from '@/lib/repeatPlan';
import type { MapEvent } from '@/stores/eventStore';

const ev = (over: Partial<MapEvent> = {}): MapEvent => ({
  id: 'e1', creator_id: 'c', title: 'Pádel', category: 'sports', location: { lng: -100.4, lat: 20.6 },
  address: 'Calle Epigmenio González', description: 'Traigan raqueta',
  starts_at: new Date(2026, 8, 15, 10, 0).toISOString(), ends_at: new Date(2026, 8, 15, 11, 30).toISOString(),
  max_spots: 4, current_spots: 3, privacy: 'friends', is_active: true, ...over,
});

describe('repetir el plan', () => {
  it('propone la misma hora de la semana siguiente', () => {
    const now = new Date(2026, 8, 15, 12, 0);
    expect(nextSameSlot(new Date(2026, 8, 15, 10, 0), now)).toEqual(new Date(2026, 8, 22, 10, 0));
  });

  it('si el evento fue hace semanas, no propone una fecha pasada', () => {
    const now = new Date(2026, 9, 3, 9, 0);
    expect(nextSameSlot(new Date(2026, 8, 15, 10, 0), now)).toEqual(new Date(2026, 9, 6, 10, 0));
  });

  it('copia todo y ajusta la duración al tramo más cercano del formulario', () => {
    const d = buildRepeatDraft(ev(), new Date(2026, 8, 15, 12, 0));
    expect(d).toMatchObject({
      repeatedFrom: 'e1', title: 'Pádel', category: 'sports', address: 'Calle Epigmenio González',
      description: 'Traigan raqueta', maxSpots: 4, privacy: 'friends', location: { lng: -100.4, lat: 20.6 },
    });
    // 90 min: empata entre 60 y 120 y se queda con el primero.
    expect(d.durationMins).toBe(60);
    expect(buildRepeatDraft(ev({ ends_at: new Date(2026, 8, 15, 13, 10).toISOString() })).durationMins).toBe(180);
  });
});
