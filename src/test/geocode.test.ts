import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  buildReverseUrl, pickPlaceName, roundCoord, cacheKey,
  reverseGeocode, _clearCache, COORD_PRECISION,
  buildSearchUrl, parseSearch,
} from '@/lib/geocode';

describe('roundCoord', () => {
  it('recorta a la precisión acordada', () => {
    expect(roundCoord(19.0123456789)).toBe(19.0123);
    expect(String(roundCoord(19.0123456789)).split('.')[1].length).toBeLessThanOrEqual(COORD_PRECISION);
  });
  it('dos puntos a menos de ~11 m comparten clave de caché', () => {
    expect(cacheKey(-98.20001, 19.00001, 'es')).toBe(cacheKey(-98.20002, 19.00002, 'es'));
  });
  it('el idioma forma parte de la clave', () => {
    expect(cacheKey(-98.2, 19, 'es')).not.toBe(cacheKey(-98.2, 19, 'en'));
  });
});

describe('buildReverseUrl', () => {
  it('pone lng,lat en ese orden, que es el de Mapbox', () => {
    const url = buildReverseUrl(-98.2, 19.05, 'tok');
    expect(url).toContain('/-98.2,19.05.json');
  });
  it('lleva token, idioma y limit', () => {
    const url = new URL(buildReverseUrl(-98.2, 19.05, 'tok', 'en'));
    expect(url.searchParams.get('access_token')).toBe('tok');
    expect(url.searchParams.get('language')).toBe('en');
    expect(url.searchParams.get('limit')).toBe('1');
  });
  it('pide primero sitios y luego direcciones', () => {
    const tipos = new URL(buildReverseUrl(0, 0, 't')).searchParams.get('types')!;
    expect(tipos.indexOf('poi')).toBeLessThan(tipos.indexOf('address'));
  });
});

describe('pickPlaceName', () => {
  it('prefiere el nombre corto', () => {
    expect(pickPlaceName({ features: [{ text: 'Biblioteca Central', place_name: 'Biblioteca Central, Puebla, México' }] }))
      .toBe('Biblioteca Central');
  });
  it('si no hay corto, usa el primer segmento del largo', () => {
    expect(pickPlaceName({ features: [{ place_name: 'Av. Juárez 120, Puebla, México' }] }))
      .toBe('Av. Juárez 120');
  });
  it('sin features devuelve null, no una cadena vacía', () => {
    expect(pickPlaceName({ features: [] })).toBeNull();
    expect(pickPlaceName({})).toBeNull();
    expect(pickPlaceName(null)).toBeNull();
  });
  it('un texto en blanco cuenta como ausente', () => {
    expect(pickPlaceName({ features: [{ text: '   ', place_name: 'Calle Uno, Puebla' }] })).toBe('Calle Uno');
    expect(pickPlaceName({ features: [{ text: '  ' }] })).toBeNull();
  });
});

describe('reverseGeocode', () => {
  beforeEach(() => { _clearCache(); vi.restoreAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const responder = (body: unknown, ok = true) =>
    vi.fn().mockResolvedValue({ ok, json: async () => body });

  it('devuelve el nombre del sitio', async () => {
    vi.stubGlobal('fetch', responder({ features: [{ text: 'Cafetería' }] }));
    await expect(reverseGeocode(-98.2, 19, 'tok')).resolves.toBe('Cafetería');
  });

  it('no llama dos veces al mismo punto', async () => {
    const f = responder({ features: [{ text: 'Cafetería' }] });
    vi.stubGlobal('fetch', f);
    await reverseGeocode(-98.2, 19, 'tok');
    await reverseGeocode(-98.2, 19, 'tok');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('sin token no llega a pedir nada', async () => {
    const f = responder({});
    vi.stubGlobal('fetch', f);
    await expect(reverseGeocode(-98.2, 19, '')).resolves.toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('un 4xx da null, no intenta leer el cuerpo como si fuera bueno', async () => {
    vi.stubGlobal('fetch', responder({ message: 'Not Authorized' }, false));
    await expect(reverseGeocode(-98.2, 19, 'tok')).resolves.toBeNull();
  });

  it('si la red falla, null y NUNCA coordenadas', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const r = await reverseGeocode(-98.2, 19, 'tok');
    expect(r).toBeNull();
    expect(String(r)).not.toContain('98.2');
  });

  it('un fallo no se cachea: se puede reintentar', async () => {
    const f = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ features: [{ text: 'Gimnasio' }] }) });
    vi.stubGlobal('fetch', f);
    await expect(reverseGeocode(-98.2, 19, 'tok')).resolves.toBeNull();
    await expect(reverseGeocode(-98.2, 19, 'tok')).resolves.toBe('Gimnasio');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('un "sin resultados" SÍ se cachea: la respuesta fue válida', async () => {
    const f = responder({ features: [] });
    vi.stubGlobal('fetch', f);
    await expect(reverseGeocode(-98.2, 19, 'tok')).resolves.toBeNull();
    await expect(reverseGeocode(-98.2, 19, 'tok')).resolves.toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });
});


describe('búsqueda de lugares', () => {
  it('pide cerca del punto dado y con autocompletado', () => {
    const url = new URL(buildSearchUrl(' biblioteca ', 'tok', 'es', { lng: -74.07851, lat: 4.63159 }));
    expect(url.pathname).toMatch(/\/biblioteca\.json$/);
    expect(url.searchParams.get('proximity')).toBe('-74.0785,4.6316');
    expect(url.searchParams.get('autocomplete')).toBe('true');
    // Y solo dentro de la ciudad: con proximity sola salían resultados de otro país.
    expect(url.searchParams.get('bbox')).toBe('-74.2585,4.4516,-73.8985,4.8116');
  });

  it('separa el nombre del resto de la dirección y descarta lo que no tiene punto', () => {
    const r = parseSearch({
      features: [
        { id: 'a', text: 'Biblioteca Central', place_name: 'Biblioteca Central, Calle 45, Bogotá', center: [-74.1, 4.6] },
        { id: 'b', text: 'Sin punto', place_name: 'Sin punto, X' },
      ],
    });
    expect(r).toEqual([{ id: 'a', name: 'Biblioteca Central', detail: 'Calle 45, Bogotá', lng: -74.1, lat: 4.6 }]);
  });
});
