// @vitest-environment node
/**
 * Verificación institucional y catálogo ampliado, ejecutados de verdad.
 *
 * PGlite (Postgres en WebAssembly) sobre la réplica de producción con sus ids
 * reales. Se aplican, en el orden de producción:
 *   produccion-instituciones.sql -> 20260915 (catálogo) -> produccion-ids.sql
 *   -> produccion-verificacion.sql -> cuentas previas -> 20260917000000 (esquema)
 *   -> 20260917010000 (datos generados por el importador).
 *
 * Todo lo que aquí se afirma lo hace cumplir la base, no la interfaz.
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
  esquema: leer(raiz, 'supabase', 'migrations', '20260917000000_verificacion-institucional.sql'),
  datos: leer(raiz, 'supabase', 'migrations', '20260917010000_catalogo-instituciones-datos.sql'),
};

const QRO = '1a898a3a-53c0-4468-8dc6-b03bef169a6e';
const PRODUCCION = {
  universities: { tec: '2c931b2c-9449-4ba7-b701-2a57c2ae2f62', icesi: '24ba682b-945a-4355-865a-dc65ec118861', javeriana: '9fa36a6f-f113-4788-90b2-5fc69430c851', cesa: '5ef91efd-a109-48d3-8f68-2a9308ce8c5e', purdue: 'bcda7873-6322-4d24-8b49-428e6706ee7d', 'florida-state': 'd8700f55-9fd3-42d1-a199-fba956e5d78d' },
  institutions: { 'tec-queretaro': QRO, 'tec-guadalajara': '9269e0c2-1704-4264-8e26-294c7fddbf8a', 'tec-monterrey': 'a77a918e-5b0b-45b2-9a01-acdd4d61d08a', 'tec-ciudad-de-mexico': '1fe414c7-3136-4696-ac67-2b07a416e9cf', 'florida-state': 'be062ad6-1a5d-4687-a71d-21c2ac7a8ad0', purdue: '3869753e-03d4-4ad9-ae96-2b7605117f4b', icesi: '2d5e3036-eed0-4398-92db-f92cb5f4dd4e', javeriana: '91eb1307-a047-436b-ba78-8c6eca58c4fe', cesa: '62cd4de7-26c3-49e4-b4f4-7b5e3efd0617', unam: '9aa57d8a-732e-4293-aa8a-bab741523796', ipn: 'a7463fb5-c938-4743-87cf-51f43edae71b', udg: 'c32b35f0-6177-4488-bb3c-cfa2e0985164', uanl: 'd54d915b-c7a1-4e6d-a2b5-bb7ff3a6f603', buap: '31744f31-49df-466f-bab4-f4527afde0f5', uam: 'e843d37b-5c82-42c0-b853-654807a41042', uaemex: '948cbbe0-8a83-4e6c-a4b6-e0aeb1d7f090', uaslp: '713927e5-430e-4325-af3f-0333d410b5d1', uaq: 'eaa4cd40-0566-42a6-ac91-e652b1137151', ibero: '46a080c1-c6d2-4ee9-ba04-db520d6ef99e', itam: 'f5d3ed89-6d29-4fbe-9470-44cd6ce0db26', anahuac: '60786e59-f502-4f49-824c-7509b8e2a400', udlap: '35a6dfa2-32e4-4286-ac5b-22241ecf3065', up: '026f4553-90bf-46b6-b17f-5784dbff1b7f', colmex: '9be8685c-ae88-4a73-ba4f-14b835d9b66b', cide: 'e592d5a8-f8e9-41e9-b285-68c5f5f858e1' },
};

let db: PGlite;
let n = 0;

type Uno<T = Record<string, unknown>> = { rows: T[]; error: string | null };

/** Una cuenta como la crearía Supabase Auth. `confirmada` = el proveedor confirmó el correo. */
async function cuenta(email: string, { confirmada = true, proveedor = 'email' } = {}): Promise<string> {
  n += 1;
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  await db.query(
    'INSERT INTO auth.users (id, email, email_confirmed_at, raw_app_meta_data) VALUES ($1, $2, $3, $4)',
    [id, email, confirmada ? new Date().toISOString() : null, JSON.stringify({ provider: proveedor })],
  );
  return id;
}

