/**
 * El texto de cada aviso y la petición a APNs. Lo que se fija: todos los
 * tipos de la base tienen texto en los dos idiomas, sin vista previa no se
 * cuela el contenido, la carga solo lleva ids, y la app publicada sigue
 * entendiendo los tipos de siempre.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderNotification } from '../../supabase/functions/_shared/notificationCopy';
import { buildApnsRequest, summarize, type ClaimedDelivery } from '../../supabase/functions/_shared/notificationPush';
import { routeFromPushData } from '@/lib/deepLinks';

// Sin .env (en el CI) el cliente real revienta al importarse.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

const MIGRACION = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '20260925000000_notificaciones.sql'), 'utf8');
/** Los tipos que siembra la migración, leídos del propio SQL. */
const TIPOS = [...MIGRACION.matchAll(/^\s+\('([a-z_]+)',\s+'[a-z_]+',\s+\d,/gm)].map((m) => m[1]);

const entrega = (extra: Partial<ClaimedDelivery> = {}): ClaimedDelivery => ({
  delivery_id: 'd1', notification_id: '11111111-1111-4111-8111-111111111111', user_id: 'u1', type: 'event_message',
  priority: 1, count: 1, locale: 'es', actor_id: 'a1', actor_name: 'Ana', event_id: '22222222-2222-4222-8222-222222222222',
  event_title: 'Fútbol', group_id: null, group_name: null, is_dm: false, preview: 'nos vemos a las 6', data: {},
  thread_id: 'chat:event:e1', expires_at: new Date(Date.now() + 3600_000).toISOString(), tokens: ['t1'], ...extra,
});

describe('textos', () => {
  it('hay más de 30 tipos y todos tienen texto propio en español y en inglés', () => {
    expect(TIPOS.length).toBeGreaterThanOrEqual(30);
    for (const type of TIPOS) {
      for (const locale of ['es', 'en'] as const) {
        const c = renderNotification({ type, actor_name: 'Ana', event_title: 'Fútbol', group_name: 'Estudio', data: { kind: 'email_changed', change: 'time' } }, locale);
        expect(c.title.length, `${type}/${locale}`).toBeGreaterThan(0);
        expect(c.body, `${type}/${locale} usa el genérico`).not.toMatch(/Tienes un aviso nuevo|You have a new notification/);
      }
    }
  });

  it('agrupa: un mensaje o un resumen', () => {
    expect(renderNotification({ type: 'event_message', actor_name: 'Ana', event_title: 'Fútbol', preview: 'hola', count: 1 }))
      .toEqual({ title: 'Fútbol', body: 'Ana: hola' });
    expect(renderNotification({ type: 'event_message', actor_name: 'Ana', event_title: 'Fútbol', preview: 'hola', count: 4 }, 'en'))
      .toEqual({ title: 'Fútbol', body: '4 new messages · Ana: hola' });
    expect(renderNotification({ type: 'participant_joined', actor_name: 'Ana', event_title: 'Fútbol', count: 3 }).body)
      .toBe('Ana y 2 más se unieron a tu actividad');
  });

  it('sin vista previa no aparece el contenido, y sin nombre no se inventa', () => {
    const c = renderNotification({ type: 'event_message', actor_name: null, event_title: null, preview: null });
    expect(c).toEqual({ title: 'tu plan', body: 'Alguien escribió en el chat' });
    expect(renderNotification({ type: 'chat_mention', actor_name: 'Ana', event_title: 'Fútbol', preview: null }).body)
      .toBe('Fútbol: Toca para ver el mensaje');
  });

  it('mensajes directos llevan a la persona como título', () => {
    expect(renderNotification({ type: 'message', is_dm: true, actor_name: 'Ana', preview: 'hey' })).toEqual({ title: 'Ana', body: 'hey' });
    expect(renderNotification({ type: 'message', is_dm: false, group_name: 'Estudio', actor_name: 'Ana', preview: 'hey' }))
      .toEqual({ title: 'Estudio', body: 'Ana: hey' });
  });

  it('recordatorio con los minutos elegidos', () => {
    expect(renderNotification({ type: 'event_reminder', event_title: 'Cine', data: { minutes: 30 } }).body).toBe('«Cine» empieza en 30 min');
    expect(renderNotification({ type: 'event_reminder', event_title: 'Cine', data: { minutes: 1440 } }, 'en').body).toBe('“Cine” starts tomorrow');
  });
});

describe('petición a APNs', () => {
  it('solo ids en la carga; el texto va en aps.alert', () => {
    const r = buildApnsRequest(entrega(), { title: 'Fútbol', body: 'Ana: nos vemos a las 6' });
    const { aps, ...resto } = r.payload as { aps: Record<string, unknown> };
    expect(resto).toEqual({ type: 'event_message', notification_id: entrega().notification_id, event_id: entrega().event_id });
    expect(aps).toMatchObject({ alert: { title: 'Fútbol', body: 'Ana: nos vemos a las 6' }, sound: 'default', 'thread-id': 'chat:event:e1', 'interruption-level': 'active' });
    expect(r.priority).toBe('10');
    expect(r.collapseId).toBe(entrega().notification_id);
  });

  it('lo de baja prioridad es pasivo: sin sonido y prioridad 5; nunca crítico', () => {
    const r = buildApnsRequest(entrega({ type: 'new_campus_event', priority: 0 }), { title: 't', body: 'b' });
    const aps = (r.payload as { aps: Record<string, unknown> }).aps;
    expect(aps.sound).toBeUndefined();
    expect(aps['interruption-level']).toBe('passive');
    expect(r.priority).toBe('5');
    for (const type of TIPOS) {
      const a = (buildApnsRequest(entrega({ type, priority: 2 }), { title: 't', body: 'b' }).payload as { aps: Record<string, unknown> }).aps;
      expect(['active', 'passive']).toContain(a['interruption-level']);
    }
  });

  it('la solicitud de amistad lleva también requester_id, como antes', () => {
    const r = buildApnsRequest(entrega({ type: 'friend_request', event_id: null, actor_id: 'x' }), { title: 't', body: 'b' });
    expect(r.payload).toMatchObject({ type: 'friend_request', user_id: 'x', requester_id: 'x' });
  });

  it('los tipos de siempre siguen llevando a donde llevaban en la app', () => {
    const g = '33333333-3333-4333-8333-333333333333';
    expect(routeFromPushData({ type: 'message', group_id: g })).toBe(`/groups/${g}`);
    expect(routeFromPushData({ type: 'friend_request' })).toBe('/friends');
    expect(routeFromPushData({ type: 'group_invite', group_id: g })).toBe('/friends');
  });
});

describe('resultado de la entrega', () => {
  it('con un dispositivo que recibe, enviada; los tokens muertos se devuelven', () => {
    const s = summarize([
      { token: 'a', result: { status: 200 }, retriedInSandbox: false },
      { token: 'b', result: { status: 410, reason: 'Unregistered' }, retriedInSandbox: false },
    ]);
    expect(s).toMatchObject({ ok: true, devicesSent: 1, devicesFailed: 1, deadTokens: ['b'], retry: false });
  });

  it('reintenta solo lo que es de Apple o de red, no lo del token', () => {
    expect(summarize([{ token: 'a', result: { status: 503 }, retriedInSandbox: false }]).retry).toBe(true);
    expect(summarize([{ token: 'a', result: { status: 0, reason: 'TypeError' }, retriedInSandbox: false }]).retry).toBe(true);
    expect(summarize([{ token: 'a', result: { status: 400, reason: 'BadDeviceToken' }, retriedInSandbox: true }])).toMatchObject({ retry: false, deadTokens: ['a'] });
    expect(summarize([{ token: 'a', result: { status: 403, reason: 'InvalidProviderToken' }, retriedInSandbox: false }]).retry).toBe(false);
  });
});
