// @vitest-environment node
/**
 * Cuentas de auth.users sin fila en public.profiles: el relleno y el cierre
 * del agujero, ejecutados de verdad.
 *
 * PGlite (Postgres en WebAssembly) sobre la réplica de producción, en el
 * orden de producción:
 *   produccion-instituciones.sql -> 20260915 (catálogo) -> produccion-ids.sql
 *   -> produccion-verificacion.sql -> se fabrican las huérfanas
 *   -> 20260920000000 (el arreglo).
 *
 * Lo que fija, por orden de importancia:
 *   1. Borrar la cuenta SIGUE borrando el perfil en cascada. El guardia de
 *      borrado nuevo se apoya en que, cuando la cascada llega a profiles, la
 *      fila de auth.users ya no está en la transacción. Si eso no fuera
 *      cierto, la migración rompería el borrado de cuenta — y con él la
 *      guideline 5.1.1(v) de Apple, que es por lo que existe.
 *   2. El relleno devuelve el perfil Y la comunidad (campus + verificación).
 *   3. El alta sin correo ya no tumba el registro.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const raiz = join(__dirname, '..', '..');
const leer = (...p: string[]) => readFileSync(join(...p), 'utf8');
const SQL = {
  instituciones: leer(__dirname, 'sql', 'produccion-instituciones.sql'),
  catalogo: leer(raiz, 'supabase', 'migrations', '20260915000000_catalogo-universidades.sql'),
  ids: leer(__dirname, 'sql', 'produccion-ids.sql'),
  verificacionFixture: leer(__dirname, 'sql', 'produccion-verificacion.sql'),
  verificacion: leer(raiz, 'supabase', 'migrations', '20260917000000_verificacion-institucional.sql'),
  datos: leer(raiz, 'supabase', 'migrations', '20260917010000_catalogo-instituciones-datos.sql'),
  arreglo: leer(raiz, 'supabase', 'migrations', '20260920000000_perfiles-huerfanos.sql'),
};

const QRO = '1a898a3a-53c0-4468-8dc6-b03bef169a6e';

let db: PGlite;
let n = 0;

const nuevoId = () => {
  n += 1;
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
};

/** Una cuenta como la crearía Supabase Auth: el disparador crea el perfil. */
async function cuenta(email: string | null, { confirmada = true, proveedor = 'email' } = {}): Promise<string> {
  const id = nuevoId();
  await db.query(
    'INSERT INTO auth.users (id, email, email_confirmed_at, raw_app_meta_data) VALUES ($1, $2, $3, $4)',
    [id, email, confirmada ? new Date().toISOString() : null, JSON.stringify({ provider: proveedor })],
  );
  return id;
}

/**
 * Una cuenta huérfana, por el único camino que de verdad las produce: una
 * sesión en session_replication_role = 'replica', que es como se restaura un
 * backup, como hace PITR Supabase y como importa datos el panel. Ahí el
 * disparador NO corre, y nadie se entera.
 */
async function cuentaHuerfana(email: string | null, { confirmada = true, proveedor = 'email' } = {}): Promise<string> {
  const id = nuevoId();
  await db.exec(`SET session_replication_role = 'replica'`);
  try {
    await db.query(
      'INSERT INTO auth.users (id, email, email_confirmed_at, raw_app_meta_data) VALUES ($1, $2, $3, $4)',
      [id, email, confirmada ? new Date().toISOString() : null, JSON.stringify({ provider: proveedor })],
    );
  } finally {
    await db.exec(`SET session_replication_role = 'origin'`);
  }
  return id;
}

const perfil = async (uid: string) =>
  (await db.query<{ email: string; campus_id: string | null; institution_verified: boolean; student_id: string | null }>(
    'SELECT email, campus_id, institution_verified, student_id FROM public.profiles WHERE id = $1', [uid],
  )).rows[0];

const mismaInstitucion = async (a: string, b: string) =>
  (await db.query<{ r: boolean }>('SELECT public.same_institution($1, $2) r', [a, b])).rows[0].r;

