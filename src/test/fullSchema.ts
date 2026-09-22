/**
 * Una base con el esquema REAL del proyecto, para probar RLS y disparadores.
 *
 * Los fixtures a mano (sql/eventos-sociales.sql y compañía) copian solo las
 * tablas que cada prueba necesita, y con eso comprueban la migración nueva
 * contra una imitación de lo que había. Para lo que toca políticas de
 * varias tablas a la vez —el chat de actividad, las notificaciones— hace
 * falta la base de verdad: aquí se carga supabase/setup/full_schema.sql
 * entero, generado a partir de TODAS las migraciones, sobre unos pocos
 * stubs de Supabase (sql/supabase-stubs.sql).
 *
 * Lo único que se quita del consolidado son las extensiones que PGlite no
 * tiene (postgis, pg_cron, pg_net); sus funciones las ponen los stubs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';

const RAIZ = join(__dirname, '..', '..');
const MIGRACIONES = join(RAIZ, 'supabase', 'migrations');

/** Extensiones que PGlite no trae: sus llamadas las cubren los stubs. */
const SIN_EXTENSION = /^\s*(CREATE EXTENSION IF NOT EXISTS (postgis|pg_cron|pg_net)\b[^;]*;|DROP EXTENSION IF EXISTS postgis;)\s*$/gim;

export function sinExtensionesAjenas(sql: string): string {
  return sql.replace(SIN_EXTENSION, '-- (omitido en PGlite)');
}

/** Migraciones posteriores a la última que ya recoge full_schema.sql. */
export function migracionesDespuesDe(ultima: string): string[] {
  return readdirSync(MIGRACIONES)
    .filter((f) => f.endsWith('.sql') && f > ultima)
    .sort();
}

export function leerMigracion(nombre: string): string {
  return sinExtensionesAjenas(readFileSync(join(MIGRACIONES, nombre), 'utf8'));
}

/** La última migración incluida en el consolidado, leída de su cabecera. */
export function ultimaDelConsolidado(): string {
  const cabecera = readFileSync(join(RAIZ, 'supabase', 'setup', 'full_schema.sql'), 'utf8').slice(0, 2000);
  const m = cabecera.match(/hasta (\d{14}_[^)]+\.sql)/);
  if (!m) throw new Error('full_schema.sql sin cabecera "hasta ...": regenéralo con npm run schema:gen');
  return m[1];
}

/**
 * Crea la base. `hasta` corta el consolidado justo antes de la migración
 * indicada (para probar una migración sobre el estado anterior a ella);
 * sin `hasta`, carga todo.
 */
export async function baseReal(opts: { antesDe?: string } = {}): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto, pg_trgm, unaccent } });
  await db.exec(readFileSync(join(__dirname, 'sql', 'supabase-stubs.sql'), 'utf8'));

  let esquema = readFileSync(join(RAIZ, 'supabase', 'setup', 'full_schema.sql'), 'utf8');
  if (opts.antesDe) {
    const marca = `-- >>> ${opts.antesDe} <<<`;
    const corte = esquema.indexOf(marca);
    if (corte === -1) throw new Error(`${opts.antesDe} no está en full_schema.sql`);
    esquema = esquema.slice(0, corte);
  }
  // La migración de datos del catálogo (20260917010000) comprueba que los ids
  // de producción no cambian, y un arranque desde cero los genera al azar: se
  // fijan los de verdad justo antes, igual que hacen las pruebas del catálogo.
  const pin = '-- >>> 20260917000000_verificacion-institucional.sql <<<';
  const i = esquema.indexOf(pin);
  if (i === -1) {
    await db.exec(sinExtensionesAjenas(esquema));
  } else {
    await db.exec(sinExtensionesAjenas(esquema.slice(0, i)));
    await db.exec(readFileSync(join(__dirname, 'sql', 'produccion-ids.sql'), 'utf8'));
    await db.exec(sinExtensionesAjenas(esquema.slice(i)));
  }
  return db;
}

/** Ejecuta `fn` como una persona con sesión, igual que PostgREST. */
export async function como<T>(db: PGlite, uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', false);`);
  try {
    return await fn();
  } finally {
    await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`);
  }
}

/** Crea una cuenta con perfil terminado en el campus indicado. */
export async function crearPersona(
  db: PGlite,
  id: string,
  nombre: string,
  campus: string,
  extra: { email?: string } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())`,
    [id, extra.email ?? `${nombre.toLowerCase()}@example.com`],
  );
  // handle_new_user ya creó la fila; se completa como tras el onboarding.
  await db.query(
    `UPDATE public.profiles SET name = $2, campus_id = $3, onboarding_completed = true WHERE id = $1`,
    [id, nombre, campus],
  );
}
