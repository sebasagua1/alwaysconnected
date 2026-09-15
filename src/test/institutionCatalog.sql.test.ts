// @vitest-environment node
/**
 * La migración del catálogo de universidades, ejecutada de verdad.
 *
 * Corre en PGlite (Postgres en WebAssembly) sobre una réplica mínima de la
 * base de producción (sql/produccion-instituciones.sql) y comprueba lo que la
 * interfaz no puede garantizar: qué se guarda, quién puede cambiarlo y qué ve
 * cada comunidad. No toca Supabase.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const raiz = join(__dirname, '..', '..');
const FIXTURE = readFileSync(join(__dirname, 'sql', 'produccion-instituciones.sql'), 'utf8');
const MIGRACION = readFileSync(
  join(raiz, 'supabase', 'migrations', '20260915000000_catalogo-universidades.sql'),
  'utf8',
);

const QRO_ID = '11111111-1111-1111-1111-111111111111';

const CATALOGO = [
  'tec-queretaro',
  'tec-guadalajara',
  'tec-monterrey',
  'tec-ciudad-de-mexico',
  'florida-state',
  'purdue',
  'icesi',
  'javeriana',
  'cesa',
];

let db: PGlite;
let n = 0;

/** Crea una cuenta como lo haría Supabase Auth; el disparador crea el perfil. */
async function alta(email: string): Promise<string> {
  n += 1;
  const id = `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, email]);
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

const perfil = async (id: string) =>
  (await db.query<{ campus_id: string | null; institution_verified: boolean; student_id: string | null }>(
    'SELECT campus_id, institution_verified, student_id FROM public.profiles WHERE id = $1',
    [id],
  )).rows[0];

const idDe = async (slug: string) =>
  (await db.query<{ id: string }>('SELECT id FROM public.institutions WHERE slug = $1', [slug])).rows[0]?.id;

/** Lo que hace Onboarding.handleComplete, reducido a lo que importa aquí. */
const terminarAlta = (uid: string, campusId: string | null) =>
  comoApp(uid, `UPDATE public.profiles SET campus_id = $1, onboarding_completed = true WHERE id = $2 RETURNING id`, [campusId, uid]);

let quereUsuario: string;
let quereNoVerificado: string;
let eventoQro: string;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(FIXTURE);

  // Dos personas que ya estaban en Tec Querétaro antes de la migración: una
  // entró con @tec.mx (verificada) y otra eligió a mano (sin verificar).
  quereUsuario = await alta('a01714719@tec.mx');
  quereNoVerificado = await alta('ana@gmail.com');
  await db.query('UPDATE public.profiles SET campus_id = $1, onboarding_completed = true WHERE id = $2', [QRO_ID, quereNoVerificado]);
  await db.query('UPDATE public.profiles SET onboarding_completed = true WHERE id = $1', [quereUsuario]);
  eventoQro = (await db.query<{ id: string }>(
    `INSERT INTO public.events (creator_id, title) VALUES ($1, 'Evento QRO') RETURNING id`, [quereUsuario],
  )).rows[0].id;

  await db.exec(MIGRACION);
}, 60_000);

describe('catálogo de universidades', () => {
  it('la migración se puede aplicar dos veces sin duplicar nada', async () => {
    await db.exec(MIGRACION);
    const { rows } = await db.query<{ c: number }>(
      'SELECT count(*)::int AS c FROM public.institutions WHERE university_id IS NOT NULL',
    );
    expect(rows[0].c).toBe(9);
  });

  it('el selector ofrece exactamente los nueve campus, ni uno más', async () => {
    const uid = await alta('persona@gmail.com');
    const { rows, error } = await comoApp<{ slug: string }>(uid, 'SELECT slug FROM public.campus_options()');
    expect(error).toBeNull();
    expect(rows.map((r) => r.slug).sort()).toEqual([...CATALOGO].sort());
  });

  it('los cuatro campus del Tec son de la misma universidad y distinguibles', async () => {
    const uid = await alta('otra@gmail.com');
    const { rows } = await comoApp<{ slug: string; campus_name: string; name: string; university_slug: string; city: string }>(
      uid,
      `SELECT slug, campus_name, name, university_slug, city FROM public.campus_options() WHERE university_slug = 'tec'`,
    );
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.campus_name)).size).toBe(4);
    expect(new Set(rows.map((r) => r.name)).size).toBe(4);
    expect(rows.map((r) => r.campus_name).sort()).toEqual(['Ciudad de México', 'Guadalajara', 'Monterrey', 'Querétaro']);
  });

  it('agrupa por país: México, Estados Unidos y Colombia', async () => {
    const uid = await alta('pais@gmail.com');
    const { rows } = await comoApp<{ country_code: string; university_slug: string }>(
      uid, 'SELECT DISTINCT country_code, university_slug FROM public.campus_options()',
    );
    const por = (c: string) => rows.filter((r) => r.country_code === c).map((r) => r.university_slug).sort();
    expect(por('MX')).toEqual(['tec']);
    expect(por('US')).toEqual(['florida-state', 'purdue']);
    expect(por('CO')).toEqual(['cesa', 'icesi', 'javeriana']);
  });

  it('las 16 universidades antiguas siguen intactas y activas, fuera del selector', async () => {
    const { rows } = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM public.institutions WHERE university_id IS NULL AND is_active AND cardinality(email_domains) > 0`,
    );
    expect(rows[0].c).toBe(16);
  });
});