const cuenta_ = async (sql: string, params: unknown[] = []) =>
  (await db.query<{ n: number }>(sql, params)).rows[0].n;

/** Ejecuta y devuelve el mensaje de error, o null si pasó. */
async function fallo(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

// Huérfanas fabricadas antes del arreglo.
let huerfanoUnico: string;      // dominio de un solo campus (purdue.edu)
let huerfanoTec: string;        // dominio de varios campus (tec.mx)
let huerfanoGenerico: string;   // correo de gmail
let huerfanoSinCorreo: string;  // alta social sin claim de email
let huerfanoBorrado: string;    // cuenta borrada en blando
let sanoTec: string;            // cuenta normal en Tec Querétaro
let sanoPurdue: string;         // cuenta normal en Purdue
const PURDUE = '3869753e-03d4-4ad9-ae96-2b7605117f4b';

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm, unaccent, pgcrypto } });
  await db.exec(SQL.instituciones);
  await db.exec(SQL.catalogo);
  await db.exec(SQL.ids);
  await db.exec(SQL.verificacionFixture);

  // Producción tiene estas dos columnas; la réplica mínima no las traía y el
  // relleno consulta deleted_at para no resucitar cuentas borradas.
  await db.exec(`ALTER TABLE auth.users
    ADD COLUMN IF NOT EXISTS deleted_at   timestamptz,
    ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT false`);

  // Una persona sana en Tec Querétaro, para comparar contra ella.
  sanoTec = await cuenta('a01714719@tec.mx');
  await db.query('UPDATE public.profiles SET campus_id = $1, onboarding_completed = true WHERE id = $2', [QRO, sanoTec]);

  await db.exec(SQL.verificacion);
  await db.exec(SQL.datos);

  // Una persona sana en Purdue: ahí el dominio resuelve un solo campus, así
  // que el alta la adscribe y la verifica sola.
  sanoPurdue = await cuenta('otro@purdue.edu', { proveedor: 'google' });

  // Y ahora las huérfanas, ya con el esquema de verificación puesto.
  huerfanoUnico = await cuentaHuerfana('boiler@purdue.edu', { proveedor: 'google' });
  huerfanoTec = await cuentaHuerfana('a01999888@tec.mx', { proveedor: 'apple' });
  huerfanoGenerico = await cuentaHuerfana('persona@gmail.com', { proveedor: 'google' });
  huerfanoSinCorreo = await cuentaHuerfana(null, { confirmada: false, proveedor: 'apple' });
  huerfanoBorrado = await cuentaHuerfana('baja@tec.mx');
  await db.query('UPDATE auth.users SET deleted_at = now() WHERE id = $1', [huerfanoBorrado]);
}, 120_000);

describe('antes del arreglo', () => {
  it('la cuenta existe, el perfil no, y nada ha fallado por el camino', async () => {
    expect(await cuenta_('SELECT count(*)::int n FROM auth.users WHERE id = $1', [huerfanoUnico])).toBe(1);
    expect(await perfil(huerfanoUnico)).toBeUndefined();
  });

  it('sin perfil, same_institution dice que no a su propio campus', async () => {
    // Esto es lo que rompe la app: la RLS de events, public_profiles y el chat
    // se apoyan en esta función, y con ella en false la persona no ve nada de
    // su comunidad. Sin error, sin log, sin nada.
    expect(await mismaInstitucion(huerfanoUnico, sanoPurdue)).toBe(false);
    expect(await mismaInstitucion(sanoPurdue, huerfanoUnico)).toBe(false);
  });

  it('una afiliación queda VERIFICADA sin perfil detrás, y nadie se entera', async () => {
    // sync_profile_verified() hace UPDATE profiles WHERE id = NEW.user_id:
    // sin perfil es un no-op sin error. Es el segundo agujero silencioso, y
    // además el que hace que rellenar no baste: a partir de aquí
    // apply_auth_email_affiliation() corta en 'already_verified' y ya no
    // asigna campus a nadie.
    await db.query('SELECT public.apply_auth_email_affiliation($1)', [huerfanoUnico]);
    const afiliacion = (await db.query<{ status: string; campus_id: string | null }>(
      'SELECT status, campus_id FROM public.profile_affiliations WHERE user_id = $1', [huerfanoUnico])).rows[0];
    expect(afiliacion).toMatchObject({ status: 'verified', campus_id: PURDUE });
    expect(await perfil(huerfanoUnico)).toBeUndefined();
  });
});

