// @vitest-environment node
/**
 * La bandeja: paginar sin perder avisos y archivar (20261003000000), contra
 * el esquema REAL.
 *
 * Lo que se fija: una página que termina en medio de varios avisos con la
 * misma fecha no se come el resto, la app ya publicada sigue pudiendo
 * llamar a my_notifications como siempre, archivar saca el aviso de la
 * bandeja sin tragarse los siguientes de esa conversación, y deshacer lo
 * devuelve como estaba.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { baseAlDia, como, falla, crearPersona, prepararPush, CAMPUS } from './fullSchema';

const U = {
  ana: 'f1000000-0000-0000-0000-000000000001',
  luis: 'f1000000-0000-0000-0000-000000000002',
  eva: 'f1000000-0000-0000-0000-000000000003',
};

let db: PGlite;

type Fila = { id: string; read_at: string | null; archived_at: string | null; count: number };
type Pagina = { id: string; updated_at: string; read_at: string | null };

const rpc = <T = Record<string, unknown>>(uid: string, sql: string, params: unknown[] = []) =>
  como(db, uid, async () => (await db.query<T>(sql, params)).rows);

const fila = async (id: string) =>
  (await db.query<Fila>(`SELECT id, read_at, archived_at, count FROM public.notifications WHERE id = $1`, [id])).rows[0];

const sinLeer = async (uid: string) =>
  Number((await rpc<{ notifications_unread: number }>(uid, `SELECT notifications_unread FROM public.notification_counts()`))[0].notifications_unread);

/** Un aviso puesto a mano, como lo dejaría notify(). */
async function aviso(uid: string, n: number, extra: { at?: string; group?: string; read?: boolean } = {}): Promise<string> {
  const id = `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const at = extra.at ?? '2026-10-01T10:00:00Z';
  await db.query(
    `INSERT INTO public.notifications (id, user_id, type, category, created_at, updated_at, group_key, read_at)
     VALUES ($1, $2, 'digest', 'digests', $3, $3, $4, $5)`,
    [id, uid, at, extra.group ?? null, extra.read ? at : null],
  );
  return id;
}

const pedirAmistad = (de: string, a: string) =>
  falla(db, de, `INSERT INTO public.friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'pending')`, [de, a]);

beforeAll(async () => {
  db = await baseAlDia();
  await crearPersona(db, U.ana, 'Ana', CAMPUS.qro);
  await crearPersona(db, U.luis, 'Luis', CAMPUS.qro);
  await crearPersona(db, U.eva, 'Eva', CAMPUS.qro);
  await prepararPush(db, U.ana, U.luis, U.eva);
  await db.exec(`UPDATE public.notification_preferences SET timezone = 'UTC'`);
}, 120_000);

beforeEach(async () => {
  await db.exec(`DELETE FROM public.notifications; DELETE FROM public.friendships; DELETE FROM net._test_requests;`);
});

describe('paginar con avisos de la misma fecha', () => {
  it('antes: con el cursor de solo fecha, el empate se perdía', async () => {
    for (let i = 1; i <= 7; i++) await aviso(U.ana, i);
    const p1 = await rpc<Pagina>(U.ana, `SELECT id, updated_at FROM public.my_notifications(_limit := 3)`);
    expect(p1).toHaveLength(3);
    // Lo que manda la app publicada: la fecha del último, sin id.
    const p2 = await rpc<Pagina>(U.ana, `SELECT id FROM public.my_notifications(_before := $1, _limit := 3)`, [p1[2].updated_at]);
    expect(p2).toEqual([]);
  });

  it('con el cursor compuesto salen los siete, sin repetir y en orden', async () => {
    for (let i = 1; i <= 7; i++) await aviso(U.ana, i);
    const vistos: string[] = [];
    let cursor: Pagina | null = null;
    for (let vuelta = 0; vuelta < 5; vuelta++) {
      const pagina: Pagina[] = cursor
        ? await rpc<Pagina>(U.ana, `SELECT id, updated_at FROM public.my_notifications(_before := $1, _limit := 3, _before_id := $2)`, [cursor.updated_at, cursor.id])
        : await rpc<Pagina>(U.ana, `SELECT id, updated_at FROM public.my_notifications(_limit := 3)`);
      vistos.push(...pagina.map((r) => r.id));
      if (pagina.length < 3) break;
      cursor = pagina[pagina.length - 1];
    }
    expect(vistos).toHaveLength(7);
    expect(new Set(vistos).size).toBe(7);
    expect(vistos).toEqual([...vistos].sort().reverse());
  });

  it('mezclando fechas distintas y empates tampoco se pierde ni repite nada', async () => {
    await aviso(U.ana, 1, { at: '2026-10-01T09:00:00Z' });
    for (let i = 2; i <= 5; i++) await aviso(U.ana, i, { at: '2026-10-01T10:00:00Z' });
    await aviso(U.ana, 6, { at: '2026-10-01T11:00:00Z' });
    const vistos: string[] = [];
    let cursor: Pagina | null = null;
    for (let vuelta = 0; vuelta < 6; vuelta++) {
      const pagina: Pagina[] = cursor
        ? await rpc<Pagina>(U.ana, `SELECT id, updated_at FROM public.my_notifications(_before := $1, _limit := 2, _before_id := $2)`, [cursor.updated_at, cursor.id])
        : await rpc<Pagina>(U.ana, `SELECT id, updated_at FROM public.my_notifications(_limit := 2)`);
      vistos.push(...pagina.map((r) => r.id));
      if (pagina.length < 2) break;
      cursor = pagina[pagina.length - 1];
    }
    expect(vistos.map((id) => Number(id.slice(-2)))).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it('la app publicada sigue pudiendo llamarla, y no quedan dos funciones', async () => {
    await aviso(U.ana, 1);
    expect(await rpc(U.ana, `SELECT id FROM public.my_notifications()`)).toHaveLength(1);
    expect(await rpc(U.ana, `SELECT id FROM public.my_notifications(_before := now(), _limit := 30)`)).toHaveLength(1);
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'my_notifications'`,
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('archivar', () => {
  it('saca el aviso de la bandeja, lo deja leído y cancela su push', async () => {
    await pedirAmistad(U.ana, U.luis);
    const [n] = await rpc<Pagina>(U.luis, `SELECT id FROM public.my_notifications()`);
    expect(await sinLeer(U.luis)).toBe(1);

    const [r] = await rpc<{ n: number }>(U.luis, `SELECT public.archive_notifications($1) AS n`, [[n.id]]);
    expect(r.n).toBe(1);
    expect(await rpc(U.luis, `SELECT id FROM public.my_notifications()`)).toEqual([]);
    expect(await sinLeer(U.luis)).toBe(0);
    const f = await fila(n.id);
    expect(f.archived_at).not.toBeNull();
    expect(f.read_at).not.toBeNull();
    const { rows } = await db.query<{ status: string }>(`SELECT status FROM public.notification_deliveries WHERE notification_id = $1`, [n.id]);
    expect(rows.every((d) => d.status === 'cancelled')).toBe(true);
  });

  it('archivar dos veces no hace nada la segunda', async () => {
    const id = await aviso(U.ana, 1);
    expect((await rpc<{ n: number }>(U.ana, `SELECT public.archive_notifications($1) AS n`, [[id]]))[0].n).toBe(1);
    expect((await rpc<{ n: number }>(U.ana, `SELECT public.archive_notifications($1) AS n`, [[id]]))[0].n).toBe(0);
  });

  it('nadie archiva ni restaura avisos ajenos, y sin sesión no se puede', async () => {
    const id = await aviso(U.ana, 1);
    expect((await rpc<{ n: number }>(U.eva, `SELECT public.archive_notifications($1) AS n`, [[id]]))[0].n).toBe(0);
    expect((await fila(id)).archived_at).toBeNull();

    await rpc(U.ana, `SELECT public.archive_notifications($1)`, [[id]]);
    expect((await rpc<{ n: number }>(U.eva, `SELECT public.unarchive_notifications($1) AS n`, [[id]]))[0].n).toBe(0);
    expect((await fila(id)).archived_at).not.toBeNull();

    await db.exec(`SET ROLE anon`);
    try {
      await expect(db.query(`SELECT public.archive_notifications($1)`, [[id]])).rejects.toThrow(/permission denied/);
      await expect(db.query(`SELECT public.unarchive_notifications($1)`, [[id]])).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec(`RESET ROLE`);
    }
  });

  it('la tabla sigue sin poder tocarse a mano', async () => {
    const id = await aviso(U.ana, 1);
    expect(await falla(db, U.ana, `UPDATE public.notifications SET archived_at = now() WHERE id = $1`, [id])).toMatch(/permission denied/);
  });

  it('un aviso archivado no se traga los siguientes de su conversación', async () => {
    const viejo = await aviso(U.ana, 1, { group: 'chat:prueba' });
    await rpc(U.ana, `SELECT public.archive_notifications($1)`, [[viejo]]);
    // Lo que hace notify() cuando llega otro de la misma conversación: suma
    // al que esté abierto o crea uno. Con el archivado ya leído, crea uno.
    await db.query(
      `INSERT INTO public.notifications (user_id, type, category, group_key) VALUES ($1, 'digest', 'digests', 'chat:prueba')
       ON CONFLICT (user_id, group_key) WHERE group_key IS NOT NULL AND read_at IS NULL
       DO UPDATE SET count = public.notifications.count + 1`,
      [U.ana],
    );
    expect((await fila(viejo)).count).toBe(1);
    const bandeja = await rpc<Pagina>(U.ana, `SELECT id FROM public.my_notifications()`);
    expect(bandeja).toHaveLength(1);
    expect(bandeja[0].id).not.toBe(viejo);
  });
});

