// @vitest-environment node
/**
 * Contactos e invitaciones (20260924000000), contra el esquema REAL.
 *
 * La Edge Function contacts-match se simula llamando a sus RPC con el rol
 * service_role, que es lo que hace ella. Los digest son cadenas hex de 64
 * cualesquiera: aquí da igual cómo se calculan (eso lo prueba
 * contactIdentity.test.ts), lo que importa es qué deja pasar la base.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { baseAlDia, como, falla, crearPersona, hacerAmigos, prepararPush, peticiones, CAMPUS } from './fullSchema';

const U = {
  yo: 'e0000000-0000-0000-0000-000000000001',
  ana: 'e0000000-0000-0000-0000-000000000002', // encontrable, mismo campus
  luis: 'e0000000-0000-0000-0000-000000000003', // NO encontrable
  gdl: 'e0000000-0000-0000-0000-000000000004', // encontrable, otro campus
  eva: 'e0000000-0000-0000-0000-000000000005', // encontrable, me bloqueará
  nuevo: 'e0000000-0000-0000-0000-000000000006', // se une después
  zoe: 'e0000000-0000-0000-0000-000000000007', // encontrable, la bloquearé yo
};

const d = (n: number) => n.toString(16).padStart(64, '0');
const D = { ana: d(1), luis: d(2), gdl: d(3), eva: d(4), nuevo: d(5), nadie: d(6), zoe: d(7) };

let db: PGlite;

/** Como la Edge Function: con service_role, sin sesión de usuario. */
async function servicio<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec(`SET ROLE service_role`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec(`RESET ROLE`);
  }
}

const registrar = (uid: string, digest: string) =>
  servicio<{ n: number }>(`SELECT public.contacts_register_identifiers($1, $2::jsonb) AS n`, [uid, JSON.stringify([{ kind: 'email', digest }])]);

const buscar = (uid: string, digests: string[], keep = false) =>
  servicio<{ digest: string; user_id: string; name: string; campus_name: string | null; relation: string }>(
    `SELECT * FROM public.contacts_match($1, $2, $3)`, [uid, digests, keep]);

const ajustes = (uid: string, discoverable: boolean, notify: boolean) =>
  falla(db, uid, `SELECT public.set_contact_settings($1, $2)`, [discoverable, notify]);

beforeAll(async () => {
  db = await baseAlDia();
  await crearPersona(db, U.yo, 'Yo', CAMPUS.qro);
  await crearPersona(db, U.ana, 'Ana', CAMPUS.qro);
  await crearPersona(db, U.luis, 'Luis', CAMPUS.qro);
  await crearPersona(db, U.gdl, 'Gaby', CAMPUS.gdl);
  await crearPersona(db, U.eva, 'Eva', CAMPUS.qro);
  await crearPersona(db, U.zoe, 'Zoe', CAMPUS.qro);

  for (const [uid, dig] of [[U.ana, D.ana], [U.gdl, D.gdl], [U.eva, D.eva], [U.zoe, D.zoe]] as const) {
    expect(await ajustes(uid, true, false)).toBeNull();
    await registrar(uid, dig);
  }
  // Luis no quiere que lo encuentren: aunque la app intentara registrarle, no queda nada.
  await ajustes(U.luis, false, false);
  await registrar(U.luis, D.luis);
}, 120_000);

describe('lo que la app no puede ver', () => {
  it('ninguna tabla de contactos se lee desde el cliente', async () => {
    for (const tabla of ['contact_identifiers', 'contact_book_hashes', 'contact_matches', 'contact_sync_usage', 'invite_events']) {
      expect(await falla(db, U.yo, `SELECT * FROM public.${tabla}`)).toMatch(/permission denied/);
    }
  });

  it('ni se escribe directamente', async () => {
    expect(await falla(db, U.yo, `INSERT INTO public.contact_identifiers (user_id, kind, digest) VALUES ($1, 'email', $2)`, [U.yo, D.nadie]))
      .toMatch(/permission denied/);
    expect(await falla(db, U.yo, `UPDATE public.contact_settings SET discoverable = true WHERE user_id = $1`, [U.ana]))
      .toMatch(/permission denied/);
  });

  it('las RPC de la Edge Function no las puede llamar la app', async () => {
    expect(await falla(db, U.yo, `SELECT * FROM public.contacts_match($1, $2)`, [U.yo, [D.ana]])).toMatch(/permission denied/);
    expect(await falla(db, U.yo, `SELECT public.contacts_consume_quota($1, 1)`, [U.yo])).toMatch(/permission denied/);
    expect(await falla(db, U.yo, `SELECT public.contacts_register_identifiers($1, '[]')`, [U.yo])).toMatch(/permission denied/);
  });

  it('solo ves tus propios ajustes', async () => {
    const mios = await como(db, U.yo, async () => (await db.query(`SELECT * FROM public.contact_settings`)).rows);
    expect(mios.every((r) => (r as { user_id: string }).user_id === U.yo)).toBe(true);
  });
});

