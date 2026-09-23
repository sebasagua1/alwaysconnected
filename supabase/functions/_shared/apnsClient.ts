/**
 * Cliente mínimo de APNs con token (.p8): firma del JWT y el envío.
 *
 * Es lo mismo que hace send-push por dentro, sacado aquí para que
 * notify-dispatch no lo copie. send-push se deja como está a propósito:
 * está desplegada y funcionando, y cambiarla no aporta nada.
 */
import type { ApnsRespuesta } from './apns.ts';

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  privateKey: string;
}

export const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

let cached: { value: string; madeAt: number; keyId: string } | null = null;
/** APNs acepta el mismo JWT una hora y se queja si se regenera muy seguido. */
const JWT_TTL_MS = 45 * 60 * 1000;

export async function apnsJwt(cfg: ApnsConfig): Promise<string> {
  if (cached && cached.keyId === cfg.keyId && Date.now() - cached.madeAt < JWT_TTL_MS) return cached.value;
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToPkcs8(cfg.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: cfg.keyId })));
  const payload = b64url(enc.encode(JSON.stringify({ iss: cfg.teamId, iat: Math.floor(Date.now() / 1000) })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${payload}`)));
  const value = `${header}.${payload}.${b64url(sig)}`;
  cached = { value, madeAt: Date.now(), keyId: cfg.keyId };
  return value;
}

export interface SendOptions {
  priority: '10' | '5';
  collapseId: string;
  expiration: number;
}

/** Un envío. Un fallo de red se devuelve como status 0 (reintentable). */
export async function apnsSend(
  host: string,
  token: string,
  jwt: string,
  cfg: ApnsConfig,
  payload: unknown,
  opts: SendOptions,
): Promise<ApnsRespuesta> {
  try {
    const res = await fetch(`${host}/3/device/${token}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${jwt}`,
        'apns-topic': cfg.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': opts.priority,
        'apns-expiration': String(opts.expiration),
        'apns-collapse-id': opts.collapseId,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (res.status === 200) return { status: 200 };
    let reason: string | undefined;
    try {
      reason = (await res.json())?.reason;
    } catch {
      reason = undefined;
    }
    return { status: res.status, reason };
  } catch (err) {
    return { status: 0, reason: err instanceof Error ? err.name : 'NetworkError' };
  }
}