describe('deshacer', () => {
  it('lo que estaba sin leer vuelve sin leer', async () => {
    const id = await aviso(U.ana, 1);
    await rpc(U.ana, `SELECT public.archive_notifications($1)`, [[id]]);
    expect(await sinLeer(U.ana)).toBe(0);
    expect((await rpc<{ n: number }>(U.ana, `SELECT public.unarchive_notifications($1) AS n`, [[id]]))[0].n).toBe(1);
    const [n] = await rpc<Pagina>(U.ana, `SELECT id, read_at FROM public.my_notifications()`);
    expect(n).toMatchObject({ id, read_at: null });
    expect(await sinLeer(U.ana)).toBe(1);
  });

  it('lo que ya estaba leído vuelve leído', async () => {
    const id = await aviso(U.ana, 1, { read: true });
    await rpc(U.ana, `SELECT public.archive_notifications($1)`, [[id]]);
    await rpc(U.ana, `SELECT public.unarchive_notifications($1)`, [[id]]);
    const [n] = await rpc<Pagina>(U.ana, `SELECT id, read_at FROM public.my_notifications()`);
    expect(n.id).toBe(id);
    expect(n.read_at).not.toBeNull();
    expect(await sinLeer(U.ana)).toBe(0);
  });

  it('si mientras tanto llegó otro de la misma conversación, vuelve leído', async () => {
    const viejo = await aviso(U.ana, 1, { group: 'chat:prueba' });
    await rpc(U.ana, `SELECT public.archive_notifications($1)`, [[viejo]]);
    const nuevo = await aviso(U.ana, 2, { group: 'chat:prueba', at: '2026-10-01T12:00:00Z' });
    await rpc(U.ana, `SELECT public.unarchive_notifications($1)`, [[viejo]]);
    expect((await fila(viejo)).read_at).not.toBeNull();
    expect((await fila(viejo)).archived_at).toBeNull();
    expect((await fila(nuevo)).read_at).toBeNull();
    expect(await sinLeer(U.ana)).toBe(1);
  });

  it('dos de la misma conversación a la vez: vuelven los dos, leídos, sin error', async () => {
    const uno = await aviso(U.ana, 1, { group: 'chat:prueba' });
    await rpc(U.ana, `SELECT public.archive_notifications($1)`, [[uno]]);
    const dos = await aviso(U.ana, 2, { group: 'chat:prueba', at: '2026-10-01T12:00:00Z' });
    await rpc(U.ana, `SELECT public.archive_notifications($1)`, [[dos]]);

    expect((await rpc<{ n: number }>(U.ana, `SELECT public.unarchive_notifications($1) AS n`, [[uno, dos]]))[0].n).toBe(2);
    expect(await rpc(U.ana, `SELECT id FROM public.my_notifications()`)).toHaveLength(2);
    expect((await fila(uno)).read_at).not.toBeNull();
    expect((await fila(dos)).read_at).not.toBeNull();
  });
});