describe('coincidencias', () => {
  it('encuentra solo a quien es encontrable, del mismo campus, con lo mínimo', async () => {
    const r = await buscar(U.yo, [D.ana, D.luis, D.gdl, D.nadie]);
    expect(r.map((x) => x.user_id)).toEqual([U.ana]);
    expect(Object.keys(r[0]).sort()).toEqual(['avatar_url', 'campus_name', 'digest', 'friendship_id', 'name', 'relation', 'user_id']);
    expect(r[0]).toMatchObject({ name: 'Ana', relation: 'none' });
  });

  it('dice la relación: amigos o solicitud enviada', async () => {
    await hacerAmigos(db, U.yo, U.ana);
    expect((await buscar(U.yo, [D.ana]))[0].relation).toBe('friends');
    await db.query(`DELETE FROM public.friendships WHERE requester_id = $1`, [U.yo]);
    await db.query(`INSERT INTO public.friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'pending')`, [U.yo, U.ana]);
    expect((await buscar(U.yo, [D.ana]))[0].relation).toBe('outgoing');
    await db.query(`DELETE FROM public.friendships WHERE requester_id = $1`, [U.yo]);
  });

  it('quien me bloqueó no aparece; a quien yo bloqueé sale como bloqueado', async () => {
    await db.query(`INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [U.eva, U.yo]);
    await db.query(`INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [U.yo, U.zoe]);
    const r = await buscar(U.yo, [D.eva, D.zoe]);
    expect(r.map((x) => [x.user_id, x.relation])).toEqual([[U.zoe, 'blocked']]);
    await db.query(`DELETE FROM public.blocks`);
  });

  it('dejar de ser encontrable borra tus identificadores en el acto', async () => {
    await ajustes(U.ana, false, false);
    expect(await buscar(U.yo, [D.ana])).toEqual([]);
    const { rows } = await db.query(`SELECT 1 FROM public.contact_identifiers WHERE user_id = $1`, [U.ana]);
    expect(rows).toEqual([]);
    await ajustes(U.ana, true, false);
    await registrar(U.ana, D.ana);
  });

  it('cambiar el correo invalida el identificador de correo', async () => {
    await db.query(`UPDATE auth.users SET email = 'ana.nueva@example.com' WHERE id = $1`, [U.ana]);
    expect(await buscar(U.yo, [D.ana])).toEqual([]);
    await registrar(U.ana, D.ana);
    expect((await buscar(U.yo, [D.ana])).length).toBe(1);
  });
});

describe('cuota: no se puede enumerar', () => {
  it('más de 500 por petición se rechaza', async () => {
    const err = await servicio(`SELECT public.contacts_consume_quota($1, 501)`, [U.luis]).catch((e: Error) => e.message);
    expect(err).toMatch(/CONTACTS_BATCH_TOO_LARGE/);
  });

  it('más de 2000 al día se rechaza', async () => {
    for (let i = 0; i < 4; i++) await servicio(`SELECT public.contacts_consume_quota($1, 500)`, [U.gdl]);
    const err = await servicio(`SELECT public.contacts_consume_quota($1, 1)`, [U.gdl]).catch((e: Error) => e.message);
    expect(err).toMatch(/CONTACTS_RATE_LIMIT/);
  });

  it('más de 20 peticiones al día se rechaza aunque sean pequeñas', async () => {
    for (let i = 0; i < 20; i++) await servicio(`SELECT public.contacts_consume_quota($1, 1)`, [U.eva]);
    const err = await servicio(`SELECT public.contacts_consume_quota($1, 1)`, [U.eva]).catch((e: Error) => e.message);
    expect(err).toMatch(/CONTACTS_RATE_LIMIT/);
  });
});