describe('el arreglo', () => {
  beforeAll(async () => {
    await db.exec(SQL.arreglo);
  }, 120_000);

  it('rellena el perfil que faltaba', async () => {
    expect((await perfil(huerfanoUnico))?.email).toBe('boiler@purdue.edu');
    expect((await perfil(huerfanoTec))?.email).toBe('a01999888@tec.mx');
    expect((await perfil(huerfanoGenerico))?.email).toBe('persona@gmail.com');
  });

  it('le devuelve su campus y su verificación, no solo la fila', async () => {
    // Lo que de verdad arregla la avuería. El perfil vacío no basta: sin
    // campus_id, same_institution seguiría diciendo que no y la app se vería
    // igual de rota. Y como su afiliación ya estaba en 'verified',
    // apply_auth_email_affiliation() no habría asignado nada: el campus sale
    // de copiar lo que la afiliación ya sabía.
    const p = await perfil(huerfanoUnico);
    expect(p?.campus_id).toBe(PURDUE);
    expect(p?.institution_verified).toBe(true);
    // La matricula es la que dejaria un alta normal, ni mas ni menos: desde
    // 20260917 solo sale si el dominio tiene student_id_pattern, y purdue.edu
    // no lo tiene. Se compara contra la funcion para que la prueba siga
    // valiendo si el catalogo cambia.
    expect(p?.student_id).toBe(
      (await db.query<{ v: string | null }>(
        `SELECT public.student_id_for_email('boiler@purdue.edu') v`)).rows[0].v);
    expect(await mismaInstitucion(huerfanoUnico, sanoPurdue)).toBe(true);
    expect(await mismaInstitucion(sanoPurdue, huerfanoUnico)).toBe(true);
  });

  it('al de dominio con varios campus le pide elegir, como a cualquier alta', async () => {
    // tec.mx da cuatro campus: desde 20260917 nadie queda adscrito por el
    // dominio solo. Se le rellena el perfil y se le deja donde le toca, en el
    // selector de campus. No se le inventa una comunidad.
    const p = await perfil(huerfanoTec);
    expect(p).toBeDefined();
    expect(p?.campus_id).toBeNull();
    const afiliacion = (await db.query<{ status: string; status_reason: string | null }>(
      'SELECT status, status_reason FROM public.profile_affiliations WHERE user_id = $1', [huerfanoTec])).rows[0];
    expect(afiliacion).toMatchObject({ status: 'unverified', status_reason: 'choose_campus' });
    expect(await mismaInstitucion(huerfanoTec, sanoTec)).toBe(false);
  });

  it('al de correo genérico le da perfil, pero ni campus ni verificación', async () => {
    const p = await perfil(huerfanoGenerico);
    expect(p).toBeDefined();
    expect(p?.campus_id).toBeNull();
    expect(p?.institution_verified).toBe(false);
  });

  it('a la cuenta sin correo le pone el perfil con email vacío', async () => {
    expect((await perfil(huerfanoSinCorreo))?.email).toBe('');
  });

  it('no resucita el perfil de una cuenta borrada en blando', async () => {
    expect(await perfil(huerfanoBorrado)).toBeUndefined();
  });

  it('no deja ninguna cuenta viva sin perfil', async () => {
    const sueltas = await cuenta_(`
      SELECT count(*)::int n FROM auth.users u
      WHERE u.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)`);
    expect(sueltas).toBe(0);
  });

  it('pasarlo dos veces no cambia nada', async () => {
    const antes = await cuenta_('SELECT count(*)::int n FROM public.profiles');
    await db.exec(SQL.arreglo);
    expect(await cuenta_('SELECT count(*)::int n FROM public.profiles')).toBe(antes);
    expect(await cuenta_('SELECT public.backfill_missing_profiles() n')).toBe(0);
  });
});

