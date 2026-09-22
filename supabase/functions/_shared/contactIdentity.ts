/**
 * Normalizar y resumir correos y teléfonos para buscar contactos.
 *
 * Lo comparten la app (src/lib/contacts.ts) y la Edge Function
 * contacts-match: si los dos lados no normalizaran EXACTAMENTE igual, un
 * mismo teléfono escrito "55 1234 5678" en la agenda y "+525512345678" en la
 * cuenta no coincidirían nunca. Sin dependencias ni APIs de Deno o del
 * navegador salvo WebCrypto, para poder probarlo en vitest.
 *
 * La cadena completa:
 *   teléfono/correo -> normalizado -> SHA-256("tipo:normalizado") en el móvil
 *   -> HMAC-SHA256(CONTACTS_HMAC_KEY, "tipo:sha256") en el servidor.
 * El SHA-256 solo protege el viaje (un teléfono se adivina probando); lo que
 * se guarda y se compara es el HMAC, que sin la clave no se puede recalcular.
 */

export type IdentifierKind = 'email' | 'phone';

/** Prefijo internacional por país, para números escritos sin él. */
export const COUNTRY_CALLING_CODES: Record<string, string> = {
  MX: '52',
  CO: '57',
  US: '1',
  CA: '1',
  ES: '34',
  AR: '54',
  CL: '56',
  PE: '51',
};

const EMAIL = /^[^@\s]{1,64}@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Minúsculas y sin espacios; null si no parece un correo. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = raw.trim().replace(/^mailto:/i, '').toLowerCase().replace(/\.+$/, '');
  return e.length <= 254 && EMAIL.test(e) ? e : null;
}

/** Los correos de "Ocultar mi correo" de Apple: nadie los tiene en la agenda. */
export function isAppleRelayEmail(email: string): boolean {
  return email.endsWith('@privaterelay.appleid.com');
}

/**
 * E.164 (+5215512345678 -> +525512345678), o null si no se puede.
 *
 * `defaultCountry` se usa solo para números sin prefijo internacional,
 * que es como se guardan casi todos en la agenda de un mismo país.
 */
export function normalizePhone(raw: string | null | undefined, defaultCountry = 'MX'): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  let digits = trimmed.replace(/[^\d+]/g, '');
  if (!digits) return null;

  let international: string;
  if (digits.startsWith('+')) {
    international = digits.slice(1).replace(/\+/g, '');
  } else if (digits.startsWith('00')) {
    international = digits.slice(2);
  } else {
    digits = digits.replace(/\+/g, '');
    const cc = COUNTRY_CALLING_CODES[defaultCountry.toUpperCase()] ?? COUNTRY_CALLING_CODES.MX;
    // Prefijo nacional de larga distancia ("01" en México, "1" en EE. UU.
    // escrito como parte del número): fuera antes de poner el del país.
    // En México también los viejos 044/045 de móvil.
    if (cc === '52' && digits.length === 12 && digits.startsWith('01')) digits = digits.slice(2);
    if (cc === '52' && digits.length === 13 && /^04[45]/.test(digits)) digits = digits.slice(3);
    if (cc === '1' && digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    international = cc + digits;
  }

  // México quitó el "1" de los móviles en 2019: +52 1 55... es +52 55...
  if (international.startsWith('521') && international.length === 13) {
    international = '52' + international.slice(3);
  }

  if (!/^[1-9]\d{7,14}$/.test(international)) return null;
  return '+' + international;
}

/** El país de un "es-MX" / "en-US"; MX si no se sabe. */
export function countryFromLocale(locale: string | null | undefined): string {
  const m = (locale ?? '').match(/[-_]([A-Za-z]{2})\b/);
  const cc = m?.[1]?.toUpperCase();
  return cc && COUNTRY_CALLING_CODES[cc] ? cc : 'MX';
}

/** Lo que se resume: el tipo delante, para que un correo y un teléfono nunca choquen. */
export function digestInput(kind: IdentifierKind, normalized: string): string {
  return `${kind}:${normalized}`;
}

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 en hex. WebCrypto si existe (siempre en Deno); si no, implementación propia. */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) return toHex(await subtle.digest('SHA-256', enc.encode(text)));
  return sha256Fallback(enc.encode(text));
}

/** HMAC-SHA256 en hex. Solo en el servidor: la clave nunca sale de ahí. */
export async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
}

/** Lo que el servidor firma: "tipo:sha256". Validado: nada de texto libre. */
export function serverMessage(kind: IdentifierKind, sha: string): string | null {
  if (kind !== 'email' && kind !== 'phone') return null;
  if (!/^[0-9a-f]{64}$/.test(sha)) return null;
  return `${kind}:${sha}`;
}

// --------------------------------------------------------------------------
// SHA-256 sin WebCrypto. El WKWebView de la app la tiene, pero un contexto
// que el navegador no considere seguro la esconde, y entonces la búsqueda de
// contactos fallaría en silencio. FIPS 180-4, sin optimizar: son cientos de
// cadenas cortas como mucho.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Fallback(data: Uint8Array): string {
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}