describe('la agenda solo se guarda si pides el aviso', () => {
  beforeEach(async () => { await peticiones(db); });

  it('sin aviso no queda nada guardado de la agenda', async () => {
    await ajustes(U.yo, true, false);
    await buscar(U.yo, [D.nuevo, D.nadie], true);
    const { rows } = await db.query(`SELECT 1 FROM public.contact_book_hashes WHERE owner_id = $1`, [U.yo]);
    expect(rows).toEqual([]);
  });

  it('con aviso: cuando un contacto se une y es encontrable, avisa una sola vez', async () => {
    await ajustes(U.yo, true, true);
    await prepararPush(db, U.yo);
    await buscar(U.yo, [D.nuevo, D.nadie], true);

    await crearPersona(db, U.nuevo, 'Nuevo', CAMPUS.qro);
    await ajustes(U.nuevo, true, false);
    const [{ n }] = await registrar(U.nuevo, D.nuevo);
    expect(n).toBe(1);
    // Desde 20260925 el aviso va a la bandeja y a la cola (notify), no a send-push.
    const avisos = async () => (await db.query<{ user_id: string; actor_id: string }>(
      `SELECT user_id, actor_id FROM public.notifications WHERE type = 'contact_joined'`)).rows;
    expect(await avisos()).toEqual([{ user_id: U.yo, actor_id: U.nuevo }]);

    // Registrar otra vez (cada arranque de la app) no vuelve a avisar.
    await registrar(U.nuevo, D.nuevo);
    expect((await avisos()).length).toBe(1);
  });

  it('apagar el aviso borra la agenda guardada', async () => {
    await ajustes(U.yo, true, false);
    const { rows } = await db.query(`SELECT 1 FROM public.contact_book_hashes WHERE owner_id = $1`, [U.yo]);
    expect(rows).toEqual([]);
  });

  it('borrar mis datos de contactos lo quita todo y apaga los ajustes', async () => {
    expect(await falla(db, U.yo, `SELECT public.clear_contact_data()`)).toBeNull();
    for (const [tabla, col] of [['contact_matches', 'owner_id'], ['contact_identifiers', 'user_id'], ['contact_book_hashes', 'owner_id']]) {
      const { rows } = await db.query(`SELECT 1 FROM public.${tabla} WHERE ${col} = $1`, [U.yo]);
      expect(rows).toEqual([]);
    }
    const [s] = await como(db, U.yo, async () => (await db.query<{ discoverable: boolean; notify_contacts_join: boolean }>(
      `SELECT * FROM public.my_contact_settings()`)).rows);
    expect(s).toMatchObject({ discoverable: false, notify_contacts_join: false });
  });
});

describe('sugerencias', () => {
  it('quien está en tus contactos sale primero y marcado', async () => {
    await buscar(U.luis, [D.ana]);
    const r = await como(db, U.luis, async () => (await db.query<{ id: string; in_contacts: boolean }>(
      `SELECT id, in_contacts FROM public.people_suggestions(10)`)).rows);
    expect(r[0]).toEqual({ id: U.ana, in_contacts: true });
    expect(r.filter((x) => x.in_contacts).length).toBe(1);
  });
});

describe('invitaciones', () => {
  it('cada persona tiene un código opaco y estable', async () => {
    const [a] = await como(db, U.ana, async () => (await db.query<{ c: string }>(`SELECT public.my_invite_code() AS c`)).rows);
    const [b] = await como(db, U.ana, async () => (await db.query<{ c: string }>(`SELECT public.my_invite_code() AS c`)).rows);
    expect(a.c).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(b.c).toBe(a.c);
    expect(a.c).not.toContain(U.ana.slice(0, 4));
  });

  it('canjear devuelve a quien invitó (si se ve) y cuenta una sola vez', async () => {
    const [{ c }] = await como(db, U.ana, async () => (await db.query<{ c: string }>(`SELECT public.my_invite_code() AS c`)).rows);
    const r1 = await como(db, U.luis, async () => (await db.query<{ inviter_id: string; relation: string }>(`SELECT * FROM public.redeem_invite($1)`, [c])).rows);
    const r2 = await como(db, U.luis, async () => (await db.query(`SELECT * FROM public.redeem_invite($1)`, [c])).rows);
    expect(r1).toEqual([expect.objectContaining({ inviter_id: U.ana, relation: 'none' })]);
    expect(r2.length).toBe(1);
    const { rows } = await db.query(`SELECT kind FROM public.invite_events WHERE inviter_id = $1 AND invitee_id = $2 ORDER BY kind`, [U.ana, U.luis]);
    expect(rows).toEqual([{ kind: 'accepted' }, { kind: 'signed_up' }]);
  });

  it('de otro campus se cuenta pero no se enseña; el propio código no hace nada', async () => {
    const [{ c }] = await como(db, U.ana, async () => (await db.query<{ c: string }>(`SELECT public.my_invite_code() AS c`)).rows);
    expect(await como(db, U.gdl, async () => (await db.query(`SELECT * FROM public.redeem_invite($1)`, [c])).rows)).toEqual([]);
    expect(await como(db, U.ana, async () => (await db.query(`SELECT * FROM public.redeem_invite($1)`, [c])).rows)).toEqual([]);
    expect(await como(db, U.luis, async () => (await db.query(`SELECT * FROM public.redeem_invite('NoExiste01')`)).rows)).toEqual([]);
  });

  it('compartir se apunta sin a quién, y con tope diario', async () => {
    for (let i = 0; i < 55; i++) await como(db, U.zoe, () => db.query(`SELECT public.log_invite_share('whatsapp', 3)`));
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.invite_events WHERE inviter_id = $1 AND kind = 'shared'`, [U.zoe]);
    expect(rows[0].n).toBe(50);
    const [stats] = await como(db, U.ana, async () => (await db.query<{ accepted: number }>(`SELECT * FROM public.my_invite_stats()`)).rows);
    expect(Number(stats.accepted)).toBe(2);
  });
});
