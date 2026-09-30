/**
 * El límite de tiempo de las peticiones a Supabase.
 *
 * Es lo que impide que el arranque se quede colgado para siempre: sin él, una
 * renovación de token que no respondía dejaba `getSession()` esperando sin
 * fin (ver src/lib/fetchWithTimeout.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTimeoutFetch, supabaseTimeoutFor, SUPABASE_TIMEOUT_MS } from '@/lib/fetchWithTimeout';

const BASE = 'https://proyecto.supabase.co';

/** Un fetch que no responde nunca: solo termina si le abortan la señal. */
function fetchColgado() {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    }),
  );
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('supabaseTimeoutFor', () => {
  it('pone límite a auth y a la API REST', () => {
    expect(supabaseTimeoutFor(`${BASE}/auth/v1/token?grant_type=refresh_token`)).toBe(SUPABASE_TIMEOUT_MS);
    expect(supabaseTimeoutFor(`${BASE}/rest/v1/profiles?select=*`)).toBe(SUPABASE_TIMEOUT_MS);
  });

  it('no se lo pone a storage ni a las funciones, que pueden tardar de verdad', () => {
    expect(supabaseTimeoutFor(`${BASE}/storage/v1/object/avatars/a.jpg`)).toBeNull();
    expect(supabaseTimeoutFor(`${BASE}/functions/v1/contacts-match`)).toBeNull();
  });
});

describe('createTimeoutFetch', () => {
  it('una renovación de token que no responde falla a los 15 s en vez de colgarse', async () => {
    const base = fetchColgado();
    const f = createTimeoutFetch(base);
    const peticion = f(`${BASE}/auth/v1/token?grant_type=refresh_token`, { method: 'POST' });
    const resultado = expect(peticion).rejects.toMatchObject({ name: 'TimeoutError' });

    await vi.advanceTimersByTimeAsync(SUPABASE_TIMEOUT_MS - 1);
    // Justo antes del límite sigue esperando...
    expect(base.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // ...y en el límite se corta.
    await resultado;
  });

  it('no toca las peticiones sin límite: mismo init, sin señal propia', async () => {
    const respuesta = new Response('ok');
    const base = vi.fn(async () => respuesta);
    const f = createTimeoutFetch(base);
    const init = { method: 'PUT' };
    await expect(f(`${BASE}/storage/v1/object/avatars/a.jpg`, init)).resolves.toBe(respuesta);
    expect(base).toHaveBeenCalledWith(`${BASE}/storage/v1/object/avatars/a.jpg`, init);
  });

  it('respeta la señal de quien llama (la búsqueda cancela la anterior)', async () => {
    const base = fetchColgado();
    const f = createTimeoutFetch(base);
    const quien = new AbortController();
    const peticion = f(`${BASE}/rest/v1/rpc/search_people`, { signal: quien.signal });
    const resultado = expect(peticion).rejects.toBeDefined();
    quien.abort();
    await resultado;
    expect(base.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('si responde a tiempo, no deja el temporizador vivo', async () => {
    const f = createTimeoutFetch(vi.fn(async () => new Response('{}')));
    await f(`${BASE}/rest/v1/profiles`);
    expect(vi.getTimerCount()).toBe(0);
  });
});