describe('usuarios que ya existían', () => {
  it('Tec Querétaro conserva su id, sus perfiles y su verificación', async () => {
    expect(await idDe('tec-queretaro')).toBe(QRO_ID);
    expect(await idDe('tec-mty-qro')).toBeUndefined();
    expect(await perfil(quereUsuario)).toMatchObject({ campus_id: QRO_ID, institution_verified: true, student_id: 'a01714719' });
    expect(await perfil(quereNoVerificado)).toMatchObject({ campus_id: QRO_ID, institution_verified: false });
  });

  it('sus eventos siguen siendo de Querétaro', async () => {
    const { rows } = await db.query<{ institution_id: string }>('SELECT institution_id FROM public.events WHERE id = $1', [eventoQro]);
    expect(rows[0].institution_id).toBe(QRO_ID);
  });

  it('no pueden cambiarse de campus desde la app', async () => {
    const gdl = await idDe('tec-guadalajara');
    const r = await comoApp(quereUsuario, 'UPDATE public.profiles SET campus_id = $1 WHERE id = $2', [gdl, quereUsuario]);
    expect(r.error).toContain('CAMPUS_LOCKED');
    expect((await perfil(quereUsuario)).campus_id).toBe(QRO_ID);
  });

  it('guardar el perfil con el mismo campus no choca con el bloqueo', async () => {
    const r = await comoApp(quereUsuario, `UPDATE public.profiles SET campus_id = $1, major = 'ITC' WHERE id = $2 RETURNING id`, [QRO_ID, quereUsuario]);
    expect(r.error).toBeNull();
    expect(r.rows).toHaveLength(1);
  });
});

describe('alta con cada opción del catálogo', () => {
  it.each(CATALOGO)('con correo genérico se puede terminar el alta en %s, sin verificar', async (slug) => {
    const uid = await alta(`generico-${slug}@gmail.com`);
    const campus = await idDe(slug);
    const r = await terminarAlta(uid, campus);
    expect(r.error).toBeNull();
    expect(await perfil(uid)).toMatchObject({ campus_id: campus, institution_verified: false, student_id: null });
  });

  it.each(['tec-queretaro', 'tec-guadalajara', 'tec-monterrey', 'tec-ciudad-de-mexico'])(
    'con @tec.mx se elige el campus %s y queda verificado',
    async (slug) => {
      const uid = await alta(`a0${slug.length}${n}@tec.mx`);
      // El dominio no dice el campus: el alta lo deja sin asignar...
      expect(await perfil(uid)).toMatchObject({ campus_id: null, institution_verified: false });
      // ...y el selector solo le ofrece los del Tec.
      const opciones = await comoApp<{ slug: string; email_verified: boolean }>(uid, 'SELECT slug, email_verified FROM public.campus_options()');
      expect(opciones.rows.map((o) => o.slug).sort()).toEqual(['tec-ciudad-de-mexico', 'tec-guadalajara', 'tec-monterrey', 'tec-queretaro']);
      expect(opciones.rows.every((o) => o.email_verified)).toBe(true);

      const campus = await idDe(slug);
      expect((await terminarAlta(uid, campus)).error).toBeNull();
      const p = await perfil(uid);
      expect(p).toMatchObject({ campus_id: campus, institution_verified: true });
      expect(p.student_id).not.toBeNull();
    },
  );

  it('con @tec.mx no se puede elegir otra universidad', async () => {
    const uid = await alta('a09999999@tec.mx');
    const r = await terminarAlta(uid, await idDe('purdue'));
    expect(r.error).toContain('CAMPUS_NOT_ALLOWED');
    expect((await perfil(uid)).campus_id).toBeNull();
  });

  it.each([
    ['alumno@purdue.edu', 'purdue'],
    ['abc21@fsu.edu', 'florida-state'],
    ['pedro.patino@u.icesi.edu.co', 'icesi'],
    ['empleado@icesi.edu.co', 'icesi'],
    ['alguien@javeriana.edu.co', 'javeriana'],
  ])('%s queda en %s y verificado desde el alta (un solo campus)', async (email, slug) => {
    const uid = await alta(email);
    expect(await perfil(uid)).toMatchObject({ campus_id: await idDe(slug), institution_verified: true });
  });

  it('las filas antiguas no se pueden elegir a mano', async () => {
    const uid = await alta('mano@gmail.com');
    const r = await terminarAlta(uid, await idDe('unam'));
    expect(r.error).toContain('CAMPUS_NOT_AVAILABLE');
  });

  it('la app no puede declararse verificada', async () => {
    const uid = await alta('trampa@gmail.com');
    const r = await comoApp(uid, `UPDATE public.profiles SET campus_id = $1, institution_verified = true WHERE id = $2`, [await idDe('purdue'), uid]);
    expect(r.error).not.toBeNull();
    expect(await perfil(uid)).toMatchObject({ campus_id: null, institution_verified: false });
  });
});

