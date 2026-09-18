// @vitest-environment node
/**
 * Reintento entre entornos y limpieza de tokens.
 *
 * Existe por un caso real: el iPhone de desarrollo no recibía nada mientras
 * todo TestFlight sí. APNs contestaba DeviceTokenNotForTopic, que no estaba
 * contemplado en el reintento, y el aviso se perdía sin dejar rastro.
 */
import { describe, it, expect } from 'vitest';
import { reintentarEnSandbox, tokenMuerto } from '../../supabase/functions/_shared/apns';

describe('reintentarEnSandbox', () => {
  it('reintenta con BadDeviceToken', () => {
    expect(reintentarEnSandbox({ status: 400, reason: 'BadDeviceToken' })).toBe(true);
  });

  it('reintenta con DeviceTokenNotForTopic', () => {
    // El fallo que motivó todo esto: Apple manda uno u otro sin criterio fijo.
    expect(reintentarEnSandbox({ status: 400, reason: 'DeviceTokenNotForTopic' })).toBe(true);
  });

  it('no reintenta un envío que salió bien', () => {
    expect(reintentarEnSandbox({ status: 200 })).toBe(false);
  });

  it('no reintenta lo que no es cosa del entorno', () => {
    // 403 es el .p8; 410 es la app desinstalada; 429 y 503 son de Apple.
    expect(reintentarEnSandbox({ status: 403, reason: 'InvalidProviderToken' })).toBe(false);
    expect(reintentarEnSandbox({ status: 410, reason: 'Unregistered' })).toBe(false);
    expect(reintentarEnSandbox({ status: 429, reason: 'TooManyRequests' })).toBe(false);
    expect(reintentarEnSandbox({ status: 503, reason: 'ServiceUnavailable' })).toBe(false);
  });

  it('no reintenta un 400 por otro motivo', () => {
    expect(reintentarEnSandbox({ status: 400, reason: 'BadTopic' })).toBe(false);
    expect(reintentarEnSandbox({ status: 400 })).toBe(false);
  });
});

describe('tokenMuerto', () => {
  it('borra cuando la app se desinstaló', () => {
    expect(tokenMuerto({ status: 410, reason: 'Unregistered' }, false)).toBe(true);
  });

  it('borra un BadDeviceToken que falló también en sandbox', () => {
    expect(tokenMuerto({ status: 400, reason: 'BadDeviceToken' }, true)).toBe(true);
  });

  it('NO borra un BadDeviceToken de producción antes del reintento', () => {
    // Puede valer perfectamente en sandbox; borrarlo aquí deja al iPhone de
    // desarrollo sin notificaciones hasta que alguien reabra la app.
    expect(tokenMuerto({ status: 400, reason: 'BadDeviceToken' }, false)).toBe(false);
  });

  it('NO borra por DeviceTokenNotForTopic, ni tras fallar en los dos entornos', () => {
    // Ese motivo también sale con APNS_BUNDLE_ID mal puesto, que afecta a todo
    // el mundo a la vez: borrar vaciaría device_tokens entera por un secreto
    // equivocado.
    expect(tokenMuerto({ status: 400, reason: 'DeviceTokenNotForTopic' }, true)).toBe(false);
    expect(tokenMuerto({ status: 400, reason: 'DeviceTokenNotForTopic' }, false)).toBe(false);
  });

  it('NO borra por un fallo pasajero ni por uno de configuración', () => {
    expect(tokenMuerto({ status: 503, reason: 'ServiceUnavailable' }, false)).toBe(false);
    expect(tokenMuerto({ status: 429, reason: 'TooManyRequests' }, true)).toBe(false);
    expect(tokenMuerto({ status: 403, reason: 'InvalidProviderToken' }, false)).toBe(false);
    expect(tokenMuerto({ status: 400, reason: 'TopicDisallowed' }, true)).toBe(false);
  });

  it('no borra un envío correcto', () => {
    expect(tokenMuerto({ status: 200 }, false)).toBe(false);
    expect(tokenMuerto({ status: 200 }, true)).toBe(false);
  });
});
