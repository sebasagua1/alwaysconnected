import { Capacitor, registerPlugin } from '@capacitor/core';
import { supabase } from '@/integrations/supabase/client';
import {
  countryFromLocale, digestInput, normalizeEmail, normalizePhone, sha256Hex, type IdentifierKind,
} from '../../supabase/functions/_shared/contactIdentity';

/**
 * Contactos: permiso, lectura, huellas y compartir.
 *
 * La agenda nunca sale del teléfono en claro. De cada contacto se normalizan
 * teléfonos y correos, se resume cada uno con SHA-256 y solo se manda eso,
 * con una etiqueta opaca (`ref`) para reconocer la respuesta. El servidor
 * firma con HMAC y compara (ver supabase/functions/contacts-match).
 */

export type ContactsStatus = 'notDetermined' | 'limited' | 'authorized' | 'denied' | 'restricted' | 'unavailable';

export interface DeviceContact {
  id: string;
  name: string;
  phones: string[];
  emails: string[];
}

interface ContactsBridgePlugin {
  getStatus(): Promise<{ status: ContactsStatus; limitedPickerAvailable: boolean }>;
  requestAccess(): Promise<{ status: ContactsStatus }>;
  readContacts(opts: { max?: number }): Promise<{ contacts: DeviceContact[] }>;
  pickContacts(): Promise<{ contacts: DeviceContact[]; cancelled: boolean }>;
  manageLimitedAccess(): Promise<{ available: boolean; added: number }>;
  openSettings(): Promise<{ opened: boolean }>;
  share(opts: { text: string; url?: string }): Promise<{ completed: boolean; activityType: string }>;
}

const ContactsBridge = registerPlugin<ContactsBridgePlugin>('ContactsBridge');

/** El plugin es nativo y propio (ios/App/App/ContactsBridgePlugin.swift): en web no existe. */
export function contactsSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('ContactsBridge');
}

export async function contactsStatus(): Promise<{ status: ContactsStatus; limitedPickerAvailable: boolean }> {
  if (!contactsSupported()) return { status: 'unavailable', limitedPickerAvailable: false };
  return ContactsBridge.getStatus();
}

export async function requestContactsAccess(): Promise<ContactsStatus> {
  if (!contactsSupported()) return 'unavailable';
  return (await ContactsBridge.requestAccess()).status;
}

export async function readDeviceContacts(): Promise<DeviceContact[]> {
  if (!contactsSupported()) return [];
  return (await ContactsBridge.readContacts({ max: 3000 })).contacts;
}

/** El selector del sistema: sin permiso, solo los contactos que se tocan. */
export async function pickDeviceContacts(): Promise<DeviceContact[] | null> {
  if (!contactsSupported()) return null;
  const r = await ContactsBridge.pickContacts();
  return r.cancelled ? null : r.contacts;
}

/** Ampliar el acceso limitado (iOS 18). Si no existe, false: la app ofrece Ajustes. */
export async function manageLimitedAccess(): Promise<boolean> {
  if (!contactsSupported()) return false;
  return (await ContactsBridge.manageLimitedAccess()).available;
}

export async function openAppSettings(): Promise<void> {
  if (contactsSupported()) await ContactsBridge.openSettings();
}

// ---------------------------------------------------------------- huellas

export interface HashedItem {
  /** "<índice del contacto>.<n>": opaco para el servidor. */
  ref: string;
  kind: IdentifierKind;
  h: string;
}

/** Tope por petición: el mismo que exige la Edge Function y la base. */
export const MATCH_BATCH = 500;

/**
 * De la lista de contactos a las huellas que se mandan. Devuelve también a
 * qué contacto pertenece cada ref. Descarta lo que no se puede normalizar y
 * repite cada huella una sola vez.
 */
export async function hashContacts(
  contacts: DeviceContact[],
  locale: string = typeof navigator !== 'undefined' ? navigator.language : 'es-MX',
): Promise<{ items: HashedItem[]; contactByRef: Map<string, number> }> {
  const country = countryFromLocale(locale);
  const items: HashedItem[] = [];
  const contactByRef = new Map<string, number>();
  const seen = new Set<string>();

  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    const values: Array<[IdentifierKind, string | null]> = [
      ...c.phones.map((p) => ['phone', normalizePhone(p, country)] as [IdentifierKind, string | null]),
      ...c.emails.map((e) => ['email', normalizeEmail(e)] as [IdentifierKind, string | null]),
    ];
    let n = 0;
    for (const [kind, value] of values) {
      if (!value) continue;
      const h = await sha256Hex(digestInput(kind, value));
      const key = `${kind}:${h}`;
      const ref = `${i}.${n++}`;
      contactByRef.set(ref, i);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ ref, kind, h });
    }
  }
  return { items, contactByRef };
}