describe('validación del dominio', () => {
  const universidad = async (email: string) =>
    (await db.query<{ slug: string | null }>(
      'SELECT (SELECT slug FROM public.universities WHERE id = public.university_for_email($1)) AS slug', [email],
    )).rows[0].slug;

  it.each([
    ['a01714719@tec.mx', 'tec'],
    ['A01714719@TEC.MX', 'tec'],
    ['  a01714719@tec.mx  ', 'tec'],
    ['x@purdue.edu', 'purdue'],
    ['x@FSU.edu', 'florida-state'],
    ['x@u.icesi.edu.co', 'icesi'],
    ['x@javeriana.edu.co', 'javeriana'],
  ])('acepta %s -> %s', async (email, slug) => {
    expect(await universidad(email)).toBe(slug);
  });

  it.each([
    'x@tec.mx.evil.com',
    'x@evil-tec.mx',
    'x@nottec.mx',
    'x@sub.tec.mx',
    'tec.mx@gmail.com',
    'x@purdue.edu.co',
    'x@fakepurdue.edu',
    'x@purdue.edu@gmail.com',
    'x@icesi.edu.co.evil.com',
    'x@javerianacali.edu.co',
    'x@cesa.edu.co',
    'sin-arroba',
    '',
  ])('rechaza %s', async (email) => {
    expect(await universidad(email)).toBeNull();
  });

  it('un dominio antiguo (UNAM) sigue dando alta automática, como antes', async () => {
    const uid = await alta('alguien@unam.mx');
    expect(await perfil(uid)).toMatchObject({ campus_id: await idDe('unam'), institution_verified: true });
  });
});

describe('aislamiento por campus', () => {
  it('Tec Guadalajara no ve eventos ni perfiles de Tec Querétaro; Querétaro sí', async () => {
    const gdl = await alta('a07777777@tec.mx');
    await terminarAlta(gdl, await idDe('tec-guadalajara'));
    const qroNuevo = await alta('a08888888@tec.mx');
    await terminarAlta(qroNuevo, QRO_ID);

    const verDesdeGdl = await comoApp<{ id: string }>(gdl, 'SELECT id FROM public.events WHERE id = $1', [eventoQro]);
    expect(verDesdeGdl.rows).toHaveLength(0);
    const verDesdeQro = await comoApp<{ id: string }>(qroNuevo, 'SELECT id FROM public.events WHERE id = $1', [eventoQro]);
    expect(verDesdeQro.rows).toHaveLength(1);

    const perfilesGdl = await comoApp<{ id: string }>(gdl, 'SELECT id FROM public.public_profiles WHERE id = $1', [quereUsuario]);
    expect(perfilesGdl.rows).toHaveLength(0);
  });

  it('Purdue no ve el contenido del Tec', async () => {
    const purdue = await alta('boiler@purdue.edu');
    const r = await comoApp<{ id: string }>(purdue, 'SELECT id FROM public.events');
    expect(r.rows.map((e) => e.id)).not.toContain(eventoQro);
  });

  it('los eventos nuevos quedan en el campus de quien los crea, no en Querétaro', async () => {
    const uid = await alta('evento@purdue.edu');
    await comoApp(uid, `INSERT INTO public.events (creator_id, title) VALUES ($1, 'Boiler Up')`, [uid]);
    const { rows } = await db.query<{ institution_id: string }>(
      'SELECT institution_id FROM public.events WHERE creator_id = $1', [uid],
    );
    expect(rows[0].institution_id).toBe(await idDe('purdue'));
  });
});