async function como<T = Record<string, unknown>>(rol: 'authenticated' | 'service_role', uid: string | null, sql: string, params: unknown[] = []): Promise<Uno<T>> {
  await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub', '${uid ?? ''}', false); SET ROLE ${rol};`);
  try {
    const r = await db.query<T>(sql, params);
    return { rows: r.rows, error: null };
  } catch (e) {
    return { rows: [], error: (e as Error).message };
  } finally {
    await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false);`);
  }
}
const comoApp = <T = Record<string, unknown>>(uid: string, sql: string, params: unknown[] = []) => como<T>('authenticated', uid, sql, params);

const id = async (tabla: 'universities' | 'institutions', slug: string) =>
  (await db.query<{ id: string }>(`SELECT id FROM public.${tabla} WHERE slug = $1`, [slug])).rows[0]?.id;

const afiliacion = async (uid: string) =>
  (await db.query<{ status: string; status_reason: string | null; verification_method: string | null; university_id: string | null; institutional_email_masked: string | null }>(
    'SELECT status, status_reason, verification_method, university_id, institutional_email_masked FROM public.profile_affiliations WHERE user_id = $1', [uid],
  )).rows[0];

const perfil = async (uid: string) =>
  (await db.query<{ campus_id: string | null; institution_verified: boolean; student_id: string | null }>(
    'SELECT campus_id, institution_verified, student_id FROM public.profiles WHERE id = $1', [uid],
  )).rows[0];

type Inicio = { status: string; challenge_id: string | null; code: string | null; email_masked: string | null; resend_after: string | null };
const iniciar = (uid: string, universidad: string, campus: string | null, email: string, matricula: string | null = null) =>
  como<Inicio>('service_role', null, 'SELECT * FROM public.start_institution_verification($1, $2, $3, $4, $5, $6)', [uid, universidad, campus, email, matricula, 'ip-prueba']);

const confirmar = (uid: string, codigo: string) =>
  comoApp<{ status: string; attempts_left: number }>(uid, 'SELECT * FROM public.confirm_institution_verification($1)', [codigo]);

/** Sin enfriamiento entre pruebas: se adelanta el reloj del último envío. */
const saltarEnfriamiento = (uid: string) =>
  db.query(`UPDATE public.institution_verification_challenges SET resend_after = now() - interval '1 second', created_at = created_at - interval '2 hours' WHERE user_id = $1`, [uid]);

let legacyVerificado: string;
let legacySinConfirmar: string;
let legacyManual: string;

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm, unaccent, pgcrypto } });
  await db.exec(SQL.instituciones);
  await db.exec(SQL.catalogo);
  await db.exec(SQL.ids);
  await db.exec(SQL.verificacionFixture);

  // Las tres situaciones de producción antes de migrar.
  legacyVerificado = await cuenta('a01714719@tec.mx');
  legacySinConfirmar = await cuenta('a01999999@tec.mx', { confirmada: false });
  legacyManual = await cuenta('persona@gmail.com');
  await db.query('UPDATE public.profiles SET campus_id = $1, institution_verified = true, onboarding_completed = true WHERE id = ANY($2)', [QRO, [legacyVerificado, legacySinConfirmar, legacyManual]]);
  await db.query(`INSERT INTO public.events (creator_id, title) VALUES ($1, 'Evento QRO')`, [legacyVerificado]);

  await db.exec(SQL.esquema);
  await db.exec(SQL.datos);
}, 120_000);

describe('catálogo', () => {
  it('conserva las instituciones y campus anteriores con los mismos ids', async () => {
    for (const [slug, uuid] of Object.entries(PRODUCCION.universities)) expect(await id('universities', slug)).toBe(uuid);
    for (const [slug, uuid] of Object.entries(PRODUCCION.institutions)) expect(await id('institutions', slug)).toBe(uuid);
    const qro = (await db.query<{ n: number; e: number }>(
      'SELECT (SELECT count(*)::int FROM public.profiles WHERE campus_id = $1) n, (SELECT count(*)::int FROM public.events WHERE institution_id = $1) e', [QRO],
    )).rows[0];
    expect(qro).toEqual({ n: 3, e: 1 });
  });

  it('tiene entre 300 y 500 instituciones de los tres países, sin campus huérfanos', async () => {
    const { rows } = await db.query<{ country_code: string; n: number }>('SELECT country_code, count(*)::int n FROM public.universities WHERE is_active GROUP BY 1 ORDER BY 1');
    const total = rows.reduce((s, r) => s + r.n, 0);
    expect(total).toBeGreaterThanOrEqual(300);
    expect(total).toBeLessThanOrEqual(500);
    expect(rows.map((r) => r.country_code)).toEqual(['CO', 'MX', 'US']);
    const huerfanos = (await db.query<{ n: number }>('SELECT count(*)::int n FROM public.institutions WHERE university_id IS NULL')).rows[0].n;
    expect(huerfanos).toBe(0);
  });

  it('los 16 campus antiguos ahora cuelgan de su institución, con el mismo id', async () => {
    const { rows } = await db.query<{ slug: string; u: string }>(
      `SELECT i.slug, u.slug u FROM public.institutions i JOIN public.universities u ON u.id = i.university_id
       WHERE i.slug IN ('unam','ipn','udg','colmex','cide')`);
    expect(Object.fromEntries(rows.map((r) => [r.slug, r.u]))).toEqual({ unam: 'unam', ipn: 'ipn', udg: 'udg', colmex: 'colmex', cide: 'cide' });
  });

  it('aplicar esquema e importación dos veces no crea duplicados ni cambia nada', async () => {
    const antes = (await db.query<{ u: number; i: number; d: number }>('SELECT (SELECT count(*)::int FROM public.universities) u, (SELECT count(*)::int FROM public.institutions) i, (SELECT count(*)::int FROM public.institution_email_domains) d')).rows[0];
    await db.exec(SQL.esquema);
    await db.exec(SQL.datos);
    const despues = (await db.query<{ u: number; i: number; d: number }>('SELECT (SELECT count(*)::int FROM public.universities) u, (SELECT count(*)::int FROM public.institutions) i, (SELECT count(*)::int FROM public.institution_email_domains) d')).rows[0];
    expect(despues).toEqual(antes);
  });

  it('Colegio Bolívar es una institución escolar, no una universidad', async () => {
    const { rows } = await db.query<{ institution_type: string; country_code: string; city: string }>(`SELECT institution_type, country_code, city FROM public.universities WHERE slug = 'colegio-bolivar'`);
    expect(rows[0]).toEqual({ institution_type: 'school', country_code: 'CO', city: 'Cali' });
  });

  it('un dominio sin confirmar, o de egresados, no se puede habilitar para verificar', async () => {
    await expect(db.query(`UPDATE public.institution_email_domains SET verification_enabled = true WHERE domain = 'tec.mx'`)).rejects.toThrow(/verification_rule/);
    await expect(db.query(`UPDATE public.institution_email_domains SET verification_enabled = true WHERE domain = 'exatec.tec.mx'`)).rejects.toThrow(/verification_rule/);
    await expect(db.query(`INSERT INTO public.institution_email_domains (domain, university_id) VALUES ('private.icloud.com', $1)`, [PRODUCCION.universities.tec])).rejects.toThrow(/DOMAIN_IS_PERSONAL/);
    await expect(db.query(`INSERT INTO public.institution_email_domains (domain, university_id) VALUES ('ÜBER.edu', $1)`, [PRODUCCION.universities.tec])).rejects.toThrow(/domain_format/);
  });
});

describe('buscar instituciones', () => {
  const buscar = async (uid: string, q: string, extra = '') =>
    (await comoApp<{ university_name: string; campus_name: string | null; institution_type: string; country_code: string }>(uid, `SELECT * FROM public.search_institutions($1${extra})`, [q])).rows;
  let alguien: string;
  beforeAll(async () => { alguien = await cuenta('buscador@gmail.com'); });

  it('por nombre, alias, abreviatura, ciudad y sin acentos', async () => {
    expect((await buscar(alguien, 'queretaro')).some((r) => r.campus_name === 'Querétaro' && r.university_name === 'Tecnológico de Monterrey')).toBe(true);
    expect((await buscar(alguien, 'ITESM')).every((r) => r.university_name === 'Tecnológico de Monterrey')).toBe(true);
    expect((await buscar(alguien, 'ITESM')).length).toBeGreaterThan(4);
    expect((await buscar(alguien, 'unam'))[0].university_name).toBe('Universidad Nacional Autónoma de México');
    expect((await buscar(alguien, 'tallahassee')).map((r) => r.university_name)).toContain('Florida State University');
    expect((await buscar(alguien, 'medellin')).length).toBeGreaterThan(3);
    expect((await buscar(alguien, 'colegio bolivar'))[0]).toMatchObject({ university_name: 'Colegio Bolívar', institution_type: 'school' });
  });

  it('filtra por país y tipo, y está paginada', async () => {
    const co = await comoApp<{ country_code: string }>(alguien, `SELECT * FROM public.search_institutions('universidad', 'CO', NULL, 50)`);
    expect(co.rows.length).toBe(50);
    expect(co.rows.every((r) => r.country_code === 'CO')).toBe(true);
    const cc = await comoApp<{ institution_type: string }>(alguien, `SELECT * FROM public.search_institutions(NULL, 'US', 'community_college', 50)`);
    expect(cc.rows.every((r) => r.institution_type === 'community_college')).toBe(true);
    const tope = await comoApp(alguien, `SELECT * FROM public.search_institutions(NULL, NULL, NULL, 100000)`);
    expect(tope.rows.length).toBe(50);
  });

  it('sin sesión no responde', async () => {
    expect((await como('authenticated', null, `SELECT * FROM public.search_institutions('tec')`)).error).toMatch(/NOT_AUTHENTICATED/);
  });
});

describe('alta y correo de acceso', () => {
  it('Gmail y los relays de Apple (antiguo y nuevo) se registran, pero quedan pendientes', async () => {
    for (const email of ['alguien@gmail.com', 'x7k2@privaterelay.appleid.com', 'q9z1@private.icloud.com']) {
      const uid = await cuenta(email, { proveedor: email.includes('gmail') ? 'google' : 'apple' });
      expect(await perfil(uid)).toMatchObject({ campus_id: null, institution_verified: false });
      expect(await afiliacion(uid)).toBeUndefined();
      const { rows } = await comoApp<{ status: string }>(uid, 'SELECT status FROM public.my_institution_verification()');
      expect(rows[0].status).toBe('unverified');
    }
  });

  it('un relay de Apple no puede usarse como correo institucional', async () => {
    const uid = await cuenta('abc@privaterelay.appleid.com', { proveedor: 'apple' });
    expect((await iniciar(uid, PRODUCCION.universities.purdue, null, 'abc@private.icloud.com')).rows[0].status).toBe('PERSONAL_EMAIL');
  });

  it('correo de acceso confirmado de un dominio confirmado con un solo campus: verifica y asigna ese campus', async () => {
    const uid = await cuenta('boiler@purdue.edu', { proveedor: 'google' });
    expect(await perfil(uid)).toMatchObject({ campus_id: PRODUCCION.institutions.purdue, institution_verified: true });
    expect(await afiliacion(uid)).toMatchObject({ status: 'verified', verification_method: 'auth_email_domain', institutional_email_masked: 'b***@purdue.edu' });
  });

  it('sin confirmar el correo no verifica; al confirmarlo sí', async () => {
    const uid = await cuenta('nole@fsu.edu', { confirmada: false });
    expect(await perfil(uid)).toMatchObject({ institution_verified: false, campus_id: null });
    await db.query('UPDATE auth.users SET email_confirmed_at = now() WHERE id = $1', [uid]);
    expect(await perfil(uid)).toMatchObject({ institution_verified: true, campus_id: PRODUCCION.institutions['florida-state'] });
  });

  it('un dominio compartido por varios campus no asigna campus: la persona elige, y entonces verifica', async () => {
    const uid = await cuenta('puma@comunidad.unam.mx', { proveedor: 'google' });
    expect(await perfil(uid)).toMatchObject({ campus_id: null, institution_verified: false });
    expect(await afiliacion(uid)).toMatchObject({ status: 'unverified', status_reason: 'choose_campus' });

    const otra = await comoApp(uid, 'UPDATE public.profiles SET campus_id = $1 WHERE id = $2', [PRODUCCION.institutions.purdue, uid]);
    expect(otra.error).toMatch(/CAMPUS_NOT_ALLOWED/);

    const unam = await id('institutions', 'unam-morelia');
    expect((await comoApp(uid, 'UPDATE public.profiles SET campus_id = $1 WHERE id = $2', [unam, uid])).error).toBeNull();
    expect(await perfil(uid)).toMatchObject({ campus_id: unam, institution_verified: true });
  });

  it('dominio probable, de egresados, desactivado o parecido no verifica', async () => {
    for (const email of ['a01234567@tec.mx', 'a01234567@exatec.tec.mx', 'x@my.fsu.edu', 'x@javeriana.edu.co', 'x@evil-fsu.edu', 'x@fsu.edu.co', 'x@fsu.edu.evil.com', 'x@purdue.edu.mx', 'x@notpurdue.edu']) {
      const uid = await cuenta(email, { proveedor: 'google' });
      expect(await perfil(uid), email).toMatchObject({ institution_verified: false, campus_id: null });
    }
  });
});

describe('cuentas que ya existían', () => {
  it('la verificada con correo del Tec confirmado se conserva como legacy', async () => {
    expect(await afiliacion(legacyVerificado)).toMatchObject({ status: 'verified', verification_method: 'legacy_auth_email' });
    expect((await perfil(legacyVerificado)).institution_verified).toBe(true);
  });

  it('la verificada con el correo SIN confirmar pasa a pendiente', async () => {
    expect(await afiliacion(legacySinConfirmar)).toMatchObject({ status: 'pending_email', status_reason: 'legacy_unconfirmed_auth_email' });
    expect((await perfil(legacySinConfirmar)).institution_verified).toBe(false);
  });

  it('la verificada a mano se conserva', async () => {
    expect(await afiliacion(legacyManual)).toMatchObject({ status: 'verified', verification_method: 'legacy_manual' });
  });
});

describe('código al correo institucional', () => {
  let unamCampus: string;
  let unam: string;
  beforeAll(async () => {
    unamCampus = PRODUCCION.institutions.unam;
    unam = (await db.query<{ id: string }>(`SELECT university_id id FROM public.institutions WHERE slug = 'unam'`)).rows[0].id;
  });

  /** Cuenta de Apple con campus UNAM elegido en el alta. */
  async function appleEnUnam() {
    const uid = await cuenta(`r${n}@privaterelay.appleid.com`, { proveedor: 'apple' });
    await db.query('UPDATE public.profiles SET campus_id = $1 WHERE id = $2', [unamCampus, uid]);
    return uid;
  }

  it('el código correcto verifica la MISMA cuenta de Apple, sin crear otra ni cambiar su correo', async () => {
    const uid = await appleEnUnam();
    const usuariosAntes = (await db.query<{ n: number }>('SELECT count(*)::int n FROM auth.users')).rows[0].n;

    const inicio = (await iniciar(uid, unam, unamCampus, '  Maria.Lopez@Comunidad.UNAM.mx ', '317123456')).rows[0];
    expect(inicio).toMatchObject({ status: 'SENT', email_masked: 'm***@comunidad.unam.mx' });
    expect(inicio.code).toMatch(/^\d{6}$/);
    expect((await afiliacion(uid)).status).toBe('pending_email');

    expect((await confirmar(uid, inicio.code!)).rows[0].status).toBe('VERIFIED');

    const auth = (await db.query<{ id: string; email: string; provider: string }>(`SELECT id, email, raw_app_meta_data->>'provider' provider FROM auth.users WHERE id = $1`, [uid])).rows[0];
    expect(auth).toEqual({ id: uid, email: auth.email, provider: 'apple' });
    expect(auth.email).toMatch(/privaterelay\.appleid\.com$/);
    expect((await db.query<{ n: number }>('SELECT count(*)::int n FROM auth.users')).rows[0].n).toBe(usuariosAntes);
    expect(await afiliacion(uid)).toMatchObject({ status: 'verified', verification_method: 'institutional_email_otp' });
    expect(await perfil(uid)).toMatchObject({ institution_verified: true, student_id: '317123456', campus_id: unamCampus });
  });

  it('el código no se guarda en claro ni el correo completo', async () => {
    const { rows } = await db.query<{ t: string }>(`SELECT row_to_json(c)::text t FROM public.institution_verification_challenges c`);
    const todo = rows.map((r) => r.t).join('\n');
    expect(todo).not.toMatch(/maria\.lopez/i);
    const afil = (await db.query<{ t: string }>(`SELECT json_agg(a)::text t FROM public.profile_affiliations a`)).rows[0].t;
    expect(afil).not.toMatch(/maria\.lopez/i);
  });

  it('reutilizado, incorrecto, expirado o con demasiados intentos falla', async () => {
    const uid = await appleEnUnam();
    const a = (await iniciar(uid, unam, unamCampus, 'uno@comunidad.unam.mx')).rows[0];
    const malo = a.code === '000000' ? '111111' : '000000';
    expect((await confirmar(uid, malo)).rows[0]).toEqual({ status: 'INVALID_CODE', attempts_left: 4 });
    expect((await confirmar(uid, 'abc')).rows[0].status).toBe('INVALID_CODE');
    expect((await confirmar(uid, a.code!)).rows[0].status).toBe('VERIFIED');
    // Reutilizar el mismo código.
    expect((await confirmar(uid, a.code!)).rows[0].status).toBe('NO_PENDING');

    const uid2 = await appleEnUnam();
    const b = (await iniciar(uid2, unam, unamCampus, 'dos@comunidad.unam.mx')).rows[0];
    await db.query(`UPDATE public.institution_verification_challenges SET expires_at = now() - interval '1 second' WHERE id = $1`, [b.challenge_id]);
    expect((await confirmar(uid2, b.code!)).rows[0].status).toBe('EXPIRED');

    await saltarEnfriamiento(uid2);
    const c = (await iniciar(uid2, unam, unamCampus, 'dos@comunidad.unam.mx')).rows[0];
    const otro = c.code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) expect((await confirmar(uid2, otro)).rows[0].status).toBe('INVALID_CODE');
    expect((await confirmar(uid2, otro)).rows[0].status).toBe('LOCKED');
    // Bloqueado: ni siquiera el correcto sirve ya.
    expect((await confirmar(uid2, c.code!)).rows[0].status).toBe('NO_PENDING');
    expect((await perfil(uid2)).institution_verified).toBe(false);
  });

  it('un código nuevo revoca el anterior', async () => {
    const uid = await appleEnUnam();
    const primero = (await iniciar(uid, unam, unamCampus, 'tres@comunidad.unam.mx')).rows[0];
    expect((await iniciar(uid, unam, unamCampus, 'tres@comunidad.unam.mx')).rows[0].status).toBe('COOLDOWN');
    await saltarEnfriamiento(uid);
    const segundo = (await iniciar(uid, unam, unamCampus, 'tres@comunidad.unam.mx')).rows[0];
    if (primero.code !== segundo.code) expect((await confirmar(uid, primero.code!)).rows[0].status).toBe('INVALID_CODE');
    expect((await confirmar(uid, segundo.code!)).rows[0].status).toBe('VERIFIED');
  });

  it('un correo institucional no verifica dos cuentas, y no se dice cuál lo tiene', async () => {
    const a = await appleEnUnam();
    const b = await appleEnUnam();
    const ca = (await iniciar(a, unam, unamCampus, 'compartido@comunidad.unam.mx')).rows[0];
    expect((await confirmar(a, ca.code!)).rows[0].status).toBe('VERIFIED');
    // Mismo mensaje de envío para B: no revela que el correo ya está en uso.
    const cb = (await iniciar(b, unam, unamCampus, 'COMPARTIDO@comunidad.unam.mx')).rows[0];
    expect(cb.status).toBe('SENT');
    expect((await confirmar(b, cb.code!)).rows[0].status).toBe('MANUAL_REVIEW');
    expect(await afiliacion(b)).toMatchObject({ status: 'manual_review', status_reason: 'email_in_use' });
    expect((await afiliacion(a)).status).toBe('verified');
    // Y la base lo impide aunque alguien se saltara la función.
    await expect(db.query(`UPDATE public.profile_affiliations SET status = 'verified', verified_at = now(), verification_method = 'manual_review', institutional_email_hash = (SELECT institutional_email_hash FROM public.profile_affiliations WHERE user_id = $1) WHERE user_id = $2`, [a, b])).rejects.toThrow(/verified_email_key/);
  });

  it('solo verifica con un dominio confirmado de ESA institución', async () => {
    const uid = await appleEnUnam();
    expect((await iniciar(uid, unam, unamCampus, 'x@unam.mx')).rows[0].status).toBe('DOMAIN_NOT_VERIFIABLE');
    expect((await iniciar(uid, unam, unamCampus, 'x@purdue.edu')).rows[0].status).toBe('DOMAIN_NOT_VERIFIABLE');
    expect((await iniciar(uid, unam, unamCampus, 'x@comunidad.unam.mx.evil.com')).rows[0].status).toBe('DOMAIN_NOT_VERIFIABLE');
    expect((await iniciar(uid, unam, unamCampus, 'no-es-correo')).rows[0].status).toBe('INVALID_EMAIL');
    // Otra institución que la de su comunidad: a revisión, sin cambiar de campus.
    expect((await iniciar(uid, PRODUCCION.universities.purdue, null, 'x@purdue.edu')).rows[0].status).toBe('INSTITUTION_MISMATCH');
  });

  it('un dominio desactivado entre el envío y la confirmación ya no verifica', async () => {
    const uid = await appleEnUnam();
    const c = (await iniciar(uid, unam, unamCampus, 'cuatro@comunidad.unam.mx')).rows[0];
    await db.query(`UPDATE public.institution_email_domains SET verification_enabled = false WHERE domain = 'comunidad.unam.mx'`);
    try {
      expect((await confirmar(uid, c.code!)).rows[0].status).toBe('DOMAIN_NOT_VERIFIABLE');
    } finally {
      await db.query(`UPDATE public.institution_email_domains SET verification_enabled = true WHERE domain = 'comunidad.unam.mx'`);
    }
  });

  it('limita los envíos por cuenta', async () => {
    const uid = await appleEnUnam();
    let ultimo = '';
    for (let i = 0; i < 6; i++) {
      await db.query(`UPDATE public.institution_verification_challenges SET resend_after = now() - interval '1 second' WHERE user_id = $1`, [uid]);
      ultimo = (await iniciar(uid, unam, unamCampus, `limite${i}@comunidad.unam.mx`)).rows[0].status;
    }
    expect(ultimo).toBe('RATE_LIMITED');
  });

  it('Colegio Bolívar completa el mismo flujo cuando su dominio quede confirmado', async () => {
    const bolivar = await id('universities', 'colegio-bolivar');
    const campus = await id('institutions', 'colegio-bolivar');
    // Simula evidencia oficial futura; hoy no hay dominio sembrado.
    await db.query(
      `INSERT INTO public.institution_email_domains (domain, university_id, audience, confidence, verification_enabled, official_source_url, last_verified_at)
       VALUES ('estudiantes.colegio-bolivar.test', $1, 'student', 'confirmed', true, 'https://www.colegiobolivar.edu.co/', current_date)`, [bolivar]);
    const uid = await cuenta('familia@gmail.com');
    expect((await comoApp(uid, 'UPDATE public.profiles SET campus_id = $1 WHERE id = $2', [campus, uid])).error).toBeNull();
    const c = (await iniciar(uid, bolivar, campus, 'alumno@estudiantes.colegio-bolivar.test')).rows[0];
    expect((await confirmar(uid, c.code!)).rows[0].status).toBe('VERIFIED');
    const pub = await comoApp<{ university_name: string; institution_type: string }>(uid, 'SELECT university_name, institution_type FROM public.public_profiles WHERE id = $1', [uid]);
    expect(pub.rows[0]).toEqual({ university_name: 'Colegio Bolívar', institution_type: 'school' });
  });

  it('cambiar de institución desde el panel retira la verificación', async () => {
    const uid = await appleEnUnam();
    const c = (await iniciar(uid, unam, unamCampus, 'cinco@comunidad.unam.mx')).rows[0];
    await confirmar(uid, c.code!);
    await db.query('UPDATE public.profiles SET campus_id = $1 WHERE id = $2', [PRODUCCION.institutions.icesi, uid]);
    expect(await afiliacion(uid)).toMatchObject({ status: 'revoked', status_reason: 'institution_changed' });
    expect((await perfil(uid)).institution_verified).toBe(false);
  });
});

describe('privacidad', () => {
  let dueno: string;
  let otro: string;
  beforeAll(async () => {
    dueno = await cuenta('priv@purdue.edu', { proveedor: 'google' });
    otro = await cuenta('otro@purdue.edu', { proveedor: 'google' });
    await db.query('UPDATE public.profiles SET student_id = $1 WHERE id = $2', ['PU123', dueno]);
  });

  it('las tablas privadas no se pueden leer desde la app', async () => {
    for (const t of ['profile_affiliations', 'institution_verification_challenges', 'institution_verification_events', 'institution_email_domains', 'email_domain_blocklist', 'institution_requests']) {
      expect((await comoApp(otro, `SELECT * FROM public.${t}`)).error, t).toMatch(/permission denied/);
    }
  });

  it('el perfil público muestra institución y campus, pero no matrícula ni correo', async () => {
    const { rows } = await comoApp<Record<string, unknown>>(otro, 'SELECT * FROM public.public_profiles WHERE id = $1', [dueno]);
    expect(rows[0]).toMatchObject({ university_name: 'Purdue University', institution_verified: true });
    const cols = Object.keys(rows[0]);
    for (const c of ['student_id', 'email', 'institutional_email_hash', 'institutional_email_masked']) expect(cols).not.toContain(c);
    expect(JSON.stringify(rows[0])).not.toMatch(/PU123|priv@|p\*\*\*@/);
  });

  it('my_institution_verification solo devuelve lo propio, enmascarado', async () => {
    const mio = await comoApp<{ email_masked: string; status: string }>(dueno, 'SELECT * FROM public.my_institution_verification()');
    expect(mio.rows).toHaveLength(1);
    expect(mio.rows[0]).toMatchObject({ status: 'verified', email_masked: 'p***@purdue.edu' });
    const ajeno = await comoApp<{ email_masked: string }>(otro, 'SELECT * FROM public.my_institution_verification()');
    expect(ajeno.rows[0].email_masked).toBe('o***@purdue.edu');
  });

  it('la app no puede emitir desafíos, ni hash, ni revocar dominios, ni tocar la verificación', async () => {
    expect((await comoApp(otro, `SELECT * FROM public.start_institution_verification($1, $2, NULL, 'x@purdue.edu')`, [otro, PRODUCCION.universities.purdue])).error).toMatch(/permission denied/);
    expect((await comoApp(otro, `SELECT public.institution_hmac('x')`)).error).toMatch(/permission denied/);
    expect((await comoApp(otro, `SELECT public.revoke_verifications_for_domain(gen_random_uuid(), 'x')`)).error).toMatch(/permission denied/);
    const sinVerificar = await cuenta('quiere-insignia@gmail.com');
    expect((await comoApp(sinVerificar, `UPDATE public.profiles SET institution_verified = true WHERE id = $1`, [sinVerificar])).error).toMatch(/institution_verified/);
    expect((await perfil(sinVerificar)).institution_verified).toBe(false);
  });

  it('confirmar sin sesión no hace nada', async () => {
    expect((await como('authenticated', null, `SELECT * FROM public.confirm_institution_verification('123456')`)).error).toMatch(/NOT_AUTHENTICATED/);
  });

  it('solicitar una institución no acepta dominios y tiene límite', async () => {
    const uid = await cuenta('pide@gmail.com');
    const ok = await comoApp(uid, `SELECT public.request_institution('add_institution', 'Universidad de Prueba', 'MX', 'Toluca', 'https://prueba.edu.mx', NULL)`);
    expect(ok.error).toBeNull();
    for (let i = 0; i < 4; i++) await comoApp(uid, `SELECT public.request_institution('add_institution', 'Otra ${i}', 'MX')`);
    expect((await comoApp(uid, `SELECT public.request_institution('add_institution', 'Sexta', 'MX')`)).error).toMatch(/REQUEST_RATE_LIMIT/);
    const cols = (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'institution_requests'`)).rows.map((r) => r.column_name);
    expect(cols.some((c) => /domain/.test(c))).toBe(false);
  });
});
