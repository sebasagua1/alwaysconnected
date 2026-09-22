import type { MapEvent } from '@/stores/eventStore';

/** Lo que "Repetir el plan" le pasa al formulario de crear. */
export interface RepeatDraft {
  repeatedFrom: string;
  title: string;
  category: string;
  address: string | null;
  description: string | null;
  maxSpots: number;
  privacy: string;
  durationMins: number;
  startsAt: Date;
  location: { lng: number; lat: number } | null;
}

/** Los tramos del formulario de crear; la duración se ajusta al más cercano. */
export const DURATION_STEPS = [30, 60, 120, 180, 240];

/**
 * La misma hora de la semana siguiente que todavía no haya pasado. Si el
 * evento fue hace tres semanas, no propone una fecha en el pasado. Se suma
 * en hora local para que un cambio de horario no mueva la hora.
 */
export function nextSameSlot(startsAt: Date, now: Date = new Date()): Date {
  const d = new Date(startsAt);
  do {
    d.setDate(d.getDate() + 7);
  } while (d.getTime() <= now.getTime());
  return d;
}

export function buildRepeatDraft(event: MapEvent, now: Date = new Date()): RepeatDraft {
  const start = new Date(event.starts_at);
  const mins = Math.round((new Date(event.ends_at).getTime() - start.getTime()) / 60000);
  const durationMins = DURATION_STEPS.reduce((best, step) => (Math.abs(step - mins) < Math.abs(best - mins) ? step : best));
  return {
    repeatedFrom: event.id,
    title: event.title,
    category: event.category,
    address: event.address,
    description: event.description,
    maxSpots: event.max_spots,
    privacy: event.privacy,
    durationMins,
    startsAt: nextSameSlot(start, now),
    location: event.location,
  };
}

