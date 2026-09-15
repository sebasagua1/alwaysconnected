// @vitest-environment node
/**
 * Después del evento: repetir el plan (con aviso) y convertirlo en grupo por
 * invitación. Corre en PGlite sobre sql/eventos-sociales.sql; push_send
 * apunta en push_log en vez de llamar a APNs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const raiz = join(__dirname, '..', '..', 'supabase', 'migrations');
const FIXTURE = readFileSync(join(__dirname, 'sql', 'eventos-sociales.sql'), 'utf8');
const ASISTENTES = readFileSync(join(raiz, '20260918000000_ver-asistentes.sql'), 'utf8');
const MIGRACION = readFileSync(join(raiz, '20260919000000_despues-del-evento.sql'), 'utf8');

const QRO = '11111111-1111-1111-1111-111111111111';
const GDL = '22222222-2222-2222-2222-222222222222';
const U = {
  org: 'b0000000-0000-0000-0000-000000000001',
  ana: 'b0000000-0000-0000-0000-000000000002',
  luis: 'b0000000-0000-0000-0000-000000000003',
  pend: 'b0000000-0000-0000-0000-000000000004',
  ajena: 'b0000000-0000-0000-0000-000000000005', // mismo campus, no fue
  gdl: 'b0000000-0000-0000-0000-000000000006', // fue, pero cambió de campus
  bloq: 'b0000000-0000-0000-0000-000000000007', // fue; org la bloqueó después
};

let db: PGlite;
let pasado: string; // evento de org que ya terminó

async function como<T = Record<string, unknown>>(uid: string, sql: string, params: unknown[] = []) {
  await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub', '${uid}', false); SET ROLE authenticated;`);
  try {
    return { rows: (await db.query<T>(sql, params)).rows, error: null as string | null };
  } catch (e) {
    return { rows: [] as T[], error: (e as Error).message };
  } finally {
    await db.exec('RESET ROLE');
  }
}

const pushes = async () =>
  (await db.query<{ user_id: string; body: string; data: { type: string } }>('SELECT user_id, body, data FROM public.push_log ORDER BY at')).rows;
const limpiarPush = () => db.exec('DELETE FROM public.push_log');

const repetir = (uid: string, desde: string | null, privacy = 'open') =>
  como<{ id: string }>(
    uid,
    `INSERT INTO public.events (creator_id, title, privacy, starts_at, ends_at, repeated_from)
     VALUES ($1, 'Padel', $2, now() + interval '7 days', now() + interval '7 days 1 hour', $3) RETURNING id`,
    [uid, privacy, desde],
  );

beforeAll(async () => {
  db = new PGlite();
  await db.exec(FIXTURE);
  await db.exec(ASISTENTES);
  await db.exec(MIGRACION);
  await db.exec(MIGRACION); // idempotente

  for (const [k, id] of Object.entries(U)) {
    await db.query('INSERT INTO auth.users (id) VALUES ($1)', [id]);
    await db.query('INSERT INTO public.profiles (id, name, campus_id) VALUES ($1, $2, $3)', [id, k, k === 'gdl' ? GDL : QRO]);
  }
  pasado = (await db.query<{ id: string }>(
    `INSERT INTO public.events (creator_id, title) VALUES ($1, 'Padel') RETURNING id`, [U.org],
  )).rows[0].id;
  await db.query(
    `INSERT INTO public.event_participants (event_id, user_id, status) VALUES
      ($1, $2, 'joined'), ($1, $3, 'joined'), ($1, $4, 'pending'), ($1, $5, 'joined'), ($1, $6, 'joined')`,
    [pasado, U.ana, U.luis, U.pend, U.gdl, U.bloq],
  );
  await db.query('INSERT INTO public.blocks VALUES ($1, $2)', [U.org, U.bloq]);
  await db.query(`INSERT INTO public.friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'accepted')`, [U.org, U.ana]);
});

describe('repetir el plan', () => {
  it('quien organizó lo repite y avisa a quien fue y puede verlo, con el texto con acentos', async () => {
    await limpiarPush();
    const r = await repetir(U.org, pasado);
    expect(r.error).toBeNull();
    const p = await pushes();
    // Ni la pendiente, ni otro campus, ni la bloqueada, ni quien organiza.
    expect(p.map((x) => x.user_id).sort()).toEqual([U.ana, U.luis].sort());
    expect(p[0].body).toBe('org organizó otra vez «Padel». ¿Te apuntas?');
    expect(p[0].data).toEqual({ type: 'event_repeat', event_id: r.rows[0].id });
  });

  it('publicarlo otra vez el mismo día no vuelve a avisar', async () => {
    await limpiarPush();
    expect((await repetir(U.org, pasado)).error).toBeNull();
    expect(await pushes()).toEqual([]);
  });

  it('quien fue también puede repetirlo, y avisa a quien organizó', async () => {
    await limpiarPush();
    expect((await repetir(U.luis, pasado)).error).toBeNull();
    // "bloq" sí: la bloqueó org, no Luis. Los bloqueos son entre dos personas.
    expect((await pushes()).map((x) => x.user_id).sort()).toEqual([U.ana, U.org, U.bloq].sort());
  });

  it('"solo amigos" avisa solo a amigos de quien lo publica', async () => {
    await limpiarPush();
    await db.query(`DELETE FROM public.events WHERE repeated_from = $1 AND creator_id = $2`, [pasado, U.ana]);
    expect((await repetir(U.ana, pasado, 'friends')).error).toBeNull();
    expect((await pushes()).map((x) => x.user_id)).toEqual([U.org]);
  });

  it('quien no fue (o solo lo pidió) no puede colgarse de un evento ajeno', async () => {
    expect((await repetir(U.ajena, pasado)).error).toMatch(/REPEAT_NOT_ALLOWED/);
    expect((await repetir(U.pend, pasado)).error).toMatch(/REPEAT_NOT_ALLOWED/);
  });

  it('repeated_from no se cambia después', async () => {
    const nuevo = (await repetir(U.org, null)).rows[0].id;
    const r = await como(U.org, 'UPDATE public.events SET repeated_from = $1 WHERE id = $2', [pasado, nuevo]);
    expect(r.error).toMatch(/REPEAT_IMMUTABLE/);
  });
});

describe('convertir en grupo', () => {
  let grupo: string;

  it('solo quien fue, y con el evento ya empezado', async () => {
    expect((await como(U.ajena, 'SELECT public.create_group_from_event($1)', [pasado])).error).toMatch(/NOT_AN_ATTENDEE/);
    expect((await como(U.pend, 'SELECT public.create_group_from_event($1)', [pasado])).error).toMatch(/NOT_AN_ATTENDEE/);
    expect((await como(U.org, 'SELECT public.create_group_from_event($1)', ['99999999-9999-9999-9999-999999999999'])).error).toMatch(/NOT_AN_ATTENDEE/);
    const futuro = (await repetir(U.org, null)).rows[0].id;
    expect((await como(U.org, 'SELECT public.create_group_from_event($1)', [futuro])).error).toMatch(/EVENT_NOT_STARTED/);
  });

  it('crea el grupo, mete solo a quien lo crea e invita (con push) a los demás', async () => {
    await limpiarPush();
    const r = await como<{ id: string }>(U.org, `SELECT public.create_group_from_event($1, '  Padel martes  ') AS id`, [pasado]);
    expect(r.error).toBeNull();
    grupo = r.rows[0].id;
    const miembros = (await db.query<{ user_id: string }>('SELECT user_id FROM public.group_members WHERE group_id = $1', [grupo])).rows;
    expect(miembros.map((m) => m.user_id)).toEqual([U.org]);
    expect((await db.query<{ name: string }>('SELECT name FROM public.groups WHERE id = $1', [grupo])).rows[0].name).toBe('Padel martes');
    // Invitados: los que fueron, menos la bloqueada. Otro campus sí: ya
    // compartieron el evento, y entra solo si acepta.
    const p = await pushes();
    expect(p.map((x) => x.user_id).sort()).toEqual([U.ana, U.luis, U.gdl].sort());
    expect(p[0].body).toBe('org te invitó a «Padel martes»');
    expect(p[0].data).toEqual({ type: 'group_invite', group_id: grupo });
  });

  it('llamarla otra vez devuelve el mismo grupo y no reenvía invitaciones', async () => {
    await limpiarPush();
    const r = await como<{ id: string }>(U.org, 'SELECT public.create_group_from_event($1) AS id', [pasado]);
    expect(r.rows[0].id).toBe(grupo);
    expect(await pushes()).toEqual([]);
  });

  it('la invitación se ve, cuenta en el globo y aceptarla mete en el grupo', async () => {
    const inv = await como<{ invite_id: string; group_name: string; inviter_name: string; event_title: string }>(
      U.ana, 'SELECT * FROM public.my_group_invites()',
    );
    expect(inv.rows).toHaveLength(1);
    expect(inv.rows[0]).toMatchObject({ group_name: 'Padel martes', inviter_name: 'org', event_title: 'Padel' });

    const antes = await como<{ group_invites: string; approvals: string }>(U.ana, 'SELECT * FROM public.notification_counts()');
    expect(Number(antes.rows[0].group_invites)).toBe(1);

    const r = await como<{ g: string }>(U.ana, 'SELECT public.respond_group_invite($1, true) AS g', [inv.rows[0].invite_id]);
    expect(r.rows[0].g).toBe(grupo);
    expect((await db.query('SELECT 1 FROM public.group_members WHERE group_id = $1 AND user_id = $2', [grupo, U.ana])).rows).toHaveLength(1);
    expect((await como(U.ana, 'SELECT * FROM public.my_group_invites()')).rows).toEqual([]);
    expect(Number((await como<{ group_invites: string }>(U.ana, 'SELECT * FROM public.notification_counts()')).rows[0].group_invites)).toBe(0);
    // Aceptar dos veces no falla.
    expect((await como(U.ana, 'SELECT public.respond_group_invite($1, true)', [inv.rows[0].invite_id])).error).toBeNull();
  });

  it('rechazar no mete a nadie y no se puede cambiar de opinión con la misma invitación', async () => {
    const inv = (await como<{ invite_id: string }>(U.luis, 'SELECT * FROM public.my_group_invites()')).rows[0];
    await como(U.luis, 'SELECT public.respond_group_invite($1, false)', [inv.invite_id]);
    expect((await db.query('SELECT 1 FROM public.group_members WHERE group_id = $1 AND user_id = $2', [grupo, U.luis])).rows).toEqual([]);
    expect((await como(U.luis, 'SELECT public.respond_group_invite($1, true)', [inv.invite_id])).error).toMatch(/INVITE_ALREADY_ANSWERED/);
  });

  it('nadie responde invitaciones ajenas ni lee la tabla directamente', async () => {
    const inv = (await db.query<{ id: string }>('SELECT id FROM public.group_invites WHERE invitee_id = $1', [U.gdl])).rows[0];
    expect((await como(U.ajena, 'SELECT public.respond_group_invite($1, true)', [inv.id])).error).toMatch(/INVITE_NOT_FOUND/);
    expect((await como(U.gdl, 'SELECT * FROM public.group_invites')).error).toMatch(/permission denied/);
    expect((await como(U.gdl, `INSERT INTO public.group_invites (group_id, inviter_id, invitee_id) VALUES ($1, $2, $3)`, [grupo, U.gdl, U.ajena])).error).toMatch(/permission denied/);
  });

  it('si después se bloquean, la invitación desaparece y no se puede aceptar', async () => {
    const inv = (await db.query<{ id: string }>('SELECT id FROM public.group_invites WHERE invitee_id = $1', [U.gdl])).rows[0];
    await db.query('INSERT INTO public.blocks VALUES ($1, $2)', [U.gdl, U.org]);
    expect((await como(U.gdl, 'SELECT * FROM public.my_group_invites()')).rows).toEqual([]);
    expect((await como(U.gdl, 'SELECT public.respond_group_invite($1, true)', [inv.id])).error).toMatch(/INVITE_NOT_FOUND/);
  });

  it('un nombre que imita a un DM se rechaza', async () => {
    const otro = (await db.query<{ id: string }>(`INSERT INTO public.events (creator_id, title) VALUES ($1, 'Cafe') RETURNING id`, [U.ana])).rows[0].id;
    expect((await como(U.ana, `SELECT public.create_group_from_event($1, '__dm_x_y')`, [otro])).error).toMatch(/INVALID_NAME/);
  });
});
