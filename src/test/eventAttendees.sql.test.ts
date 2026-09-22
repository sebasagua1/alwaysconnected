// @vitest-environment node
/**
 * event_attendees(): quién va a un evento, para cualquiera que pueda verlo.
 *
 * Corre en PGlite con las definiciones de producción de lo que interviene
 * (events y su política de visibilidad, event_participants, amistades,
 * bloqueos y los helpers). Comprueba lo que la interfaz no puede garantizar:
 * que la función ve exactamente los mismos eventos que la RLS y que no suelta
 * ni solicitudes pendientes, ni bloqueados, ni columnas de más.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIGRACION = readFileSync(
  join(__dirname, '..', '..', 'supabase', 'migrations', '20260918000000_ver-asistentes.sql'),
  'utf8',
);

// Réplica mínima, compartida con despuesDelEvento.sql.test.ts. La política de
// events es la de 20260829 tal cual.
const FIXTURE = readFileSync(join(__dirname, 'sql', 'eventos-sociales.sql'), 'utf8');

const QRO = '11111111-1111-1111-1111-111111111111';
const GDL = '22222222-2222-2222-2222-222222222222';
const U = {
  org: 'a0000000-0000-0000-0000-000000000001', // organiza, Querétaro
  ana: 'a0000000-0000-0000-0000-000000000002', // se unió
  luis: 'a0000000-0000-0000-0000-000000000003', // se unió, bloqueó a mirona
  pend: 'a0000000-0000-0000-0000-000000000004', // solicitud pendiente
  mira: 'a0000000-0000-0000-0000-000000000005', // mira sin unirse, Querétaro
  amiga: 'a0000000-0000-0000-0000-000000000006', // amiga de org
  gdl: 'a0000000-0000-0000-0000-000000000007', // otro campus
  bloq: 'a0000000-0000-0000-0000-000000000008', // bloqueada por org
};

let db: PGlite;
const EV: Record<string, string> = {};

async function como<T = Record<string, unknown>>(uid: string | null, sql: string, params: unknown[] = []) {
  await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub', '${uid ?? ''}', false); SET ROLE ${uid ? 'authenticated' : 'anon'};`);
  try {
    return { rows: (await db.query<T>(sql, params)).rows, error: null as string | null };
  } catch (e) {
    return { rows: [] as T[], error: (e as Error).message };
  } finally {
    await db.exec('RESET ROLE');
  }
}

const asistentes = (uid: string | null, ev: string) =>
  como<{ user_id: string; name: string; avatar_url: string | null; is_creator: boolean }>(
    uid, 'SELECT * FROM public.event_attendees($1)', [ev],
  );

beforeAll(async () => {
  db = new PGlite();
  await db.exec(FIXTURE);
  await db.exec(MIGRACION);
  // Dos veces: la migración es idempotente.
  await db.exec(MIGRACION);

  for (const [k, id] of Object.entries(U)) {
    await db.query('INSERT INTO auth.users (id) VALUES ($1)', [id]);
    await db.query('INSERT INTO public.profiles (id, name, avatar_url, campus_id, student_id) VALUES ($1, $2, $3, $4, $5)', [
      id, k, `https://x/${k}.jpg`, k === 'gdl' ? GDL : QRO, `A0${k}`,
    ]);
  }
  await db.query(`INSERT INTO public.friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'accepted')`, [U.org, U.amiga]);
  await db.query('INSERT INTO public.blocks VALUES ($1, $2), ($3, $4)', [U.org, U.bloq, U.luis, U.mira]);

  for (const privacy of ['open', 'friends', 'private']) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO public.events (creator_id, title, privacy, starts_at, ends_at) VALUES ($1, $2, $3, now() + interval '1 day', now() + interval '1 day 1 hour') RETURNING id`, [U.org, privacy, privacy],
    );
    EV[privacy] = rows[0].id;
    await db.query(
      `INSERT INTO public.event_participants (event_id, user_id, status, joined_at, rating, checked_in) VALUES
        ($1, $2, 'joined', now() - interval '2 hours', 5, true),
        ($1, $3, 'joined', now() - interval '1 hour', 1, false),
        ($1, $4, 'pending', now(), NULL, false)`,
      [EV[privacy], U.ana, U.luis, U.pend],
    );
  }
});

describe('event_attendees', () => {
  it('quien no se ha unido ve a la organizadora primero y luego por orden de llegada', async () => {
    const r = await asistentes(U.mira, EV.open);
    expect(r.error).toBeNull();
    // Luis bloqueó a "mira": no sale, en ningún sentido.
    expect(r.rows.map((x) => x.name)).toEqual(['org', 'ana']);
    expect(r.rows[0].is_creator).toBe(true);
    expect(r.rows[1].is_creator).toBe(false);
    expect(r.rows[1].avatar_url).toBe('https://x/ana.jpg');
  });

  it('sin solicitudes pendientes y sin columnas de más', async () => {
    const r = await asistentes(U.ana, EV.open);
    expect(r.rows.map((x) => x.name)).toEqual(['org', 'ana', 'luis']);
    expect(Object.keys(r.rows[0]).sort()).toEqual(['avatar_url', 'is_creator', 'name', 'user_id']);
  });

  it('el bloqueo se respeta desde los dos lados', async () => {
    const r = await asistentes(U.luis, EV.open);
    expect(r.rows.map((x) => x.name)).not.toContain('mira');
    // Quien está bloqueada por la organizadora no ve el evento: nada.
    expect((await asistentes(U.bloq, EV.open)).rows).toEqual([]);
  });

  it('eventos de amigos: solo para amigos de quien organiza', async () => {
    expect((await asistentes(U.amiga, EV.friends)).rows.map((x) => x.name)).toEqual(['org', 'ana', 'luis']);
    expect((await asistentes(U.mira, EV.friends)).rows).toEqual([]);
  });

  it('eventos privados se ven (hay que pedir entrar), así que su lista también', async () => {
    expect((await asistentes(U.mira, EV.private)).rows.map((x) => x.name)).toEqual(['org', 'ana']);
  });

  it('otro campus, sin sesión o un id inventado: vacío y sin error que confirme nada', async () => {
    expect(await asistentes(U.gdl, EV.open)).toEqual({ rows: [], error: null });
    expect((await asistentes(U.mira, '99999999-9999-9999-9999-999999999999')).rows).toEqual([]);
    const anon = await asistentes(null, EV.open);
    expect(anon.rows).toEqual([]);
    expect(anon.error).toMatch(/permission denied/);
  });

  it('ve exactamente los mismos eventos que la política de RLS, para cada persona', async () => {
    for (const uid of Object.values(U)) {
      const porRls = (await como<{ id: string }>(uid, 'SELECT id FROM public.events ORDER BY id')).rows.map((x) => x.id);
      const porFuncion: string[] = [];
      for (const id of Object.values(EV)) {
        if ((await asistentes(uid, id)).rows.length > 0) porFuncion.push(id);
      }
      expect(porFuncion.sort(), uid).toEqual(porRls);
    }
  });

  it('la tabla sigue cerrada: quien no se unió no puede leer event_participants directamente', async () => {
    const r = await como<{ user_id: string }>(U.mira, 'SELECT user_id, rating FROM public.event_participants WHERE event_id = $1', [EV.open]);
    expect(r.rows).toEqual([]);
  });
});
