// @vitest-environment node
/**
 * Notificaciones (20260925000000), contra el esquema REAL.
 *
 * Lo que importa aquí es lo que NO debe pasar: avisar a quien hizo la
 * acción, avisar dos veces lo mismo, saltarse el silencio, las preferencias
 * o el horario, que alguien cree o lea avisos ajenos, que una push salga
 * para algo que ya no sirve. El despachador (notify-dispatch) se simula
 * llamando a sus RPC con service_role, igual que hace él.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  baseAlDia, baseReal, leerMigracion, como, falla, crearPersona, crearEvento, unirse, hacerAmigos,
  prepararPush, peticiones, CAMPUS,
} from './fullSchema';

const MIGRACION = '20260925000000_notificaciones.sql';

const U = {
  org: 'f0000000-0000-0000-0000-000000000001',
  ana: 'f0000000-0000-0000-0000-000000000002',
  luis: 'f0000000-0000-0000-0000-000000000003',
  eva: 'f0000000-0000-0000-0000-000000000004',
  zoe: 'f0000000-0000-0000-0000-000000000005',
  otro: 'f0000000-0000-0000-0000-000000000006', // otro campus
};

let db: PGlite;

type Notif = { id: string; type: string; user_id: string; actor_id: string | null; count: number; read_at: string | null; event_id: string | null; data: Record<string, unknown> };
type Entrega = { id: string; status: string; scheduled_for: string; notification_id: string; attempts: number; last_error: string | null };

const avisos = async (uid: string, type?: string) =>
  (await db.query<Notif>(
    `SELECT * FROM public.notifications WHERE user_id = $1 ${type ? 'AND type = $2' : ''} ORDER BY created_at, id`,
    type ? [uid, type] : [uid],
  )).rows;

const entregas = async (notificationId: string) =>
  (await db.query<Entrega>(`SELECT * FROM public.notification_deliveries WHERE notification_id = $1 ORDER BY created_at`, [notificationId])).rows;

const rpc = <T = Record<string, unknown>>(uid: string, sql: string, params: unknown[] = []) =>
  como(db, uid, async () => (await db.query<T>(sql, params)).rows);

async function servicio<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec(`SET ROLE service_role`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec(`RESET ROLE`);
  }
}

const enviar = (uid: string, evento: string, contenido: string, mentions: string[] = []) =>
  falla(db, uid, `INSERT INTO public.messages (event_id, sender_id, content, mentions) VALUES ($1, $2, $3, $4)`,
    [evento, uid, contenido, mentions]);

const pedirAmistad = (de: string, a: string) =>
  falla(db, de, `INSERT INTO public.friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'pending')`, [de, a]);

const limpiarAvisos = () => db.exec(`DELETE FROM public.notifications; DELETE FROM net._test_requests;`);

beforeAll(async () => {
  db = await baseAlDia();
  await crearPersona(db, U.org, 'Org', CAMPUS.qro);
  await crearPersona(db, U.ana, 'Ana', CAMPUS.qro);
  await crearPersona(db, U.luis, 'Luis', CAMPUS.qro);
  await crearPersona(db, U.eva, 'Eva', CAMPUS.qro);
  await crearPersona(db, U.zoe, 'Zoe', CAMPUS.qro);
  await crearPersona(db, U.otro, 'Otro', CAMPUS.gdl);
  await prepararPush(db, U.org, U.ana, U.luis, U.eva, U.zoe);
  // Todas en UTC para que el horario silencioso sea predecible.
  await db.exec(`UPDATE public.notification_preferences SET timezone = 'UTC'`);
}, 120_000);

beforeEach(limpiarAvisos);

describe('quién puede crear, leer y cambiar qué', () => {
  it('cada cuenta nace con sus preferencias', async () => {
    const { rows } = await db.query(`SELECT user_id FROM public.notification_preferences WHERE user_id = ANY($1)`, [Object.values(U)]);
    expect(rows.length).toBe(6);
  });

  it('nadie crea, cambia ni borra avisos desde la app', async () => {
    expect(await falla(db, U.ana, `INSERT INTO public.notifications (user_id, type, category) VALUES ($1, 'digest', 'digests')`, [U.ana]))
      .toMatch(/permission denied/);
    await pedirAmistad(U.ana, U.luis);
    const [n] = await avisos(U.luis);
    expect(await falla(db, U.luis, `UPDATE public.notifications SET count = 99 WHERE id = $1`, [n.id])).toMatch(/permission denied/);
    expect(await falla(db, U.luis, `DELETE FROM public.notifications WHERE id = $1`, [n.id])).toMatch(/permission denied/);
    await db.query(`DELETE FROM public.friendships`);
  });

  it('solo se leen los avisos propios, y la cola no se lee', async () => {
    await pedirAmistad(U.ana, U.luis);
    expect((await rpc(U.luis, `SELECT id FROM public.notifications`)).length).toBe(1);
    expect(await rpc(U.eva, `SELECT id FROM public.notifications`)).toEqual([]);
    expect(await falla(db, U.luis, `SELECT * FROM public.notification_deliveries`)).toMatch(/permission denied/);
    await db.query(`DELETE FROM public.friendships`);
  });

  it('las funciones internas no las puede llamar la app', async () => {
    expect(await falla(db, U.ana, `SELECT public.notify($1, 'digest')`, [U.luis])).toMatch(/permission denied/);
    expect(await falla(db, U.ana, `SELECT * FROM public.claim_notification_deliveries(10)`)).toMatch(/permission denied/);
    expect(await falla(db, U.ana, `SELECT public.complete_notification_delivery(gen_random_uuid(), true)`)).toMatch(/permission denied/);
    expect(await falla(db, U.ana, `SELECT * FROM public.notification_metrics_daily`)).toMatch(/permission denied/);
  });

  it('las preferencias: las mías sí, las de otra persona no', async () => {
    expect(await falla(db, U.ana, `UPDATE public.notification_preferences SET mentions = false WHERE user_id = $1`, [U.ana])).toBeNull();
    const tocadas = await rpc(U.ana, `UPDATE public.notification_preferences SET mentions = false WHERE user_id = $1 RETURNING 1`, [U.luis]);
    expect(tocadas).toEqual([]);
    const { rows } = await db.query<{ mentions: boolean }>(`SELECT mentions FROM public.notification_preferences WHERE user_id = $1`, [U.luis]);
    expect(rows[0].mentions).toBe(true);
    expect(await falla(db, U.ana, `INSERT INTO public.notification_preferences (user_id) VALUES ($1)`, [U.otro]))
      .toMatch(/row-level security|duplicate key/);
    await db.query(`UPDATE public.notification_preferences SET mentions = true WHERE user_id = $1`, [U.ana]);
  });

  it('valida en el servidor: zona horaria real, rangos y consentimiento con fecha', async () => {
    expect(await falla(db, U.ana, `UPDATE public.notification_preferences SET timezone = 'Marte/Olympus' WHERE user_id = $1`, [U.ana]))
      .toMatch(/INVALID_TIMEZONE/);
    expect(await falla(db, U.ana, `UPDATE public.notification_preferences SET reminder_minutes = 7 WHERE user_id = $1`, [U.ana]))
      .toMatch(/check constraint/);
    expect(await falla(db, U.ana, `UPDATE public.notification_preferences SET daily_social_limit = 50 WHERE user_id = $1`, [U.ana]))
      .toMatch(/check constraint/);
    // Poner una fecha de consentimiento a mano no vale: la pone el servidor al activarlo.
    await falla(db, U.ana, `UPDATE public.notification_preferences SET promotional_consent_at = '2020-01-01' WHERE user_id = $1`, [U.ana]);
    let { rows } = await db.query<{ promotional: boolean; promotional_consent_at: string | null }>(
      `SELECT promotional, promotional_consent_at FROM public.notification_preferences WHERE user_id = $1`, [U.ana]);
    expect(rows[0]).toMatchObject({ promotional: false, promotional_consent_at: null });
    await falla(db, U.ana, `UPDATE public.notification_preferences SET promotional = true WHERE user_id = $1`, [U.ana]);
    ({ rows } = await db.query<{ promotional: boolean; promotional_consent_at: string | null }>(
      `SELECT promotional, promotional_consent_at FROM public.notification_preferences WHERE user_id = $1`, [U.ana]));
    expect(rows[0].promotional_consent_at).not.toBeNull();
    await falla(db, U.ana, `UPDATE public.notification_preferences SET promotional = false WHERE user_id = $1`, [U.ana]);
  });
});

describe('las reglas de notify()', () => {
  it('avisa a quien recibe, nunca a quien hace la acción, y despierta al despachador', async () => {
    await pedirAmistad(U.ana, U.luis);
    const [n] = await avisos(U.luis, 'friend_request');
    expect(n.actor_id).toBe(U.ana);
    expect(await avisos(U.ana)).toEqual([]);
    expect((await entregas(n.id)).map((e) => e.status)).toEqual(['pending']);
    const kicks = (await peticiones(db)).filter((p) => p.url.endsWith('/notify-dispatch'));
    expect(kicks.length).toBe(1);
    // Solo IDs: nada de texto en la fila.
    expect(JSON.stringify(n.data)).not.toMatch(/Ana/);
    await db.query(`DELETE FROM public.friendships`);
  });

  it('pedir, cancelar y volver a pedir no avisa dos veces', async () => {
    await pedirAmistad(U.ana, U.luis);
    await falla(db, U.ana, `DELETE FROM public.friendships WHERE requester_id = $1`, [U.ana]);
    await pedirAmistad(U.ana, U.luis);
    expect((await avisos(U.luis, 'friend_request')).length).toBe(1);
    await db.query(`DELETE FROM public.friendships`);
  });

  it('respeta la categoría apagada', async () => {
    await db.query(`UPDATE public.notification_preferences SET friend_requests = false WHERE user_id = $1`, [U.luis]);
    await pedirAmistad(U.eva, U.luis);
    expect(await avisos(U.luis)).toEqual([]);
    await db.query(`UPDATE public.notification_preferences SET friend_requests = true WHERE user_id = $1`, [U.luis]);
    await db.query(`DELETE FROM public.friendships`);
  });

  it('aceptar la solicitud avisa a quien la mandó', async () => {
    await pedirAmistad(U.ana, U.luis);
    await falla(db, U.luis, `UPDATE public.friendships SET status = 'accepted' WHERE requester_id = $1`, [U.ana]);
    const [n] = await avisos(U.ana, 'friend_accepted');
    expect(n.actor_id).toBe(U.luis);
    await db.query(`DELETE FROM public.friendships`);
  });

  it('entre bloqueados no hay avisos', async () => {
    await db.query(`INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [U.luis, U.zoe]);
    const e = await crearEvento(db, U.zoe, 'Bloqueado');
    await db.exec(`SELECT public.notify('${U.luis}', 'event_invite', '${U.zoe}', '${e}')`);
    expect(await avisos(U.luis)).toEqual([]);
    await db.query(`DELETE FROM public.blocks`);
  });

  it('lo que ya no sirve no se crea: recomendar algo que ya empezó', async () => {
    const e = await crearEvento(db, U.org, 'Ya empezó', { desdeMin: -10 });
    const { rows } = await db.query(`SELECT public.notify($1, 'new_campus_event', $2, $3, NULL, NULL, '{}', NULL, NULL, now() - interval '10 minutes') AS id`, [U.luis, U.org, e]);
    expect(rows[0]).toEqual({ id: null });
    expect(await avisos(U.luis)).toEqual([]);
  });

  it('tope diario de avisos sociales', async () => {
    await db.query(`UPDATE public.notification_preferences SET daily_social_limit = 1 WHERE user_id = $1`, [U.luis]);
    const e1 = await crearEvento(db, U.org, 'Social 1');
    const e2 = await crearEvento(db, U.org, 'Social 2');
    await db.query(`SELECT public.notify($1, 'friend_created_event', $2, $3, NULL, NULL, '{}', $4)`, [U.luis, U.org, e1, `event_new:${e1}`]);
    await db.query(`SELECT public.notify($1, 'friend_created_event', $2, $3, NULL, NULL, '{}', $4)`, [U.luis, U.org, e2, `event_new:${e2}`]);
    expect((await avisos(U.luis)).length).toBe(1);
    // Lo no social no cuenta para el tope.
    await pedirAmistad(U.eva, U.luis);
    expect((await avisos(U.luis)).length).toBe(2);
    await db.query(`UPDATE public.notification_preferences SET daily_social_limit = 3 WHERE user_id = $1`, [U.luis]);
    await db.query(`DELETE FROM public.friendships`);
  });

  it('horario silencioso: se pospone; lo urgente no', async () => {
    await db.query(`UPDATE public.notification_preferences SET quiet_hours_enabled = true, quiet_start = '00:00', quiet_end = '23:59' WHERE user_id = $1`, [U.luis]);
    await pedirAmistad(U.ana, U.luis);
    const [n] = await avisos(U.luis);
    const [d] = await entregas(n.id);
    expect(new Date(d.scheduled_for).getTime()).toBeGreaterThan(Date.now() + 60_000);

    // Cancelar algo que empieza en una hora es urgente: sale ya.
    const e = await crearEvento(db, U.org, 'Hoy', { desdeMin: 60 });
    await unirse(db, U.luis, e);
    await limpiarAvisos();
    await falla(db, U.org, `UPDATE public.events SET is_active = false WHERE id = $1`, [e]);
    const [c] = await avisos(U.luis, 'event_cancelled');
    const [dc] = await entregas(c.id);
    expect(new Date(dc.scheduled_for).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    await db.query(`UPDATE public.notification_preferences SET quiet_hours_enabled = false WHERE user_id = $1`, [U.luis]);
    await db.query(`DELETE FROM public.friendships`);
  });

  it('sin dispositivos el aviso queda en la bandeja, sin push', async () => {
    await db.query(`DELETE FROM public.device_tokens WHERE user_id = $1`, [U.zoe]);
    await pedirAmistad(U.ana, U.zoe);
    const n = await avisos(U.zoe);
    expect(n.length).toBe(1);
    expect(await entregas(n[0].id)).toEqual([]);
    await prepararPush(db, U.zoe);
    await db.query(`DELETE FROM public.friendships`);
  });
});

describe('el chat: agrupar, silenciar, menciones, leer y mirar', () => {
  let ev: string;
  beforeAll(async () => {
    ev = await crearEvento(db, U.org, 'Futbol');
    await unirse(db, U.ana, ev);
    await unirse(db, U.luis, ev);
  });

  it('varios mensajes seguidos: un solo aviso con el recuento, y una sola push viva', async () => {
    await enviar(U.ana, ev, 'uno');
    await enviar(U.ana, ev, 'dos');
    await enviar(U.ana, ev, 'tres');
    const n = await avisos(U.luis, 'event_message');
    expect(n.length).toBe(1);
    expect(n[0].count).toBe(3);
    const vivas = (await entregas(n[0].id)).filter((d) => d.status === 'pending' || d.status === 'sending');
    expect(vivas.length).toBe(1);
    // A quien escribe, nada.
    expect(await avisos(U.ana)).toEqual([]);
  });

  it('tras una push, lo que llega dentro de la ventana espera a que pase', async () => {
    await enviar(U.ana, ev, 'primero');
    const [n] = await avisos(U.luis, 'event_message');
    await db.query(`UPDATE public.notification_deliveries SET status = 'sent', sent_at = now() WHERE notification_id = $1`, [n.id]);
    await enviar(U.ana, ev, 'segundo');
    const ds = await entregas(n.id);
    const nueva = ds.find((d) => d.status === 'pending')!;
    expect(new Date(nueva.scheduled_for).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
  });

  it('silenciado: sin avisos de mensajes; una mención sí llega y con más prioridad', async () => {
    await rpc(U.luis, `SELECT public.set_event_chat_muted($1, true)`, [ev]);
    await enviar(U.ana, ev, 'normal');
    expect(await avisos(U.luis, 'event_message')).toEqual([]);
    await enviar(U.ana, ev, '@Luis', [U.luis]);
    const [m] = await avisos(U.luis, 'chat_mention');
    expect(m).toBeDefined();
    const { rows } = await db.query<{ priority: number }>(`SELECT priority FROM public.notifications WHERE id = $1`, [m.id]);
    expect(rows[0].priority).toBe(2);
    await rpc(U.luis, `SELECT public.set_event_chat_muted($1, false)`, [ev]);
  });

  it('leer el chat apaga el aviso y la push que quedaba no sale', async () => {
    await enviar(U.ana, ev, 'hola');
    const [n] = await avisos(U.luis, 'event_message');
    await rpc(U.luis, `SELECT public.mark_event_chat_read($1)`, [ev]);
    const reclamadas = await servicio<{ notification_id: string }>(`SELECT * FROM public.claim_notification_deliveries(50)`);
    expect(reclamadas.map((r) => r.notification_id)).not.toContain(n.id);
    const [d] = await entregas(n.id);
    expect(d).toMatchObject({ status: 'skipped', last_error: 'read' });
  });

  it('con el chat abierto no se crea ni el aviso', async () => {
    await rpc(U.luis, `SELECT public.set_event_chat_presence($1, true)`, [ev]);
    await enviar(U.ana, ev, 'le llega en vivo');
    expect(await avisos(U.luis, 'event_message')).toEqual([]);
    await rpc(U.luis, `SELECT public.set_event_chat_presence($1, false)`, [ev]);
  });

  it('si sale del evento antes de enviarse la push, no se manda', async () => {
    await enviar(U.ana, ev, 'para luis');
    const [n] = await avisos(U.luis, 'event_message');
    await falla(db, U.luis, `DELETE FROM public.event_participants WHERE event_id = $1 AND user_id = $2`, [ev, U.luis]);
    await servicio(`SELECT * FROM public.claim_notification_deliveries(50)`);
    expect((await entregas(n.id))[0]).toMatchObject({ status: 'skipped', last_error: 'no_access' });
    await unirse(db, U.luis, ev);
  });
});

describe('el despachador: reclamar, enviar, reintentar', () => {
  it('reclama con lo necesario para escribir la push, y respeta "sin vista previa"', async () => {
    const ev = await crearEvento(db, U.org, 'Pádel');
    await unirse(db, U.luis, ev);
    await enviar(U.org, ev, 'secreto del chat');
    await db.query(`UPDATE public.notification_preferences SET show_previews = false, locale = 'en' WHERE user_id = $1`, [U.luis]);
    const [r] = await servicio<{ type: string; locale: string; preview: string | null; event_title: string; actor_name: string; tokens: string[]; count: number }>(
      `SELECT * FROM public.claim_notification_deliveries(50) WHERE user_id = $1`, [U.luis]);
    expect(r).toMatchObject({ type: 'event_message', locale: 'en', preview: null, event_title: 'Pádel', actor_name: 'Org', count: 1 });
    expect(r.tokens).toEqual([`tok-${U.luis}`]);
    await db.query(`UPDATE public.notification_preferences SET show_previews = true, locale = 'es' WHERE user_id = $1`, [U.luis]);
  });

  it('una entrega reclamada no se reclama dos veces', async () => {
    await pedirAmistad(U.ana, U.luis);
    const a = await servicio<{ delivery_id: string }>(`SELECT * FROM public.claim_notification_deliveries(50)`);
    const b = await servicio<{ delivery_id: string }>(`SELECT * FROM public.claim_notification_deliveries(50)`);
    expect(a.length).toBe(1);
    expect(b).toEqual([]);
    await db.query(`DELETE FROM public.friendships`);
  });

  it('completar: enviada, reintento con espera, y fallo definitivo tras 5 intentos', async () => {
    await pedirAmistad(U.ana, U.luis);
    const [r] = await servicio<{ delivery_id: string }>(`SELECT * FROM public.claim_notification_deliveries(50)`);
    await servicio(`SELECT public.complete_notification_delivery($1, false, 0, 1, 'TooManyRequests', true)`, [r.delivery_id]);
    let { rows } = await db.query<Entrega>(`SELECT * FROM public.notification_deliveries WHERE id = $1`, [r.delivery_id]);
    expect(rows[0].status).toBe('pending');
    expect(new Date(rows[0].scheduled_for).getTime()).toBeGreaterThan(Date.now());

    await db.query(`UPDATE public.notification_deliveries SET attempts = 5, status = 'sending', locked_until = now() - interval '1 minute' WHERE id = $1`, [r.delivery_id]);
    await servicio(`SELECT * FROM public.claim_notification_deliveries(50)`);
    ({ rows } = await db.query<Entrega>(`SELECT * FROM public.notification_deliveries WHERE id = $1`, [r.delivery_id]));
    expect(rows[0]).toMatchObject({ status: 'failed', last_error: 'max_attempts' });
    await db.query(`DELETE FROM public.friendships`);
  });

  it('borra los tokens muertos y completar dos veces no cambia nada', async () => {
    await db.query(`INSERT INTO public.device_tokens (user_id, token) VALUES ($1, 'muerto')`, [U.luis]);
    await pedirAmistad(U.eva, U.luis);
    const [r] = await servicio<{ delivery_id: string }>(`SELECT * FROM public.claim_notification_deliveries(50)`);
    await servicio(`SELECT public.complete_notification_delivery($1, true, 1, 1, NULL, false, ARRAY['muerto'])`, [r.delivery_id]);
    await servicio(`SELECT public.complete_notification_delivery($1, false, 0, 0, 'otro', true)`, [r.delivery_id]);
    const { rows } = await db.query<Entrega>(`SELECT * FROM public.notification_deliveries WHERE id = $1`, [r.delivery_id]);
    expect(rows[0].status).toBe('sent');
    const t = await db.query(`SELECT token FROM public.device_tokens WHERE user_id = $1 ORDER BY token`, [U.luis]);
    expect(t.rows).toEqual([{ token: `tok-${U.luis}` }]);
    await db.query(`DELETE FROM public.friendships`);
  });

  it('conserva el type de siempre para la app publicada', async () => {
    await pedirAmistad(U.ana, U.luis);
    const [r] = await servicio<{ type: string }>(`SELECT * FROM public.claim_notification_deliveries(50)`);
    expect(r.type).toBe('friend_request');
    await db.query(`DELETE FROM public.friendships`);
  });
});

describe('la bandeja en la app', () => {
  it('resuelve nombre y título con los permisos de quien lee, y oculta a bloqueados', async () => {
    await pedirAmistad(U.ana, U.luis);
    const [n] = await rpc<{ type: string; actor_name: string }>(U.luis, `SELECT * FROM public.my_notifications()`);
    expect(n).toMatchObject({ type: 'friend_request', actor_name: 'Ana' });
    await db.query(`INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [U.luis, U.ana]);
    expect(await rpc(U.luis, `SELECT * FROM public.my_notifications()`)).toEqual([]);
    await db.query(`DELETE FROM public.blocks`);
    await db.query(`DELETE FROM public.friendships`);
  });

  it('marcar todo leído baja el contador y cancela lo pendiente', async () => {
    await pedirAmistad(U.ana, U.luis);
    await pedirAmistad(U.eva, U.luis);
    let [c] = await rpc<{ notifications_unread: number }>(U.luis, `SELECT notifications_unread FROM public.notification_counts()`);
    expect(Number(c.notifications_unread)).toBe(2);
    const [{ n }] = await rpc<{ n: number }>(U.luis, `SELECT public.mark_notifications_read() AS n`);
    expect(n).toBe(2);
    [c] = await rpc<{ notifications_unread: number }>(U.luis, `SELECT notifications_unread FROM public.notification_counts()`);
    expect(Number(c.notifications_unread)).toBe(0);
    const { rows } = await db.query(`SELECT status FROM public.notification_deliveries WHERE user_id = $1 AND status = 'pending'`, [U.luis]);
    expect(rows).toEqual([]);
    await db.query(`DELETE FROM public.friendships`);
  });

  it('abrir cuenta para la métrica, y solo el propio', async () => {
    await pedirAmistad(U.ana, U.luis);
    const [n] = await avisos(U.luis);
    await rpc(U.eva, `SELECT public.mark_notification_opened($1)`, [n.id]);
    type Abierta = { opened_at: string | null; read_at?: string | null };
    let { rows } = await db.query<Abierta>(`SELECT opened_at FROM public.notifications WHERE id = $1`, [n.id]);
    expect(rows[0].opened_at).toBeNull();
    await rpc(U.luis, `SELECT public.mark_notification_opened($1)`, [n.id]);
    ({ rows } = await db.query<Abierta>(`SELECT opened_at, read_at FROM public.notifications WHERE id = $1`, [n.id]));
    expect(rows[0].opened_at).not.toBeNull();
    await db.query(`DELETE FROM public.friendships`);
  });
});

describe('actividades', () => {
  it('cancelar avisa a quien iba (no a quien organiza) y apaga lo pendiente', async () => {
    const e = await crearEvento(db, U.org, 'Cine');
    await unirse(db, U.ana, e);
    await db.query(`SELECT public.notify($1, 'event_reminder', NULL, $2, NULL, NULL, '{}', $3)`, [U.ana, e, `reminder:${e}`]);
    await falla(db, U.org, `UPDATE public.events SET is_active = false WHERE id = $1`, [e]);
    expect((await avisos(U.ana, 'event_cancelled')).length).toBe(1);
    expect(await avisos(U.org, 'event_cancelled')).toEqual([]);
    const [rem] = await avisos(U.ana, 'event_reminder');
    expect((await entregas(rem.id))[0].status).toBe('cancelled');
  });

  it('guardar el mismo cambio dos veces avisa una vez', async () => {
    const e = await crearEvento(db, U.org, 'Taller');
    await unirse(db, U.ana, e);
    await falla(db, U.org, `UPDATE public.events SET address = 'Aula 5' WHERE id = $1`, [e]);
    await falla(db, U.org, `UPDATE public.events SET address = 'Aula 5' WHERE id = $1`, [e]);
    const n = await avisos(U.ana, 'event_changed');
    expect(n.length).toBe(1);
    expect(n[0].data).toEqual({ change: 'place' });
  });

  it('nuevas personas: un aviso agrupado a quien organiza; a los amigos, su propio aviso', async () => {
    await hacerAmigos(db, U.ana, U.zoe);
    const e = await crearEvento(db, U.org, 'Trivia', { desdeMin: 600 });
    await unirse(db, U.ana, e);
    await unirse(db, U.luis, e);
    const [n] = await avisos(U.org, 'participant_joined');
    expect(n.count).toBe(2);
    const [f] = await avisos(U.zoe, 'friend_joined_event');
    expect(f.actor_id).toBe(U.ana);
    await db.query(`DELETE FROM public.friendships`);
  });

  it('recordatorio antes de empezar, una sola vez aunque el cron pase dos veces', async () => {
    const e = await crearEvento(db, U.org, 'Estudio', { desdeMin: 45 });
    await db.query(`UPDATE public.event_participants SET joined_at = now() - interval '2 hours' WHERE event_id = $1`, [e]);
    await unirse(db, U.ana, e);
    await db.query(`UPDATE public.event_participants SET joined_at = now() - interval '2 hours' WHERE event_id = $1`, [e]);
    await db.query(`SELECT public.notify_upcoming_events()`);
    await db.query(`SELECT public.notify_upcoming_events()`);
    expect((await avisos(U.ana, 'event_reminder')).filter((n) => n.event_id === e).length).toBe(1);
  });

  it('actividades nuevas: amigos y gente del campus con interés, sin repetir', async () => {
    await hacerAmigos(db, U.org, U.luis);
    await db.query(`UPDATE public.profiles SET interests = ARRAY['Soccer'] WHERE id = $1`, [U.eva]);
    // Las de otras pruebas ya "se recomendaron": aquí solo cuenta la nueva.
    await db.query(`UPDATE public.events SET recommended_at = now() WHERE recommended_at IS NULL`);
    const e = await crearEvento(db, U.org, 'Partido', { desdeMin: 600 });
    await db.query(`UPDATE public.events SET category = 'sports', created_at = now() - interval '5 minutes' WHERE id = $1`, [e]);

    await db.query(`SELECT public.notify_new_events()`);
    await db.query(`SELECT public.notify_new_events()`);
    expect((await avisos(U.luis)).map((n) => n.type)).toEqual(['friend_created_event']);
    expect((await avisos(U.eva)).map((n) => n.type)).toEqual(['new_campus_event']);
    expect(await avisos(U.otro)).toEqual([]);
    await db.query(`DELETE FROM public.friendships`);
  });

  it('quedan pocos lugares: solo a quien ya se lo recomendamos', async () => {
    const e = await crearEvento(db, U.org, 'Cupo', { desdeMin: 600, maxSpots: 6 });
    await db.query(`SELECT public.notify($1, 'new_campus_event', $2, $3, NULL, NULL, '{}', $4)`, [U.eva, U.org, e, `event_new:${e}`]);
    await db.query(`UPDATE public.events SET current_spots = 4 WHERE id = $1`, [e]);
    expect((await avisos(U.eva, 'spots_low')).length).toBe(1);
    expect(await avisos(U.zoe, 'spots_low')).toEqual([]);
  });

  it('invitar amigos: solo amigos, no a quien ya está, una vez por actividad', async () => {
    await hacerAmigos(db, U.ana, U.luis);
    await hacerAmigos(db, U.ana, U.eva);
    const e = await crearEvento(db, U.org, 'Invitación', { desdeMin: 600 });
    await unirse(db, U.ana, e);
    await unirse(db, U.eva, e);
    const [{ n }] = await rpc<{ n: number }>(U.ana, `SELECT public.invite_friends_to_event($1, $2) AS n`, [e, [U.luis, U.eva, U.zoe]]);
    expect(n).toBe(1);
    const [{ n: otra }] = await rpc<{ n: number }>(U.ana, `SELECT public.invite_friends_to_event($1, $2) AS n`, [e, [U.luis]]);
    expect(otra).toBe(0);
    expect(await falla(db, U.zoe, `SELECT public.invite_friends_to_event($1, $2)`, [e, [U.luis]])).toMatch(/NOT_AN_ATTENDEE/);
    await db.query(`DELETE FROM public.friendships`);
  });
});

describe('cuenta y seguridad', () => {
  it('cambiar el correo avisa, y no se puede apagar', async () => {
    await db.query(`UPDATE public.notification_preferences SET account_tips = false WHERE user_id = $1`, [U.zoe]);
    await db.query(`UPDATE auth.users SET email = 'zoe.nueva@example.com' WHERE id = $1`, [U.zoe]);
    const [n] = await avisos(U.zoe, 'security_alert');
    expect(n.data).toEqual({ kind: 'email_changed' });
  });

  it('verificación resuelta por el sistema avisa; si la confirma la propia persona, no', async () => {
    await db.query(`INSERT INTO public.profile_affiliations (user_id, status) VALUES ($1, 'pending_email') ON CONFLICT (user_id) DO UPDATE SET status = 'pending_email'`, [U.luis]);
    await db.query(`UPDATE public.profile_affiliations SET status = 'unverified' WHERE user_id = $1`, [U.luis]);
    expect((await avisos(U.luis, 'verification_rejected')).length).toBe(1);

    // La propia persona confirmando su código (la RPC corre con su sesión):
    // ya lo ve en pantalla, no hace falta push.
    await db.query(`UPDATE public.profile_affiliations SET status = 'pending_email' WHERE user_id = $1`, [U.eva]).catch(() => undefined);
    await db.query(`INSERT INTO public.profile_affiliations (user_id, status) VALUES ($1, 'pending_email') ON CONFLICT (user_id) DO NOTHING`, [U.eva]);
    await db.exec(`SELECT set_config('request.jwt.claims', '{"sub":"${U.eva}"}', false)`);
    await db.query(
      `UPDATE public.profile_affiliations SET status = 'verified', verified_at = now(), verification_method = 'institutional_email_otp',
         university_id = (SELECT id FROM public.universities LIMIT 1) WHERE user_id = $1`, [U.eva]);
    await db.exec(`SELECT set_config('request.jwt.claims', '', false)`);
    expect(await avisos(U.eva, 'verification_approved')).toEqual([]);

    // Aprobada por el sistema (sin sesión): sí avisa.
    await db.query(`UPDATE public.profile_affiliations SET status = 'manual_review', verified_at = NULL WHERE user_id = $1`, [U.luis]);
    await db.query(
      `UPDATE public.profile_affiliations SET status = 'verified', verified_at = now(), verification_method = 'manual_review',
         university_id = (SELECT id FROM public.universities LIMIT 1) WHERE user_id = $1`, [U.luis]);
    expect((await avisos(U.luis, 'verification_approved')).length).toBe(1);
  });
});

describe('la migración', () => {
  it('se aplica sobre el estado anterior, dos veces, y no avisa de nada al aplicarse', async () => {
    const vieja = await baseReal({ antesDe: MIGRACION });
    await crearPersona(vieja, U.org, 'Org', CAMPUS.qro);
    const e = await crearEvento(vieja, U.org, 'Antes de la migración', { desdeMin: 600 });
    await vieja.exec(leerMigracion(MIGRACION));
    await vieja.exec(leerMigracion(MIGRACION));
    const { rows } = await vieja.query<{ recommended_at: string | null }>(`SELECT recommended_at FROM public.events WHERE id = $1`, [e]);
    expect(rows[0].recommended_at).not.toBeNull();
    const n = await vieja.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notifications`);
    expect(n.rows[0].n).toBe(0);
    await vieja.close();
  }, 120_000);
});
