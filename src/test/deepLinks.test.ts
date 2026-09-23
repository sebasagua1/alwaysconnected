import { describe, expect, it, vi } from 'vitest';

// deepLinks.ts importa el cliente de Supabase en la cabecera, y crearlo exige
// VITE_SUPABASE_URL. Sin .env —un clon recién hecho, o un worktree, donde el
// archivo no llega porque está en .gitignore— el módulo revienta al cargarse
// y se cae el archivo entero con "supabaseUrl is required", antes de ejecutar
// una sola prueba. Aquí no se usa: todo lo que se prueba son funciones puras
// de texto. Mismo apaño que en push.test.ts y los demás.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import { AUTH_CALLBACK_URL, authParamsFromUrl, routeFromPath, routeFromPushData, routeFromUrl } from '@/lib/deepLinks';

const UUID = '3f1c8a54-6b2e-4d19-9a70-5c8e1b2d4f60';

describe('routeFromPath', () => {
  it('acepta las rutas que la app tiene', () => {
    expect(routeFromPath('/')).toBe('/');
    expect(routeFromPath('/events')).toBe('/events');
    expect(routeFromPath('/friends')).toBe('/friends');
    expect(routeFromPath('/profile')).toBe('/profile');
  });

  it('normaliza barras de sobra y query/hash', () => {
    expect(routeFromPath('events')).toBe('/events');
    expect(routeFromPath('//events')).toBe('/events');
    expect(routeFromPath('/events?utm=x')).toBe('/events');
    expect(routeFromPath('/events#abajo')).toBe('/events');
  });

  it('acepta un grupo solo si el id es un uuid', () => {
    expect(routeFromPath(`/groups/${UUID}`)).toBe(`/groups/${UUID}`);
    expect(routeFromPath('/groups/1')).toBeNull();
    expect(routeFromPath('/groups/')).toBeNull();
    expect(routeFromPath('/groups')).toBeNull();
  });

  it('rechaza lo que no reconoce', () => {
    expect(routeFromPath('/admin')).toBeNull();
    expect(routeFromPath('/events/borrar')).toBeNull();
  });

  // El id se valida de verdad, no solo "que haya algo".
  it('no deja colar travesía de directorios', () => {
    expect(routeFromPath('/groups/../../etc/passwd')).toBeNull();
    expect(routeFromPath('/groups/..')).toBeNull();
  });
});

describe('routeFromUrl', () => {
  it('entiende el esquema propio, donde el primer segmento cae en host', () => {
    expect(routeFromUrl(`alwaysconnected://groups/${UUID}`)).toBe(`/groups/${UUID}`);
    expect(routeFromUrl('alwaysconnected://friends')).toBe('/friends');
    expect(routeFromUrl('alwaysconnected://events')).toBe('/events');
    expect(routeFromUrl('alwaysconnected://')).toBe('/');
  });

  it('entiende una URL https normal', () => {
    expect(routeFromUrl('https://alwaysconnected.vercel.app/profile')).toBe('/profile');
  });

  it('devuelve null ante basura', () => {
    expect(routeFromUrl('no es una url')).toBeNull();
    expect(routeFromUrl('alwaysconnected://admin')).toBeNull();
  });

  // Aunque el enlace venga de un dominio ajeno, lo único que puede conseguir
  // es abrir una pantalla de la propia app. Nunca se navega fuera.
  it('un dominio ajeno solo puede llevar a rutas internas', () => {
    expect(routeFromUrl('https://sitio-cualquiera.example/friends')).toBe('/friends');
    expect(routeFromUrl('https://sitio-cualquiera.example/robar')).toBeNull();
  });
});

describe('routeFromPushData', () => {
  it('lleva cada tipo de notificación a su pantalla', () => {
    expect(routeFromPushData({ type: 'message', group_id: UUID })).toBe(`/groups/${UUID}`);
    expect(routeFromPushData({ type: 'friend_request', requester_id: UUID })).toBe('/friends');
    // Desde 20260925 van a la ficha exacta del evento, no a la lista.
    expect(routeFromPushData({ type: 'join_request', event_id: UUID })).toBe(`/event/${UUID}`);
    expect(routeFromPushData({ type: 'approval', event_id: UUID })).toBe(`/event/${UUID}`);
    expect(routeFromPushData({ type: 'group_invite', group_id: UUID })).toBe('/friends');
    expect(routeFromPushData({ type: 'event_repeat', event_id: UUID })).toBe(`/event/${UUID}`);
    // El aviso de que el evento empieza abre su ficha, que es donde está el
    // botón de registrar asistencia. Sin id, a "Mis eventos" como antes.
    expect(routeFromPushData({ type: 'event_started', event_id: UUID })).toBe(`/event/${UUID}`);
    expect(routeFromPushData({ type: 'event_started' })).toBe('/events');
  });

  it('aguanta payloads incompletos o desconocidos', () => {
    expect(routeFromPushData({ type: 'message' })).toBeNull();
    expect(routeFromPushData({ type: 'message', group_id: 'no-es-uuid' })).toBeNull();
    expect(routeFromPushData({ type: 'inventado' })).toBeNull();
    expect(routeFromPushData(undefined)).toBeNull();
    expect(routeFromPushData(null)).toBeNull();
    expect(routeFromPushData('cadena')).toBeNull();
  });
});

describe('authParamsFromUrl', () => {
  it('lee la sesión del fragmento (flujo implícito)', () => {
    const params = authParamsFromUrl(
      `${AUTH_CALLBACK_URL}#access_token=abc&refresh_token=def&type=signup`,
    );
    expect(params?.get('access_token')).toBe('abc');
    expect(params?.get('refresh_token')).toBe('def');
    expect(params?.get('type')).toBe('signup');
  });

  it('lee el código de la query (flujo PKCE)', () => {
    expect(authParamsFromUrl(`${AUTH_CALLBACK_URL}?code=xyz`)?.get('code')).toBe('xyz');
  });

  it('reconoce el enlace caducado, que llega sin tokens', () => {
    const params = authParamsFromUrl(
      `${AUTH_CALLBACK_URL}#error=access_denied&error_description=Email+link+is+invalid+or+has+expired`,
    );
    expect(params?.get('error')).toBe('access_denied');
    expect(params?.get('error_description')).toContain('expired');
  });

  it('marca la recuperación de contraseña, que necesita otra pantalla', () => {
    const params = authParamsFromUrl(
      `${AUTH_CALLBACK_URL}#access_token=abc&refresh_token=def&type=recovery`,
    );
    expect(params?.get('type')).toBe('recovery');
  });

  // Un enlace normal no debe pasar por el canje de sesión.
  it('devuelve null para lo que no es un callback de auth', () => {
    expect(authParamsFromUrl(`alwaysconnected://groups/${UUID}`)).toBeNull();
    expect(authParamsFromUrl('alwaysconnected://events')).toBeNull();
    expect(authParamsFromUrl('no es una url')).toBeNull();
  });
});
