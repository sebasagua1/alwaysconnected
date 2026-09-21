import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isWithinCheckInWindow, CHECK_IN_GRACE_MS } from '@/lib/eventWindow';

const MIN = 60 * 1000;

// Un evento cualquiera: empieza a las 12:00 y acaba a las 14:00.
const START = Date.parse('2026-09-20T12:00:00.000Z');
const END = Date.parse('2026-09-20T14:00:00.000Z');
const starts = new Date(START).toISOString();
const ends = new Date(END).toISOString();

describe('isWithinCheckInWindow', () => {
  it('abre 15 minutos antes de empezar', () => {
    expect(isWithinCheckInWindow(starts, ends, START - 15 * MIN)).toBe(true);
  });

  it('sigue cerrada 16 minutos antes', () => {
    expect(isWithinCheckInWindow(starts, ends, START - 16 * MIN)).toBe(false);
  });

  it('esta abierta durante el evento', () => {
    expect(isWithinCheckInWindow(starts, ends, START)).toBe(true);
    expect(isWithinCheckInWindow(starts, ends, START + 60 * MIN)).toBe(true);
  });

  it('cierra justo al terminar', () => {
    expect(isWithinCheckInWindow(starts, ends, END)).toBe(true);
    expect(isWithinCheckInWindow(starts, ends, END + 1)).toBe(false);
  });

  it('acepta Date igual que string', () => {
    const t = START - 10 * MIN;
    expect(isWithinCheckInWindow(new Date(START), new Date(END), t)).toBe(true);
  });

  it('con una fecha ilegible no abre', () => {
    // Mejor no ensenar el boton que ensenarlo y comerse un
    // OUTSIDE_EVENT_WINDOW del servidor.
    expect(isWithinCheckInWindow('no-es-una-fecha', ends, START)).toBe(false);
    expect(isWithinCheckInWindow(starts, 'no-es-una-fecha', START)).toBe(false);
  });

  it('un evento ya terminado no reabre', () => {
    expect(isWithinCheckInWindow(starts, ends, END + 24 * 60 * MIN)).toBe(false);
  });
});

// Esta es la prueba que importa: el fallo original no fue que la funcion
// estuviera mal, sino que la app y la base de datos discrepaban en silencio.
// Si alguien cambia el margen en SQL, esto falla y le dice donde mirar.
describe('el margen coincide con el que aplica la base de datos', () => {
  const sql = readFileSync(
    resolve(__dirname, '../../supabase/setup/full_schema.sql'),
    'utf8',
  );

  it('check_in_to_event usa el mismo margen que CHECK_IN_GRACE_MS', () => {
    const encontrados = [
      ...sql.matchAll(/starts_at\s*-\s*interval\s*'(\d+)\s*minutes'/g),
    ].map(m => Number(m[1]));

    expect(encontrados.length).toBeGreaterThan(0);

    const enMinutos = CHECK_IN_GRACE_MS / MIN;
    for (const minutos of encontrados) {
      expect(minutos).toBe(enMinutos);
    }
  });
});
