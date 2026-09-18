/**
 * Registro del dispositivo para push.
 *
 * Lo que se vigila aquí es el orden, no el resultado: el fallo que motivó
 * estas pruebas era que `register()` podía adelantarse al oyente de
 * 'registration'. Cuando eso pasa, iOS entrega el token a nadie, la base se
 * queda sin fila en device_tokens y `push_send()` ni siquiera intenta la
 * llamada a APNs. Todo ello sin un solo error por ningún lado.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (payload: unknown) => void;

/** Registro de llamadas en el orden exacto en que ocurrieron. */
let traza: string[] = [];
let oyentes: Record<string, Handler[]> = {};
let permiso: string = 'granted';
let rpc: ReturnType<typeof vi.fn>;

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}));

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions: async () => ({ receive: permiso }),
    requestPermissions: async () => ({ receive: permiso }),
    addListener: async (evento: string, cb: Handler) => {
      traza.push(`addListener:${evento}`);
      (oyentes[evento] ??= []).push(cb);
      return { remove: async () => {} };
    },
    register: async () => { traza.push('register'); },
  },
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

const refresh = vi.fn();
vi.mock('@/stores/notificationStore', () => ({
  useNotificationStore: { getState: () => ({ refresh }) },
}));

/** Módulo recién importado: su estado (oyentes puestos, token) es global. */
async function cargar() {
  vi.resetModules();
  return import('@/lib/push');
}

/** Lo que hace iOS cuando APNs contesta. */
function apnsEntregaToken(valor = 'tok-abc') {
  for (const cb of oyentes.registration ?? []) cb({ value: valor });
}

beforeEach(() => {
  traza = [];
  oyentes = {};
  permiso = 'granted';
  refresh.mockClear();
  rpc = vi.fn().mockResolvedValue({ error: null });
});

describe('registerPush', () => {
  it('ata los oyentes ANTES de pedir el registro a iOS', async () => {
    const { registerPush } = await cargar();
    await registerPush();

    expect(traza).toContain('register');
    // Si 'register' apareciera antes que el oyente, el token se perdería.
    expect(traza.indexOf('addListener:registration')).toBeLessThan(traza.indexOf('register'));
  });

  it('da de alta en la base el token que entrega APNs', async () => {
    const { registerPush } = await cargar();
    await registerPush();
    apnsEntregaToken('tok-abc');
    await vi.waitFor(() => expect(rpc).toHaveBeenCalled());

    expect(rpc).toHaveBeenCalledWith('register_device_token', {
      _token: 'tok-abc',
      _platform: 'ios',
    });
  });

  it('dos llamadas solapadas no duplican oyentes ni registros', async () => {
    const { registerPush } = await cargar();
    await Promise.all([registerPush(), registerPush()]);

    expect(traza.filter((t) => t === 'addListener:registration')).toHaveLength(1);
    expect(traza.filter((t) => t === 'register')).toHaveLength(1);
  });

  it('una segunda llamada tras terminar la primera no vuelve a atar oyentes', async () => {
    const { registerPush } = await cargar();
    await registerPush();
    await registerPush();

    expect(traza.filter((t) => t === 'addListener:registration')).toHaveLength(1);
    expect(traza.filter((t) => t === 'register')).toHaveLength(2);
  });

  it('sin permiso del sistema no llega a registrar', async () => {
    permiso = 'denied';
    const { registerPush } = await cargar();
    await registerPush();

    expect(traza).not.toContain('register');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('una push con la app abierta refresca los contadores', async () => {
    const { registerPush } = await cargar();
    await registerPush();

    for (const cb of oyentes.pushNotificationReceived ?? []) cb({});
    expect(refresh).toHaveBeenCalled();
  });
});

describe('unregisterPush', () => {
  it('da de baja el token que estaba registrado', async () => {
    const { registerPush, unregisterPush } = await cargar();
    await registerPush();
    apnsEntregaToken('tok-abc');
    await vi.waitFor(() => expect(rpc).toHaveBeenCalled());

    rpc.mockClear();
    await unregisterPush();
    expect(rpc).toHaveBeenCalledWith('unregister_device_token', { _token: 'tok-abc' });
  });

  it('sin token no llama a nada', async () => {
    const { unregisterPush } = await cargar();
    await unregisterPush();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('tras la baja, volver a entrar reasigna el token a la cuenta nueva', async () => {
    // El token es del teléfono, no de la cuenta: iOS no tiene por qué volver
    // a emitir 'registration' al entrar otra persona en el mismo iPhone.
    const { registerPush, unregisterPush } = await cargar();
    await registerPush();
    apnsEntregaToken('tok-abc');
    await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
    await unregisterPush();

    rpc.mockClear();
    await registerPush();
    expect(rpc).toHaveBeenCalledWith('register_device_token', {
      _token: 'tok-abc',
      _platform: 'ios',
    });
  });
});
