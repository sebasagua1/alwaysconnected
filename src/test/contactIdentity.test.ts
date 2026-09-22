// @vitest-environment node
/**
 * Normalizar y resumir correos y teléfonos. Si la app y la Edge Function no
 * produjeran exactamente la misma cadena, dos personas que se tienen en la
 * agenda no se encontrarían nunca, sin ningún error que lo delatara.
 */
import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import {
  countryFromLocale, digestInput, hmacHex, isAppleRelayEmail, normalizeEmail, normalizePhone,
  serverMessage, sha256Fallback, sha256Hex,
} from '../../supabase/functions/_shared/contactIdentity';

describe('normalizeEmail', () => {
  it('minúsculas, sin espacios ni mailto', () => {
    expect(normalizeEmail('  Ana.Lopez@Tec.MX ')).toBe('ana.lopez@tec.mx');
    expect(normalizeEmail('mailto:ana@gmail.com')).toBe('ana@gmail.com');
  });
  it('rechaza lo que no es un correo', () => {
    expect(normalizeEmail('ana')).toBeNull();
    expect(normalizeEmail('ana@')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
  it('reconoce los correos ocultos de Apple', () => {
    expect(isAppleRelayEmail('x1y2@privaterelay.appleid.com')).toBe(true);
    expect(isAppleRelayEmail('ana@gmail.com')).toBe(false);
  });
});

describe('normalizePhone: la misma persona escrita de cinco maneras', () => {
  const mx = '+525512345678';
  it.each([
    ['55 1234 5678', 'MX'],
    ['(55) 1234-5678', 'MX'],
    ['+52 55 1234 5678', 'MX'],
    ['+52 1 55 1234 5678', 'MX'],   // el "1" de móvil que México quitó en 2019
    ['0052 55 1234 5678', 'US'],    // prefijo 00 manda sobre el país por defecto
    ['01 55 1234 5678', 'MX'],      // larga distancia antigua
    ['044 55 1234 5678', 'MX'],     // móvil antiguo
  ])('%s → %s', (raw, country) => {
    expect(normalizePhone(raw, country)).toBe(mx);
  });

  it('usa el país por defecto solo sin prefijo internacional', () => {
    expect(normalizePhone('300 123 4567', 'CO')).toBe('+573001234567');
    expect(normalizePhone('(415) 555-0132', 'US')).toBe('+14155550132');
    expect(normalizePhone('1 415 555 0132', 'US')).toBe('+14155550132');
  });

  it('rechaza lo que no puede ser un número', () => {
    expect(normalizePhone('123', 'MX')).toBeNull();
    expect(normalizePhone('abc', 'MX')).toBeNull();
    expect(normalizePhone('+0 555 1234', 'MX')).toBeNull();
    expect(normalizePhone('', 'MX')).toBeNull();
  });

  it('saca el país del idioma del teléfono', () => {
    expect(countryFromLocale('es-MX')).toBe('MX');
    expect(countryFromLocale('en_US')).toBe('US');
    expect(countryFromLocale('es-CO')).toBe('CO');
    expect(countryFromLocale('fr')).toBe('MX');
    expect(countryFromLocale(undefined)).toBe('MX');
  });
});

describe('resúmenes', () => {
  it('SHA-256 coincide con el de Node, también sin WebCrypto', async () => {
    for (const s of ['', 'abc', 'phone:+525512345678', 'é'.repeat(100), 'x'.repeat(1000)]) {
      const esperado = createHash('sha256').update(s, 'utf8').digest('hex');
      expect(await sha256Hex(s)).toBe(esperado);
      expect(sha256Fallback(new TextEncoder().encode(s))).toBe(esperado);
    }
  });

  it('HMAC coincide con el de Node', async () => {
    const esperado = createHmac('sha256', 'clave-secreta').update('email:abc').digest('hex');
    expect(await hmacHex('clave-secreta', 'email:abc')).toBe(esperado);
  });

  it('el tipo va delante: un correo y un teléfono nunca dan la misma huella', async () => {
    expect(await sha256Hex(digestInput('email', 'x'))).not.toBe(await sha256Hex(digestInput('phone', 'x')));
  });

  it('el servidor solo firma "tipo:hex64", nunca texto libre', () => {
    const h = 'a'.repeat(64);
    expect(serverMessage('email', h)).toBe(`email:${h}`);
    expect(serverMessage('email', 'ana@gmail.com')).toBeNull();
    expect(serverMessage('phone', h.toUpperCase())).toBeNull();
    expect(serverMessage('otro' as 'email', h)).toBeNull();
  });

  it('la cadena completa del teléfono y del servidor encaja', async () => {
    // Lo que hace la app con un contacto…
    const enAgenda = await sha256Hex(digestInput('phone', normalizePhone('55 1234 5678', 'MX')!));
    // …y lo que hace la Edge Function con el teléfono verificado de la cuenta.
    const enCuenta = await sha256Hex(digestInput('phone', normalizePhone('+525512345678')!));
    expect(await hmacHex('k'.repeat(32), serverMessage('phone', enAgenda)!))
      .toBe(await hmacHex('k'.repeat(32), serverMessage('phone', enCuenta)!));
  });
});
