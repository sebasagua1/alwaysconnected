// @vitest-environment node
/**
 * Chat de grupo de cada actividad (20260923000000), contra el esquema REAL.
 *
 * baseAlDia() carga supabase/setup/full_schema.sql entero en PGlite y
 * encima las migraciones nuevas, así que lo que se prueba aquí son las
 * políticas y disparadores de verdad, no una imitación.
 *
 * Lo que se fija, sobre todo, es lo que NO debe pasar: que alguien de fuera
 * lea o escriba, que quien sale o es expulsado siga dentro, que un bloqueo
 * deje interactuar, que se dupliquen filas al repetir una operación.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  baseAlDia, baseReal, leerMigracion, como, falla, crearPersona, crearEvento, unirse,
  hacerAmigos, prepararPush, peticiones, CAMPUS,
} from './fullSchema';

const MIGRACION = '20260923000000_chat-de-actividad.sql';

const U = {
  org: 'c0000000-0000-0000-0000-000000000001',
  ana: 'c0000000-0000-0000-0000-000000000002',
  luis: 'c0000000-0000-0000-0000-000000000003',
  eva: 'c0000000-0000-0000-0000-000000000004', // del campus, no se une
  pepe: 'c0000000-0000-0000-0000-000000000005', // pide unirse a uno privado
  otro: 'c0000000-0000-0000-0000-000000000006', // de otro campus
};

let db: PGlite;
let ev: string;

const enviar = (uid: string, evento: string, contenido: string, extra: { mentions?: string[]; anuncio?: boolean } = {}) =>
  falla(
    db, uid,
    `INSERT INTO public.messages (event_id, sender_id, content, mentions, is_announcement) VALUES ($1, $2, $3, $4, $5)`,
    [evento, uid, contenido, extra.mentions ?? [], extra.anuncio ?? false],
  );

const leer = (uid: string, evento: string) =>
  como(db, uid, async () =>
    (await db.query<{ content: string; sender_id: string }>(
      `SELECT content, sender_id FROM public.messages WHERE event_id = $1 ORDER BY created_at, id`, [evento],
    )).rows,
  );

const rpc = <T = Record<string, unknown>>(uid: string, sql: string, params: unknown[] = []) =>
  como(db, uid, async () => (await db.query<T>(sql, params)).rows);

beforeAll(async () => {
  db = await baseAlDia();
  await crearPersona(db, U.org, 'Org', CAMPUS.qro);
  await crearPersona(db, U.ana, 'Ana', CAMPUS.qro);
  await crearPersona(db, U.luis, 'Luis', CAMPUS.qro);
  await crearPersona(db, U.eva, 'Eva', CAMPUS.qro);
  await crearPersona(db, U.pepe, 'Pepe', CAMPUS.qro);
  await crearPersona(db, U.otro, 'Otro', CAMPUS.gdl);

  ev = await crearEvento(db, U.org, 'Futbol del jueves');
  expect(await unirse(db, U.ana, ev)).toBeNull();
  expect(await unirse(db, U.luis, ev)).toBeNull();
}, 120_000);

describe('quién está en el chat', () => {
  it('quien organiza y quien se unió pueden leer y escribir', async () => {
    expect(await enviar(U.org, ev, 'Hola a todos')).toBeNull();
    expect(await enviar(U.ana, ev, 'Yo llevo balón')).toBeNull();
    expect((await leer(U.luis, ev)).map((m) => m.content)).toEqual(['Hola a todos', 'Yo llevo balón']);
    expect((await leer(U.org, ev)).length).toBe(2);
  });

  it('alguien de fuera no lee nada ni puede escribir', async () => {
    expect(await leer(U.eva, ev)).toEqual([]);
    expect(await enviar(U.eva, ev, 'me cuelo')).toMatch(/row-level security/);
    expect(await leer(U.otro, ev)).toEqual([]);
    expect(await enviar(U.otro, ev, 'desde otro campus')).toMatch(/row-level security/);
  });

  it('pedir unirse a una privada no da acceso hasta que te aprueban', async () => {
    const priv = await crearEvento(db, U.org, 'Cena privada', { privacy: 'private' });
    expect(await unirse(db, U.pepe, priv)).toBeNull();
    expect(await enviar(U.pepe, priv, 'hola?')).toMatch(/row-level security/);
    await rpc(U.org, `SELECT public.respond_to_join_request($1, $2, true)`, [priv, U.pepe]);
    expect(await enviar(U.pepe, priv, 'gracias por aprobar')).toBeNull();
    expect((await leer(U.pepe, priv)).map((m) => m.content)).toEqual(['gracias por aprobar']);
  });

  it('no se puede mandar a nombre de otra persona', async () => {
    const err = await falla(db, U.ana,
      `INSERT INTO public.messages (event_id, sender_id, content) VALUES ($1, $2, 'suplanto')`, [ev, U.luis]);
    expect(err).toMatch(/row-level security/);
  });

  it('un mensaje va a UN chat: ni a los dos ni a ninguno', async () => {
    const dos = await como(db, U.org, async () => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO public.groups (name, created_by) VALUES ('Grupo', $1) RETURNING id`, [U.org]);
      return rows[0].id;
    });
    expect(await falla(db, U.org,
      `INSERT INTO public.messages (event_id, group_id, sender_id, content) VALUES ($1, $2, $3, 'x')`,
      [ev, dos, U.org])).not.toBeNull();
    expect(await falla(db, U.org,
      `INSERT INTO public.messages (sender_id, content) VALUES ($1, 'x')`, [U.org])).not.toBeNull();
  });

  it('los grupos siguen funcionando igual que antes', async () => {
    const g = await como(db, U.ana, async () => (await db.query<{ id: string }>(
      `INSERT INTO public.groups (name, created_by) VALUES ('Estudio', $1) RETURNING id`, [U.ana])).rows[0].id);
    expect(await falla(db, U.ana,
      `INSERT INTO public.messages (group_id, sender_id, content) VALUES ($1, $2, 'en el grupo')`, [g, U.ana])).toBeNull();
    expect(await falla(db, U.luis,
      `INSERT INTO public.messages (group_id, sender_id, content) VALUES ($1, $2, 'no soy miembro')`, [g, U.luis]))
      .toMatch(/row-level security/);
  });
});

describe('salir, expulsión y bloqueo', () => {
  it('quien sale deja de leer y escribir, y sus mensajes se quedan', async () => {
    const e = await crearEvento(db, U.org, 'Salida al cine');
    await unirse(db, U.luis, e);
    expect(await enviar(U.luis, e, 'me apunto')).toBeNull();

    await falla(db, U.luis, `DELETE FROM public.event_participants WHERE event_id = $1 AND user_id = $2`, [e, U.luis]);

    expect(await leer(U.luis, e)).toEqual([]); // ni lo suyo
    expect(await enviar(U.luis, e, 'sigo aqui?')).toMatch(/row-level security/);
    expect((await leer(U.org, e)).map((m) => m.content)).toEqual(['me apunto']);
  });

  it('el organizador expulsa: pierde el acceso al instante y no puede volver solo', async () => {
    const e = await crearEvento(db, U.org, 'Taller');
    await unirse(db, U.ana, e);
    expect(await enviar(U.ana, e, 'antes de irme')).toBeNull();

    expect(await falla(db, U.org, `SELECT public.remove_event_participant($1, $2, 'spam')`, [e, U.ana])).toBeNull();

    expect(await leer(U.ana, e)).toEqual([]);
    expect(await enviar(U.ana, e, 'vuelvo')).toMatch(/row-level security/);
    expect(await unirse(db, U.ana, e)).toMatch(/REMOVED_FROM_EVENT/);
    // El mensaje de antes sigue ahí para los demás.
    expect((await leer(U.org, e)).map((m) => m.content)).toEqual(['antes de irme']);

    // Lo ve ella (para entender por qué) y quien organiza; nadie más.
    const suyo = await rpc(U.ana, `SELECT user_id FROM public.event_removals WHERE event_id = $1`, [e]);
    expect(suyo.length).toBe(1);
    expect(await rpc(U.luis, `SELECT user_id FROM public.event_removals WHERE event_id = $1`, [e])).toEqual([]);
    const [resumen] = await rpc<{ can_access: boolean; removed: boolean }>(U.ana, `SELECT * FROM public.event_chat_summary($1)`, [e]);
    expect(resumen).toMatchObject({ can_access: false, removed: true });

    // Readmitir deshace la expulsión.
    expect(await falla(db, U.org, `SELECT public.readmit_event_participant($1, $2)`, [e, U.ana])).toBeNull();
    expect(await unirse(db, U.ana, e)).toBeNull();
    expect(await enviar(U.ana, e, 'de vuelta')).toBeNull();
  });

  it('solo quien organiza puede expulsar o moderar', async () => {
    expect(await falla(db, U.ana, `SELECT public.remove_event_participant($1, $2)`, [ev, U.luis])).toMatch(/NOT_THE_ORGANIZER/);
    const [m] = await rpc<{ id: string }>(U.luis, `SELECT id FROM public.messages WHERE event_id = $1 AND sender_id = $2 LIMIT 1`, [ev, U.ana]);
    expect(await falla(db, U.luis, `SELECT public.moderate_event_message($1)`, [m.id])).toMatch(/NOT_THE_ORGANIZER/);
    // Y editar o borrar mensajes ajenos directamente no toca ninguna fila.
    const tocadas = await como(db, U.luis, async () =>
      (await db.query(`UPDATE public.messages SET deleted_at = now() WHERE id = $1 RETURNING id`, [m.id])).rows.length);
    expect(tocadas).toBe(0);
  });

  it('el organizador borra un mensaje: se vacía y queda quién fue', async () => {
    await enviar(U.luis, ev, 'algo inapropiado');
    const [m] = await rpc<{ id: string }>(U.org, `SELECT id FROM public.messages WHERE content = 'algo inapropiado'`);
    expect(await falla(db, U.org, `SELECT public.moderate_event_message($1)`, [m.id])).toBeNull();
    const { rows } = await db.query<{ content: string; deleted_at: string | null; deleted_by: string }>(
      `SELECT content, deleted_at, deleted_by FROM public.messages WHERE id = $1`, [m.id]);
    expect(rows[0]).toMatchObject({ content: '', deleted_by: U.org });
    expect(rows[0].deleted_at).not.toBeNull();
    const log = await rpc<{ action: string }>(U.org, `SELECT action FROM public.event_moderation_log WHERE message_id = $1`, [m.id]);
    expect(log.map((l) => l.action)).toEqual(['delete_message']);
  });

  it('entre bloqueados no se leen, aunque compartan chat', async () => {
    const e = await crearEvento(db, U.org, 'Paseo');
    await unirse(db, U.ana, e);
    await unirse(db, U.luis, e);
    await enviar(U.ana, e, 'de ana');
    await enviar(U.luis, e, 'de luis');
    await como(db, U.luis, () => db.query(`INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [U.luis, U.ana]));

    expect((await leer(U.luis, e)).map((m) => m.content)).toEqual(['de luis']);
    expect((await leer(U.ana, e)).map((m) => m.content)).toEqual(['de ana']);
    // Mencionar a quien te bloqueó no menciona a nadie.
    await enviar(U.ana, e, '@Luis ?', { mentions: [U.luis] });
    const { rows } = await db.query<{ mentions: string[] }>(`SELECT mentions FROM public.messages WHERE content = '@Luis ?'`);
    expect(rows[0].mentions).toEqual([]);
    await db.query(`DELETE FROM public.blocks WHERE blocker_id = $1`, [U.luis]);
  });

  it('si el organizador bloquea a alguien, sale de sus actividades futuras', async () => {
    const e = await crearEvento(db, U.org, 'Karaoke');
    await unirse(db, U.eva, e);
    expect(await enviar(U.eva, e, 'hola')).toBeNull();
    await como(db, U.org, () => db.query(`INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [U.org, U.eva]));

    const { rows } = await db.query(`SELECT 1 FROM public.event_participants WHERE event_id = $1 AND user_id = $2`, [e, U.eva]);
    expect(rows).toEqual([]);
    expect(await leer(U.eva, e)).toEqual([]);
    expect(await enviar(U.eva, e, 'sigo?')).toMatch(/row-level security/);
    await db.query(`DELETE FROM public.blocks WHERE blocker_id = $1`, [U.org]);
  });
});

describe('menciones y avisos', () => {
  it('solo se guardan menciones a miembros, sin repetir, sin uno mismo', async () => {
    await enviar(U.ana, ev, '@Luis @Eva @Ana', { mentions: [U.luis, U.eva, U.ana, U.luis, U.otro] });
    const { rows } = await db.query<{ mentions: string[] }>(`SELECT mentions FROM public.messages WHERE content = '@Luis @Eva @Ana'`);
    expect(rows[0].mentions).toEqual([U.luis]);
  });

  it('el aviso del organizador solo lo puede mandar quien organiza', async () => {
    expect(await enviar(U.ana, ev, 'aviso falso', { anuncio: true })).toMatch(/ANNOUNCEMENT_NOT_ALLOWED/);
    expect(await enviar(U.org, ev, 'Cambiamos de cancha', { anuncio: true })).toBeNull();
  });

  it('las menciones y el aviso no se pueden cambiar al editar', async () => {
    const [m] = await rpc<{ id: string }>(U.ana, `SELECT id FROM public.messages WHERE content = '@Luis @Eva @Ana'`);
    const err = await falla(db, U.ana, `UPDATE public.messages SET mentions = '{}' WHERE id = $1`, [m.id]);
    expect(err).toMatch(/MESSAGE_FIELD_LOCKED/);
  });
});

describe('leídos, silencio y contadores', () => {
  it('quien entra empieza al día y los mensajes de otros cuentan como no leídos', async () => {
    const e = await crearEvento(db, U.org, 'Estudio de cálculo');
    await enviar(U.org, e, 'bienvenidos');
    await unirse(db, U.luis, e);
    let [r] = await rpc<{ unread: string }>(U.luis, `SELECT unread FROM public.event_chat_summary($1)`, [e]);
    expect(Number(r.unread)).toBe(0);

    await enviar(U.org, e, 'traigan calculadora');
    await enviar(U.org, e, 'y apuntes');
    [r] = await rpc<{ unread: string }>(U.luis, `SELECT unread FROM public.event_chat_summary($1)`, [e]);
    expect(Number(r.unread)).toBe(2);
    const porEvento = await rpc<{ event_id: string; unread: string }>(U.luis, `SELECT * FROM public.event_chat_unread()`);
    expect(Number(porEvento.find((x) => x.event_id === e)?.unread)).toBe(2);
    const [c] = await rpc<{ event_chat_unread: string }>(U.luis, `SELECT event_chat_unread FROM public.notification_counts()`);
    expect(Number(c.event_chat_unread)).toBeGreaterThanOrEqual(2);

    await rpc(U.luis, `SELECT public.mark_event_chat_read($1)`, [e]);
    await rpc(U.luis, `SELECT public.mark_event_chat_read($1)`, [e]);
    [r] = await rpc<{ unread: string }>(U.luis, `SELECT unread FROM public.event_chat_summary($1)`, [e]);
    expect(Number(r.unread)).toBe(0);
    // Repetir no duplica: una sola fila de estado por persona y chat.
    const { rows } = await db.query(`SELECT 1 FROM public.event_chat_state WHERE event_id = $1 AND user_id = $2`, [e, U.luis]);
    expect(rows.length).toBe(1);
  });

  it('nadie lee ni cambia el estado de otra persona', async () => {
    expect(await rpc(U.ana, `SELECT * FROM public.event_chat_state WHERE user_id = $1`, [U.luis])).toEqual([]);
    expect(await falla(db, U.ana, `UPDATE public.event_chat_state SET muted = true WHERE user_id = $1`, [U.luis]))
      .toMatch(/permission denied/);
    expect(await falla(db, U.eva, `SELECT public.set_event_chat_muted($1, true)`, [ev])).toMatch(/NOT_A_CHAT_MEMBER/);
    // Fuera del chat, los miembros no se listan.
    expect(await rpc(U.eva, `SELECT * FROM public.event_chat_members($1)`, [ev])).toEqual([]);
    expect((await rpc(U.ana, `SELECT * FROM public.event_chat_members($1)`, [ev])).length).toBeGreaterThanOrEqual(3);
  });

  it('la función con dos argumentos no la puede llamar la app', async () => {
    expect(await falla(db, U.eva, `SELECT public.event_chat_member($1, $2)`, [ev, U.ana])).toMatch(/permission denied/);
  });
});

describe('push del chat', () => {
  beforeEach(async () => { await peticiones(db); });

  const destinatarios = async () =>
    (await peticiones(db))
      .filter((p) => p.url.endsWith('/send-push'))
      .map((p) => ({ user: p.body.user_id as string, type: (p.body.data as { type: string }).type }));

  it('avisa a los demás, nunca a quien escribe, y agrupa los seguidos', async () => {
    const e = await crearEvento(db, U.org, 'Voley');
    await unirse(db, U.ana, e);
    await unirse(db, U.luis, e);
    await prepararPush(db, U.org, U.ana, U.luis);
    await peticiones(db);

    await enviar(U.ana, e, 'primero');
    expect((await destinatarios()).map((d) => d.user).sort()).toEqual([U.org, U.luis].sort());

    await enviar(U.ana, e, 'segundo, justo después');
    expect(await destinatarios()).toEqual([]);

    // Tras leer, el siguiente vuelve a avisar.
    await rpc(U.luis, `SELECT public.mark_event_chat_read($1)`, [e]);
    await enviar(U.ana, e, 'tercero');
    expect((await destinatarios()).map((d) => d.user)).toEqual([U.luis]);
  });

  it('silenciado no avisa, pero una mención sí', async () => {
    const e = await crearEvento(db, U.org, 'Pádel');
    await unirse(db, U.ana, e);
    await unirse(db, U.luis, e);
    await prepararPush(db, U.org, U.ana, U.luis);
    await rpc(U.luis, `SELECT public.set_event_chat_muted($1, true)`, [e]);
    await peticiones(db);

    await enviar(U.ana, e, 'normal');
    expect((await destinatarios()).map((d) => d.user)).toEqual([U.org]);

    await enviar(U.ana, e, '@Luis mira', { mentions: [U.luis] });
    const d = await destinatarios();
    expect(d.find((x) => x.user === U.luis)?.type).toBe('chat_mention');
  });

  it('con el chat abierto no hay push', async () => {
    const e = await crearEvento(db, U.org, 'Ajedrez');
    await unirse(db, U.ana, e);
    await prepararPush(db, U.org, U.ana);
    await rpc(U.org, `SELECT public.set_event_chat_presence($1, true)`, [e]);
    await peticiones(db);

    await enviar(U.ana, e, 'org está mirando');
    expect(await destinatarios()).toEqual([]);

    await rpc(U.org, `SELECT public.set_event_chat_presence($1, false)`, [e]);
    await enviar(U.ana, e, 'ya se fue');
    expect((await destinatarios()).map((d) => d.user)).toEqual([U.org]);
  });
});

describe('la migración', () => {
  it('se aplica sobre el estado anterior y otra vez encima sin romper nada', async () => {
    const vieja = await baseReal({ antesDe: MIGRACION });
    const e = await crearEvento(vieja, U.org, 'x').catch(() => null);
    // Sin perfiles no hay eventos: lo importante es que aplicar dos veces no falle.
    expect(e === null || typeof e === 'string').toBe(true);
    await vieja.exec(leerMigracion(MIGRACION));
    await vieja.exec(leerMigracion(MIGRACION));
    const { rows } = await vieja.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'messages' AND schemaname = 'public'`);
    expect(rows[0].n).toBe(3);
    await vieja.close();
  }, 120_000);

  it('no hay dos filas de estado por persona aunque se entre y salga', async () => {
    const e = await crearEvento(db, U.org, 'Correr');
    await unirse(db, U.ana, e);
    await falla(db, U.ana, `DELETE FROM public.event_participants WHERE event_id = $1 AND user_id = $2`, [e, U.ana]);
    await unirse(db, U.ana, e);
    const { rows } = await db.query(`SELECT 1 FROM public.event_chat_state WHERE event_id = $1 AND user_id = $2`, [e, U.ana]);
    expect(rows.length).toBe(1);
  });
});

// Para que TypeScript no se queje de la amistad sin usar en esta versión.
void hacerAmigos;