describe('el alta endurecida', () => {
  beforeAll(async () => {
    await db.exec(SQL.arreglo);
  }, 120_000);

  it('un alta normal sigue creando el perfil', async () => {
    const uid = await cuenta('a01777666@tec.mx');
    expect((await perfil(uid))?.email).toBe('a01777666@tec.mx');
  });

  it('un alta sin correo ya no tumba el registro', async () => {
    // Antes chocaba contra profiles.email NOT NULL y se llevaba por delante
    // la transacción entera: GoTrue devolvía "Database error saving new user"
    // y la persona no podía entrar. Pasa con las altas anónimas, por teléfono
    // y con un idToken de Apple sin claim de email.
    const uid = await cuenta(null, { confirmada: false, proveedor: 'apple' });
    expect((await perfil(uid))?.email).toBe('');
  });

  it('reactiva el disparador si alguien lo había apagado', async () => {
    await db.exec('ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created');
    await db.exec(SQL.arreglo);
    const estado = (await db.query<{ tgenabled: string }>(
      `SELECT tgenabled FROM pg_trigger
       WHERE tgname = 'on_auth_user_created' AND tgrelid = 'auth.users'::regclass`)).rows[0];
    expect(estado.tgenabled).toBe('O');
    const uid = await cuenta('a01555444@tec.mx');
    expect(await perfil(uid)).toBeDefined();
  });
});

describe('el guardia de borrado', () => {
  beforeAll(async () => {
    await db.exec(SQL.arreglo);
  }, 120_000);

  it('no deja borrar el perfil mientras la cuenta siga viva', async () => {
    const uid = await cuenta('a01333222@tec.mx');
    const error = await fallo('DELETE FROM public.profiles WHERE id = $1', [uid]);
    expect(error).toMatch(/no se puede borrar el perfil/);
    expect(await perfil(uid)).toBeDefined();
  });

  it('borrar la CUENTA sigue borrando el perfil en cascada', async () => {
    // La prueba que de verdad importa. El guardia se apoya en que, cuando la
    // cascada de auth.users llega a profiles, la fila de auth.users ya no está
    // en la transacción. Si eso dejara de ser cierto, la Edge Function
    // delete-account fallaría y Apple rechazaría la app por la 5.1.1(v).
    const uid = await cuenta('a01111000@tec.mx');
    expect(await perfil(uid)).toBeDefined();

    expect(await fallo('DELETE FROM auth.users WHERE id = $1', [uid])).toBeNull();

    expect(await cuenta_('SELECT count(*)::int n FROM auth.users WHERE id = $1', [uid])).toBe(0);
    expect(await perfil(uid)).toBeUndefined();
  });

  it('borrar la cuenta se lleva también el resto de la cascada', async () => {
    // Lo demás que cuelga de auth.users: si el guardia hubiera cortado la
    // cascada, esto se quedaría a medias. La réplica mínima solo trae
    // events; en producción cuelgan igual event_participants, messages,
    // friendships, group_members, badges, point_events y blocks.
    const uid = await cuenta('a01000999@tec.mx');
    await db.query('UPDATE public.profiles SET campus_id = $1 WHERE id = $2', [QRO, uid]);
    const evento = (await db.query<{ id: string }>(
      `INSERT INTO public.events (creator_id, title) VALUES ($1, 'Evento de prueba') RETURNING id`, [uid])).rows[0].id;

    expect(await fallo('DELETE FROM auth.users WHERE id = $1', [uid])).toBeNull();

    expect(await cuenta_('SELECT count(*)::int n FROM public.events WHERE id = $1', [evento])).toBe(0);
  });
});
