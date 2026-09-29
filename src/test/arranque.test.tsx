/**
 * El arranque: de la pantalla de entrada a la pantalla que toca.
 *
 * Lo que fijan estas pruebas es lo que se veía en el vídeo del 28 de
 * septiembre (la app en la rueda más de 40 s sin salida) y sus primos:
 *   · que una sesión que no se resuelve NO deja la app atrapada: a los 6 s
 *     sale el aviso con Reintentar, dentro de la pantalla de entrada;
 *   · que sin red, a quien tiene la sesión guardada no se le manda al login
 *     como si la hubiera cerrado;
 *   · que si el perfil no llega no se entra con el perfil vacío.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import { AuthRetryableFetchError } from '@supabase/supabase-js';
import i18n from '@/i18n';

type AuthCallback = (event: string, session: unknown) => void;

const SESION = { access_token: 'a', refresh_token: 'r', expires_at: 9999999999, user: { id: 'u1' } };
const PERFIL = { id: 'u1', onboarding_completed: true };

let authCallback: AuthCallback | null = null;
const getSession = vi.fn();
/** Cola de respuestas para la consulta del perfil, en orden. */
let perfiles: Array<{ data: unknown; error: unknown }> = [];

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: () => getSession(),
      onAuthStateChange: (cb: AuthCallback) => {
        authCallback = cb;
        return { data: { subscription: { unsubscribe: () => { authCallback = null; } } } };
      },
      signOut: vi.fn(async () => ({ error: null })),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => perfiles.shift() ?? { data: PERFIL, error: null },
        }),
      }),
    }),
  },
}));
vi.mock('@/lib/push', () => ({ registerPush: vi.fn(), unregisterPush: vi.fn(async () => {}) }));
vi.mock('@/lib/deepLinks', () => ({ initDeepLinks: vi.fn(), setDeepLinkNavigator: vi.fn() }));
// Las pantallas de destino se sustituyen: lo que se prueba es a cuál se va.
vi.mock('@/pages/Auth', () => ({ default: () => <p>pantalla de acceso</p> }));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: () => <p>dentro de la app</p> }));

/** La pantalla de entrada tal como la trae index.html (lo que importa de ella). */
function ponerPantallaDeEntrada() {
  document.body.insertAdjacentHTML(
    'afterbegin',
    '<div id="boot-splash" class="boot-splash"><img class="boot-splash__logo" alt="" />' +
      '<div id="boot-splash-status"></div></div>',
  );
}

/** Cada prueba con los módulos recién cargados: la pantalla de entrada solo se va una vez por carga. */
async function montarApp() {
  vi.resetModules();
  ponerPantallaDeEntrada();
  const { default: App } = await import('@/App');
  render(<App />);
}

beforeEach(async () => {
  cleanup();
  document.body.innerHTML = '';
  getSession.mockReset();
  perfiles = [];
  authCallback = null;
  await i18n.changeLanguage('es');
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => { vi.useRealTimers(); });

describe('arranque', () => {
  it('sin sesión va a la pantalla de acceso y se funde la de entrada', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    await montarApp();
    expect(await screen.findByText('pantalla de acceso')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(document.getElementById('boot-splash')?.classList.contains('boot-splash--out')).toBe(true);
  });

  it('con sesión entra en la app, sin pasar por el login', async () => {
    getSession.mockResolvedValue({ data: { session: SESION }, error: null });
    await montarApp();
    expect(await screen.findByText('dentro de la app')).toBeInTheDocument();
    expect(screen.queryByText('pantalla de acceso')).not.toBeInTheDocument();
  });

  it('si la sesión no se resuelve, a los 6 s avisa DENTRO de la pantalla de entrada y ofrece Reintentar', async () => {
    getSession.mockReturnValue(new Promise(() => {}));
    await montarApp();
    const hueco = document.getElementById('boot-splash-status')!;
    await act(async () => { await vi.advanceTimersByTimeAsync(5900); });
    expect(within(hueco).queryByText('Está tardando más de lo normal')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(within(hueco).getByText('Está tardando más de lo normal')).toBeInTheDocument();
    expect(within(hueco).getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
    // Y la pantalla de entrada sigue puesta: el aviso no queda debajo de nada.
    expect(document.getElementById('boot-splash')?.classList.contains('boot-splash--out')).toBe(false);
  });

  it('sin red y con sesión guardada NO manda al login: dice que no hay conexión y reintenta', async () => {
    getSession.mockResolvedValueOnce({
      data: { session: null },
      error: new AuthRetryableFetchError('Load failed', 0),
    });
    await montarApp();
    expect(await screen.findByText('Sin conexión')).toBeInTheDocument();
    // supabase-js también emite INITIAL_SESSION con null en este caso: era lo
    // que mandaba al login.
    act(() => authCallback?.('INITIAL_SESSION', null));
    expect(screen.queryByText('pantalla de acceso')).not.toBeInTheDocument();

    getSession.mockResolvedValueOnce({ data: { session: SESION }, error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('dentro de la app')).toBeInTheDocument();
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('si vuelve la red y supabase-js renueva la sesión solo, entra sin tocar nada', async () => {
    getSession.mockResolvedValueOnce({
      data: { session: null },
      error: new AuthRetryableFetchError('Load failed', 0),
    });
    await montarApp();
    expect(await screen.findByText('Sin conexión')).toBeInTheDocument();
    act(() => authCallback?.('TOKEN_REFRESHED', SESION));
    expect(await screen.findByText('dentro de la app')).toBeInTheDocument();
  });

  it('un error de red que llega tarde no tapa la sesión que ya renovó supabase-js', async () => {
    // Visto en el simulador: con la red de vuelta, el refresco automático
    // emitía TOKEN_REFRESHED, y DESPUÉS llegaba la respuesta atrasada de
    // getSession con el error de antes y ponía «Sin conexión» encima.
    let responderGetSession: (valor: unknown) => void = () => {};
    getSession.mockReturnValueOnce(new Promise((r) => { responderGetSession = r; }));
    await montarApp();
    act(() => authCallback?.('TOKEN_REFRESHED', SESION));
    await act(async () => {
      responderGetSession({ data: { session: null }, error: new AuthRetryableFetchError('Load failed', 0) });
    });
    expect(await screen.findByText('dentro de la app')).toBeInTheDocument();
    expect(screen.queryByText('Sin conexión')).not.toBeInTheDocument();
  });

  it('si el perfil no llega, no entra con el perfil vacío: avisa y deja reintentar', async () => {
    getSession.mockResolvedValue({ data: { session: SESION }, error: null });
    perfiles = [{ data: null, error: { code: '', message: 'TimeoutError: Sin respuesta en 15 s' } }];
    await montarApp();
    expect(await screen.findByText('No pudimos cargar tu perfil')).toBeInTheDocument();
    expect(screen.queryByText('dentro de la app')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('dentro de la app')).toBeInTheDocument();
  });

  it('un perfil que no existe (PGRST116) sí es una respuesta: no se queda esperando', async () => {
    getSession.mockResolvedValue({ data: { session: SESION }, error: null });
    perfiles = [{ data: null, error: { code: 'PGRST116', message: 'no rows' } }];
    await montarApp();
    expect(await screen.findByText('dentro de la app')).toBeInTheDocument();
  });
});