export interface ContactMatch {
  user_id: string;
  name: string;
  avatar_url: string | null;
  campus_name: string | null;
  relation: 'none' | 'outgoing' | 'incoming' | 'friends' | 'blocked';
  friendship_id: string | null;
  refs: string[];
}

export type MatchErrorCode =
  | 'CONTACTS_NOT_CONFIGURED'
  | 'CONTACTS_RATE_LIMIT'
  | 'CONTACTS_BATCH_TOO_LARGE'
  | 'CONTACTS_UNAVAILABLE'
  | 'NOT_AUTHENTICATED'
  | 'NETWORK';

export class ContactsMatchError extends Error {
  constructor(public code: MatchErrorCode) {
    super(code);
  }
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('contacts-match', { body });
  if (error) {
    // La Edge Function manda el código en el cuerpo; supabase-js lo guarda
    // en error.context (la Response).
    let code: MatchErrorCode = 'NETWORK';
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const j = (await ctx.json()) as { error?: string };
        if (j.error) code = j.error as MatchErrorCode;
      } catch {
        code = 'CONTACTS_UNAVAILABLE';
      }
    }
    throw new ContactsMatchError(code);
  }
  return data as T;
}

/**
 * Busca las huellas en tandas de 500. `keep` pide al servidor que las
 * guarde para avisar cuando alguien se una (solo si la persona lo activó).
 */
export async function matchContacts(items: HashedItem[], keep: boolean): Promise<ContactMatch[]> {
  const byUser = new Map<string, ContactMatch>();
  for (let i = 0; i < items.length; i += MATCH_BATCH) {
    const batch = items.slice(i, i + MATCH_BATCH);
    const r = await invoke<{ matches: ContactMatch[] }>({ action: 'match', items: batch, keep });
    for (const m of r.matches ?? []) {
      const prev = byUser.get(m.user_id);
      if (prev) prev.refs.push(...m.refs);
      else byUser.set(m.user_id, { ...m, refs: [...m.refs] });
    }
  }
  return [...byUser.values()];
}

/** Da de alta (o de baja, si no eres encontrable) tus identificadores verificados. */
export async function registerMyIdentifiers(): Promise<void> {
  await invoke({ action: 'register' });
}

// ---------------------------------------------------------------- invitar

export const INVITE_BASE_URL = 'https://alwaysconnected.vercel.app/i/';

export function inviteUrl(code: string): string {
  return INVITE_BASE_URL + encodeURIComponent(code);
}

/** Canal a partir del activityType de iOS, para la métrica. Nada más. */
export function channelFromActivity(activityType: string): 'messages' | 'whatsapp' | 'mail' | 'copy' | 'other' {
  if (/Message/i.test(activityType)) return 'messages';
  if (/whatsapp/i.test(activityType)) return 'whatsapp';
  if (/Mail/i.test(activityType)) return 'mail';
  if (/CopyToPasteboard/i.test(activityType)) return 'copy';
  return 'other';
}

/**
 * Abre la hoja de compartir con el mensaje y el enlace. Nunca envía nada por
 * su cuenta: la persona elige la app, el destinatario y confirma allí.
 * Devuelve si se completó (en web, si se copió o compartió).
 */
export async function shareInvite(text: string, url: string, recipients: number): Promise<boolean> {
  let completed = false;
  let channel: ReturnType<typeof channelFromActivity> = 'other';

  if (contactsSupported()) {
    const r = await ContactsBridge.share({ text, url });
    completed = r.completed;
    channel = channelFromActivity(r.activityType);
  } else if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ text, url });
      completed = true;
    } catch {
      completed = false;
    }
  } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
    await navigator.clipboard.writeText(`${text} ${url}`);
    completed = true;
    channel = 'copy';
  }

  if (completed) {
    // Métrica mínima: canal y cuántos se eligieron. Ni quién ni qué número.
    void supabase.rpc('log_invite_share', { _channel: channel, _recipients: Math.min(recipients, 100) });
  }
  return completed;
}

// ---------------------------------------------------------------- invitación pendiente

const PENDING_INVITE_KEY = 'ac_pending_invite';

/** Se guarda al abrir un enlace de invitación, antes incluso de iniciar sesión. */
export function savePendingInvite(code: string): void {
  if (!/^[A-Za-z0-9]{10}$/.test(code)) return;
  try {
    localStorage.setItem(PENDING_INVITE_KEY, code);
  } catch {
    // Sin almacenamiento (modo privado): simplemente no se recuerda.
  }
}

export function takePendingInvite(): string | null {
  try {
    const code = localStorage.getItem(PENDING_INVITE_KEY);
    localStorage.removeItem(PENDING_INVITE_KEY);
    return code && /^[A-Za-z0-9]{10}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}
