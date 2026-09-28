import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatEventWhen, formatShortDay, startsSoonMinutes, uses24h, meridiemLabels, regionalLocale } from '@/lib/datetime';

const labels = {
  now: 'Ahora',
  today: 'Hoy',
  tomorrow: 'Mañana',
  until: (time: string) => `hasta ${time}`,
};

// Sábado 26 de septiembre de 2026, 15:00 hora local.
const NOW = new Date(2026, 8, 26, 15, 0);
const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString();

function conIdiomas(langs: string[]) {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(langs);
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(langs[0]);
}

afterEach(() => vi.restoreAllMocks());

describe('formatEventWhen', () => {
  it('un evento en curso dice «Ahora» y hasta cuándo', () => {
    conIdiomas(['es-ES']);
    expect(formatEventWhen(at(26, 14), at(26, 21), 'es', labels, { now: NOW })).toBe('Ahora · hasta 21:00');
  });

  it('hoy y mañana se dicen con palabras, con el rango si se pide', () => {
    conIdiomas(['es-ES']);
    expect(formatEventWhen(at(26, 19), at(26, 21), 'es', labels, { now: NOW, range: true })).toBe('Hoy · 19:00 – 21:00');
    expect(formatEventWhen(at(27, 10), at(27, 12), 'es', labels, { now: NOW })).toBe('Mañana · 10:00');
  });

  it('más allá, día de la semana y fecha corta, sin «PM» en español', () => {
    conIdiomas(['es-ES']);
    const txt = formatEventWhen(at(29, 18), at(29, 20), 'es', labels, { now: NOW });
    expect(txt).toBe('mar 29 sep · 18:00');
    expect(txt).not.toMatch(/PM|AM/);
  });

  it('en México la hora va en 12 h con a.m./p.m.', () => {
    conIdiomas(['es-MX']);
    expect(uses24h('es')).toBe(false);
    const txt = formatEventWhen(at(26, 19), null, 'es', labels, { now: NOW });
    expect(txt).toMatch(/^Hoy · 7:00\s?p\.\s?m\.$/);
  });

  it('en inglés, formato inglés', () => {
    conIdiomas(['en-US']);
    expect(formatShortDay(new Date(2026, 8, 29), 'en')).toBe('Tue, Sep 29');
    expect(meridiemLabels('en')).toEqual(['AM', 'PM']);
  });
});

describe('regionalLocale', () => {
  it('usa la variante del sistema si es del mismo idioma', () => {
    conIdiomas(['es-CO', 'en-US']);
    expect(regionalLocale('es')).toBe('es-CO');
    expect(regionalLocale('en')).toBe('en-US');
  });

  it('sin variante del sistema, una por defecto', () => {
    conIdiomas(['fr-FR']);
    expect(regionalLocale('es')).toBe('es-MX');
  });
});

describe('startsSoonMinutes', () => {
  it('solo dentro de la próxima hora', () => {
    expect(startsSoonMinutes(at(26, 15, 20), NOW)).toBe(20);
    expect(startsSoonMinutes(at(26, 17), NOW)).toBeNull();
    expect(startsSoonMinutes(at(26, 14), NOW)).toBeNull();
  });
});
