// @vitest-environment node
/**
 * La migración de búsqueda de personas, ejecutada de verdad.
 *
 * PGlite (Postgres en WebAssembly) sobre la réplica de producción: lo que
 * aquí se prueba es lo que la interfaz no puede garantizar — a quién se
 * encuentra, qué estado de relación sale y qué amistades se pueden crear.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';

const raiz = join(__dirname, '..', '..');
const leer = (...p: string[]) => readFileSync(join(...p), 'utf8');
const INSTITUCIONES = leer(__dirname, 'sql', 'produccion-instituciones.sql');
const CATALOGO = leer(raiz, 'supabase', 'migrations', '20260915000000_catalogo-universidades.sql');
const AMISTADES = leer(__dirname, 'sql', 'produccion-amistades.sql');
const MIGRACION = leer(raiz, 'supabase', 'migrations', '20260916000000_buscar-personas.sql');

const QRO_ID = '11111111-1111-1111-1111-111111111111';

let db: PGlite;
let n = 0;

type Resultado = { id: string; name: string; relation: string; friendship_id: string | null; mutual_friends: number };
type Sugerencia = { id: string; name: string; mutual_friends: number; shared_groups: number };

/** Una cuenta con nombre y campus, como queda tras el alta. */
async function persona(name: string, campus: string | null = QRO_ID): Promise<string> {
  n += 1;
  const id = `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `p${n}@gmail.com`]);
  await db.query(
    'UPDATE public.profiles SET name = $1, campus_id = $2, onboarding_completed = $3, created_at = now() + ($4 || \' seconds\')::interval WHERE id = $5',
    [name, campus, campus !== null, n, id],
  );
  return id;
}

/** Ejecuta como la app (rol authenticated) con la sesión de `uid`. */
async function comoApp<T = Record<string, unknown>>(uid: string, sql: string, params: unknown[] = []) {
  await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub', '${uid}', false); SET ROLE authenticated;`);
  try {
    const r = await db.query<T>(sql, params);
    return { rows: r.rows, error: null as string | null };
  } catch (e) {
    return { rows: [] as T[], error: (e as Error).message };
  } finally {
    await db.exec('RESET ROLE');
  }
}

const buscar = (uid: string, q: string, limit = 20, offset = 0) =>
  comoApp<Resultado>(uid, 'SELECT * FROM public.search_people($1, $2, $3)', [q, limit, offset]);

const pedir = (de: string, a: string, status = 'pending') =>
  comoApp<{ id: string }>(de, 'INSERT INTO public.friendships (requester_id, addressee_id, status) VALUES ($1, $2, $3) RETURNING id', [de, a, status]);

/** Amistad ya aceptada, por el camino de la app: pide uno, acepta el otro. */
async function amigos(a: string, b: string) {
  const { rows, error } = await pedir(a, b);
  if (error) throw new Error(error);
  const r = await comoApp(b, `UPDATE public.friendships SET status = 'accepted' WHERE id = $1 RETURNING id`, [rows[0].id]);
  if (r.error || r.rows.length !== 1) throw new Error(r.error ?? 'no aceptada');
}

let yo: string;
let ana: string;
let anaMaria: string;
let jose: string;
let lopez: string;
let bloqueada: string;
let meBloqueo: string;
let deGdl: string;
let sinNombre: string;

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm, unaccent } });
  await db.exec(INSTITUCIONES);
  await db.exec(CATALOGO);
  await db.exec(AMISTADES);

  yo = await persona('Sebastián Villegas');
  ana = await persona('Ana López');
  anaMaria = await persona('María Ana Pérez');
  jose = await persona('José Ángel Núñez');
  lopez = await persona('Carlos Lopez');
  bloqueada = await persona('Ana Bloqueada');
  meBloqueo = await persona('Ana Que Me Bloqueó');
  const gdl = (await db.query<{ id: string }>(`SELECT id FROM public.institutions WHERE slug = 'tec-guadalajara'`)).rows[0].id;
  deGdl = await persona('Ana de Guadalajara', gdl);
  sinNombre = await persona('   ');

  await db.query('INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ($1, $2), ($3, $4)', [yo, bloqueada, meBloqueo, yo]);

  await db.exec(MIGRACION);
}, 60_000);

describe('migración', () => {
  it('se puede aplicar dos veces', async () => {
    await db.exec(MIGRACION);
    const { rows } = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM pg_trigger WHERE tgname = 'trg_guard_friendship_write'`,
    );
    expect(rows[0].c).toBe(1);
  });
});

describe('search_people', () => {
  it('encuentra por nombre, por apellido y por nombre completo', async () => {
    expect((await buscar(yo, 'ana')).rows.map((r) => r.id)).toEqual([ana, anaMaria]);
    expect((await buscar(yo, 'lopez')).rows.map((r) => r.id).sort()).toEqual([ana, lopez].sort());
    expect((await buscar(yo, 'ana lopez')).rows.map((r) => r.id)).toEqual([ana]);
    expect((await buscar(yo, 'lópez ana')).rows.map((r) => r.id)).toEqual([ana]);
  });

  it('no distingue mayúsculas, acentos ni espacios de más', async () => {
    const ids = async (q: string) => (await buscar(yo, q)).rows.map((r) => r.id);
    expect(await ids('JOSE')).toEqual([jose]);
    expect(await ids('  nuñez  ')).toEqual([jose]);
    expect(await ids('angel nunez')).toEqual([jose]);
    expect(await ids('ÁNGEL')).toEqual([jose]);
  });

  it('con una letra busca al principio de cada palabra, no en medio', async () => {
    const ids = (await buscar(yo, 'a')).rows.map((r) => r.id);
    // "Ana López", "María Ana Pérez", "José Ángel Núñez"; no "Carlos" por su "a".
    expect(ids.sort()).toEqual([ana, anaMaria, jose].sort());
  });

  it('desde tres letras también encuentra en medio de la palabra', async () => {
    expect((await buscar(yo, 'illeg')).rows).toHaveLength(0); // soy yo
    expect((await buscar(yo, 'arlo')).rows.map((r) => r.id)).toEqual([lopez]);
  });

  it('ordena primero lo que empieza igual', async () => {
    const { rows } = await buscar(yo, 'ana');
    expect(rows[0].id).toBe(ana); // empieza por "ana" antes que "María Ana"
  });

  it('no me devuelve a mí, ni a bloqueados en ningún sentido, ni a otros campus, ni perfiles sin nombre', async () => {
    const todos = (await buscar(yo, 'a', 50)).rows.map((r) => r.id);
    expect(todos).not.toContain(yo);
    expect(todos).not.toContain(bloqueada);
    expect(todos).not.toContain(meBloqueo);
    expect(todos).not.toContain(deGdl);
    expect(todos).not.toContain(sinNombre);
    expect((await buscar(yo, 'villegas')).rows).toHaveLength(0);
  });

  it('está limitada y paginada', async () => {
    const pagina1 = (await buscar(yo, 'a', 2, 0)).rows.map((r) => r.id);
    const pagina2 = (await buscar(yo, 'a', 2, 2)).rows.map((r) => r.id);
    expect(pagina1).toHaveLength(2);
    expect(pagina2).toHaveLength(1);
    expect(new Set([...pagina1, ...pagina2]).size).toBe(3);
    const { rows, error } = await buscar(yo, 'a', 100000);
    expect(error).toBeNull();
    expect(rows.length).toBeLessThanOrEqual(50);
  });

  it('vacía o solo espacios no devuelve nada', async () => {
    expect((await buscar(yo, '')).rows).toHaveLength(0);
    expect((await buscar(yo, '    ')).rows).toHaveLength(0);
  });

  it('los comodines se buscan como texto, no como patrón', async () => {
    expect((await buscar(yo, '%%%')).rows).toHaveLength(0);
    expect((await buscar(yo, '___')).rows).toHaveLength(0);
  });

  it('sin sesión no responde, y sin campus no encuentra a nadie', async () => {
    await db.exec(`SELECT set_config('request.jwt.claim.sub', '', false); SET ROLE authenticated;`);
    await expect(db.query(`SELECT * FROM public.search_people('ana')`)).rejects.toThrow(/NOT_AUTHENTICATED/);
    await db.exec('RESET ROLE');
    const nueva = await persona('Nueva Sin Campus', null);
    expect((await buscar(nueva, 'ana')).rows).toHaveLength(0);
  });
});

describe('estado de la relación y amistades', () => {
  let a: string, b: string, c: string, d: string;

  beforeAll(async () => {
    a = await persona('Relación Uno');
    b = await persona('Relación Dos');
    c = await persona('Relación Tres');
    d = await persona('Relación Cuatro');
  });

  const estado = async (de: string, para: string) =>
    (await buscar(de, 'relacion', 50)).rows.find((r) => r.id === para);

  it('pasa por agregar, enviada, aceptar y amigos', async () => {
    expect((await estado(a, b))?.relation).toBe('none');

    const { rows, error } = await pedir(a, b);
    expect(error).toBeNull();
    expect((await estado(a, b))?.relation).toBe('outgoing');
    expect(await estado(b, a)).toMatchObject({ relation: 'incoming', friendship_id: rows[0].id });

    await comoApp(b, `UPDATE public.friendships SET status = 'accepted' WHERE id = $1`, [rows[0].id]);
    expect(await estado(a, b)).toMatchObject({ relation: 'friends', friendship_id: null });
    expect((await estado(b, a))?.relation).toBe('friends');
  });

  it('no deja pedir dos veces, ni en sentido contrario, ni a un amigo', async () => {
    const primera = await pedir(c, d);
    expect(primera.error).toBeNull();
    expect((await pedir(c, d)).error).toMatch(/FRIEND_REQUEST_EXISTS|duplicate key/);
    expect((await pedir(d, c)).error).toMatch(/FRIEND_REQUEST_INCOMING/);
    expect((await pedir(a, b)).error).toMatch(/ALREADY_FRIENDS/);
    expect((await pedir(b, a)).error).toMatch(/ALREADY_FRIENDS/);
    const { rows } = await db.query<{ c: number }>(
      'SELECT count(*)::int AS c FROM public.friendships WHERE $1 IN (requester_id, addressee_id) AND $2 IN (requester_id, addressee_id)',
      [c, d],
    );
    expect(rows[0].c).toBe(1);
  });

  it('una solicitud repetida sigue dando 23505, que la app publicada ya entiende', async () => {
    await db.exec(`SELECT set_config('request.jwt.claim.sub', '${c}', false); SET ROLE authenticated;`);
    try {
      await db.query('INSERT INTO public.friendships (requester_id, addressee_id) VALUES ($1, $2)', [c, d]);
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe('23505');
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  it('el par duplicado también lo impide la base, no solo el disparador', async () => {
    // Como service_role (sin sesión), que se salta el disparador.
    await db.exec(`SELECT set_config('request.jwt.claim.sub', '', false)`);
    await expect(
      db.query('INSERT INTO public.friendships (requester_id, addressee_id) VALUES ($1, $2)', [d, c]),
    ).rejects.toThrow(/friendships_pair_key/);
    await expect(
      db.query('INSERT INTO public.friendships (requester_id, addressee_id) VALUES ($1, $1)', [d]),
    ).rejects.toThrow(/friendships_no_self/);
  });

  it('nadie se pide amistad a sí mismo', async () => {
    expect((await pedir(a, a)).error).toMatch(/FRIEND_SELF/);
  });

  it('una solicitud no puede nacer aceptada', async () => {
    const e = await persona('Relación Cinco');
    expect((await pedir(e, a, 'accepted')).error).toMatch(/FRIENDSHIP_FIELD_LOCKED/);
    expect((await estado(e, a))?.relation).toBe('none');
  });

  it('quien recibe solo puede aceptar; no cambiar quién pidió ni volver atrás', async () => {
    const x = await persona('Relación Seis');
    const { rows } = await pedir(x, a);
    const id = rows[0].id;
    expect((await comoApp(a, 'UPDATE public.friendships SET requester_id = $1 WHERE id = $2', [c, id])).error).toMatch(/FRIENDSHIP_FIELD_LOCKED/);
    expect((await comoApp(a, `UPDATE public.friendships SET status = 'blocked' WHERE id = $1`, [id])).error).toMatch(/FRIENDSHIP_FIELD_LOCKED/);
    expect((await comoApp(a, `UPDATE public.friendships SET status = 'accepted' WHERE id = $1`, [id])).error).toBeNull();
    expect((await comoApp(a, `UPDATE public.friendships SET status = 'pending' WHERE id = $1`, [id])).error).toMatch(/FRIENDSHIP_FIELD_LOCKED/);
    // Y quien pidió no puede aceptarse a sí mismo (política de siempre).
    const y = await persona('Relación Siete');
    const r = await pedir(y, a);
    expect((await comoApp(y, `UPDATE public.friendships SET status = 'accepted' WHERE id = $1 RETURNING id`, [r.rows[0].id])).rows).toHaveLength(0);
  });

  it('no se pide amistad a bloqueados ni a otro campus', async () => {
    expect((await pedir(yo, bloqueada)).error).toMatch(/FRIEND_NOT_AVAILABLE|row-level security/);
    expect((await pedir(yo, meBloqueo)).error).toMatch(/FRIEND_NOT_AVAILABLE|row-level security/);
    expect((await pedir(yo, deGdl)).error).toMatch(/FRIEND_NOT_AVAILABLE/);
  });

  it('frena las solicitudes en bucle, aunque se cancelen', async () => {
    const spam = await persona('Relación Spam');
    const victima = await persona('Relación Víctima');
    let ultimo: string | null = null;
    for (let i = 0; i < 31; i++) {
      const r = await pedir(spam, victima);
      ultimo = r.error;
      if (r.error) break;
      await comoApp(spam, 'DELETE FROM public.friendships WHERE id = $1', [r.rows[0].id]);
    }
    expect(ultimo).toMatch(/FRIEND_RATE_LIMIT/);
  });

  it('el registro de intentos no lo puede leer la app', async () => {
    expect((await comoApp(a, 'SELECT * FROM public.friend_request_attempts')).error).toMatch(/permission denied/);
  });

  it('cuenta amigos en común', async () => {
    // a y b son amigos. Si b y c también, a y c tienen a b en común.
    await amigos(b, c);
    expect((await estado(a, c))?.mutual_friends).toBe(1);
  });
});

describe('people_suggestions', () => {
  let s1: string, s2: string, s3: string, s4: string, s5: string;

  beforeAll(async () => {
    s1 = await persona('Sugerida Uno');
    s2 = await persona('Sugerida Dos');
    s3 = await persona('Sugerida Tres');
    s4 = await persona('Sugerida Cuatro');
    s5 = await persona('Sugerida Cinco');
    await amigos(s1, s2);
    await amigos(s2, s3);
    await amigos(s2, s4);
    await amigos(s4, s3);
    const g = (await db.query<{ id: string }>(`INSERT INTO public.groups (name, created_by) VALUES ('Estudio', $1) RETURNING id`, [s1])).rows[0].id;
    const dm = (await db.query<{ id: string }>(`INSERT INTO public.groups (name, created_by) VALUES ($1, $2) RETURNING id`, [`__dm_${s1}_${s5}`, s1])).rows[0].id;
    await db.query('INSERT INTO public.group_members (group_id, user_id) VALUES ($1, $2), ($1, $3), ($4, $2), ($4, $5)', [g, s1, s4, dm, s5]);
    await pedir(s5, s1);
  });

  const sugerencias = (uid: string) =>
    comoApp<Sugerencia>(uid, 'SELECT * FROM public.people_suggestions(20)');

  it('prioriza amigos en común y grupos compartidos, y solo da recuentos', async () => {
    const { rows, error } = await sugerencias(s1);
    expect(error).toBeNull();
    // s4: amigo de s2 (común) y del grupo "Estudio". s3: amigo de s2.
    expect(rows[0]).toMatchObject({ id: s4, mutual_friends: 1, shared_groups: 1 });
    expect(rows[1]).toMatchObject({ id: s3, mutual_friends: 1, shared_groups: 0 });
    expect(Object.keys(rows[0]).sort()).toEqual(['avatar_url', 'id', 'major', 'mutual_friends', 'name', 'shared_groups']);
  });

  it('un DM no cuenta como grupo compartido', async () => {
    const { rows } = await sugerencias(s1);
    expect(rows.every((r) => r.id !== s5 || r.shared_groups === 0)).toBe(true);
  });

  it('deja fuera a amigos, solicitudes en cualquier sentido, bloqueados, otro campus y a mí', async () => {
    const ids = (await sugerencias(s1)).rows.map((r) => r.id);
    expect(ids).not.toContain(s1);
    expect(ids).not.toContain(s2); // amigo
    expect(ids).not.toContain(s5); // me pidió amistad
    expect(ids).not.toContain(deGdl);
    const mias = (await sugerencias(yo)).rows.map((r) => r.id);
    expect(mias).not.toContain(bloqueada);
    expect(mias).not.toContain(meBloqueo);
    expect(mias).not.toContain(sinNombre);
  });

  it('está limitada', async () => {
    const { rows } = await comoApp<Sugerencia>(yo, 'SELECT * FROM public.people_suggestions(1000)');
    expect(rows.length).toBeLessThanOrEqual(20);
  });
});
