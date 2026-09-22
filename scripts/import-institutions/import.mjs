#!/usr/bin/env node
/**
 * Importa el catálogo curado a Supabase mediante una migración idempotente.
 *
 *   node scripts/import-institutions/import.mjs --dry-run [--snapshot ruta.json]
 *   node scripts/import-institutions/import.mjs            (escribe la migración)
 *
 * --dry-run compara data/catalog.json y data/email-domains.json con una foto
 * de la base (por defecto data/production-snapshot.json; se regenera con la
 * consulta que imprime --print-snapshot-sql) y muestra
 * inserted / updated / unchanged / conflicted / skipped. No escribe nada.
 *
 * Sin --dry-run genera supabase/migrations/20260917010000_catalogo-instituciones-datos.sql.
 * Esa migración:
 *   - hace upsert por país + slug, nunca borra;
 *   - falla si un slug conocido apunta a otro id, o si un campus cambiaría de
 *     institución;
 *   - no toca profiles ni events, y comprueba al final que ningún perfil ni
 *     evento cambió de campus;
 *   - en los registros que ya existían solo rellena lo vacío (no pisa nombres).
 *
 * Termina con código 1 si hay conflictos que impedirían aplicar.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fold, sqlLiteral, validateDomainEntry, normalizeDomain, INSTITUTION_TYPES } from './lib.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, '..', '..');
const DATA = join(DIR, 'data');
export const MIGRATION_PATH = join(ROOT, 'supabase', 'migrations', '20260917010000_catalogo-instituciones-datos.sql');

export const SNAPSHOT_SQL = `select json_build_object(
  'universities', (select json_agg(json_build_object('id', id, 'slug', slug, 'country_code', country_code, 'name', name,
     'short_name', short_name, 'institution_type', institution_type, 'city', city, 'state_region', state_region)) from public.universities),
  'institutions', (select json_agg(json_build_object('id', i.id, 'slug', i.slug, 'name', i.name, 'university_slug', u.slug,
     'campus_slug', i.campus_slug, 'campus_name', i.campus_name, 'city', i.city)) from public.institutions i left join public.universities u on u.id = i.university_id),
  'domains', (select json_agg(json_build_object('domain', d.domain, 'university_slug', u.slug, 'audience', d.audience,
     'confidence', d.confidence, 'verification_enabled', d.verification_enabled, 'is_active', d.is_active))
     from public.institution_email_domains d join public.universities u on u.id = d.university_id)
);`;

export function loadInputs(dir = DATA) {
  return {
    catalog: JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8')),
    domains: JSON.parse(readFileSync(join(dir, 'email-domains.json'), 'utf8')).domains,
    overrides: JSON.parse(readFileSync(join(dir, 'overrides.json'), 'utf8')),
  };
}

/** Errores del catálogo que impiden importar. */
export function validateCatalog(catalog, domains) {
  const errors = [];
  const skipped = [];
  const slugs = new Map();
  const names = new Map();
  const sources = new Map();
  const campusSlugs = new Map();
  const campusNames = new Map();
  for (const e of catalog.institutions) {
    const where = `${e.country_code}:${e.slug}`;
    if (!/^[A-Z]{2}$/.test(e.country_code)) { skipped.push(`${where}: país inválido`); continue; }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.slug)) { skipped.push(`${where}: slug inválido`); continue; }
    if (!INSTITUTION_TYPES.includes(e.institution_type)) { skipped.push(`${where}: tipo ${e.institution_type}`); continue; }
    if (!e.name || !e.campuses?.length) { skipped.push(`${where}: sin nombre o sin campus`); continue; }
    if (slugs.has(e.slug)) errors.push(`slug duplicado: ${e.slug}`);
    slugs.set(e.slug, e);
    const nk = `${e.country_code}:${fold(e.name)}`;
    if (names.has(nk)) errors.push(`nombre duplicado en ${e.country_code}: ${e.name} (${names.get(nk).slug} y ${e.slug})`);
    names.set(nk, e);
    const sk = `${e.country_code}:${e.source?.name}:${e.source?.ref}`;
    if (e.source?.ref && sources.has(sk)) errors.push(`misma fuente en dos instituciones: ${sk}`);
    sources.set(sk, e);
    for (const c of e.campuses) {
      if (campusSlugs.has(c.slug)) errors.push(`slug de campus duplicado: ${c.slug}`);
      campusSlugs.set(c.slug, c);
      if (campusNames.has(c.name)) errors.push(`nombre de campus duplicado: ${c.name}`);
      campusNames.set(c.name, c);
    }
  }
  const seenDomains = new Set();
  for (const d of domains) {
    errors.push(...validateDomainEntry(d));
    const n = normalizeDomain(d.domain);
    if (seenDomains.has(n)) errors.push(`dominio duplicado: ${d.domain}`);
    seenDomains.add(n);
    if (!slugs.has(d.university_slug)) errors.push(`${d.domain}: la institución ${d.university_slug} no está en el catálogo`);
  }
  return { errors, skipped };
}

/** Lo que haría la importación contra una foto de la base. */
export function diffAgainstSnapshot(catalog, domains, snapshot, overrides) {
  const report = {
    universities: { inserted: 0, updated: 0, unchanged: 0, conflicted: 0, skipped: 0 },
    campuses: { inserted: 0, updated: 0, unchanged: 0, conflicted: 0, skipped: 0 },
    domains: { inserted: 0, updated: 0, unchanged: 0, conflicted: 0, skipped: 0 },
    conflicts: [],
  };
  const uBySlug = new Map((snapshot.universities ?? []).map((u) => [u.slug, u]));
  const iBySlug = new Map((snapshot.institutions ?? []).map((i) => [i.slug, i]));
  const dByDomain = new Map((snapshot.domains ?? []).map((d) => [d.domain, d]));
  const pinnedU = new Map(overrides.existing.universities.map((u) => [u.slug, u.id]));
  const pinnedI = new Map(overrides.existing.institutions.map((i) => [i.slug, i.id]));

  const conflict = (kind, msg) => { report[kind].conflicted++; report.conflicts.push(msg); };

  for (const e of catalog.institutions) {
    const cur = uBySlug.get(e.slug);
    if (!cur) {
      const sameName = (snapshot.universities ?? []).find((u) => u.country_code === e.country_code && fold(u.name) === fold(e.name));
      if (sameName) conflict('universities', `${e.slug}: ya existe "${e.name}" con slug ${sameName.slug}`);
      else report.universities.inserted++;
    } else if (cur.country_code !== e.country_code) {
      conflict('universities', `${e.slug}: existe en ${cur.country_code}, el catálogo dice ${e.country_code}`);
    } else if (pinnedU.has(e.slug) && pinnedU.get(e.slug) !== cur.id) {
      conflict('universities', `${e.slug}: el id cambiaría (${cur.id} -> ${pinnedU.get(e.slug)})`);
    } else {
      const next = {
        name: e.preserve ? cur.name : e.name,
        short_name: e.preserve ? (cur.short_name ?? e.short_name) : e.short_name,
        institution_type: e.institution_type,
        city: cur.city ?? e.city,
        state_region: cur.state_region ?? e.state_region,
      };
      const changed = Object.keys(next).some((k) => (next[k] ?? null) !== (cur[k] ?? null));
      report.universities[changed ? 'updated' : 'unchanged']++;
    }
    for (const c of e.campuses) {
      const ci = iBySlug.get(c.slug);
      if (!ci) {
        if ((snapshot.institutions ?? []).some((x) => x.name === c.name)) conflict('campuses', `${c.slug}: el nombre "${c.name}" ya lo usa otro campus`);
        else report.campuses.inserted++;
      } else if (ci.university_slug && ci.university_slug !== e.slug) {
        conflict('campuses', `${c.slug}: pasaría de ${ci.university_slug} a ${e.slug}`);
      } else if (pinnedI.has(c.slug) && pinnedI.get(c.slug) !== ci.id) {
        conflict('campuses', `${c.slug}: el id cambiaría`);
      } else {
        const changed = ci.university_slug !== e.slug || (ci.campus_slug ?? null) !== (ci.campus_slug ?? c.campus_slug)
          || (ci.campus_name ?? null) !== (ci.campus_name ?? c.campus_name ?? null) || (ci.city ?? null) !== (ci.city ?? c.city ?? null);
        report.campuses[changed ? 'updated' : 'unchanged']++;
      }
    }
  }
  for (const d of domains) {
    const cur = dByDomain.get(d.domain);
    if (!cur) report.domains.inserted++;
    else if (cur.university_slug !== d.university_slug) conflict('domains', `${d.domain}: pertenece a ${cur.university_slug}, el archivo dice ${d.university_slug}`);
    else {
      const changed = ['audience', 'confidence', 'verification_enabled'].some((k) => cur[k] !== d[k]) || cur.is_active !== (d.is_active ?? true);
      report.domains[changed ? 'updated' : 'unchanged']++;
    }
  }
  return report;
}

// ------------------------------------------------------------------ SQL
const q = sqlLiteral;

export function buildMigrationSql(catalog, domains, overrides) {
  const out = [];
  const p = (s = '') => out.push(s);
  p('-- ============================================================');
  p('-- Catalogo de instituciones: datos (GENERADO, no editar a mano)');
  p('--');
  p('-- Generado por scripts/import-institutions/import.mjs a partir de');
  p('-- scripts/import-institutions/data/catalog.json y email-domains.json.');
  p('-- Fuentes: SEP formato 911 (MX), SNIES del MEN (CO), IPEDS/NCES (US).');
  p('--');
  p('-- Upsert por slug; nunca borra. Falla si un id conocido cambiaria, si un');
  p('-- campus cambiaria de institucion o si algun perfil o evento cambia de');
  p('-- campus. En los registros que ya existian solo rellena lo vacio.');
  p('-- Requiere 20260917000000_verificacion-institucional.sql.');
  p('-- ============================================================');
  p();
  p('BEGIN;');
  p();
  p('CREATE TEMP TABLE _before_profiles ON COMMIT DROP AS');
  p('  SELECT campus_id, count(*) AS n FROM public.profiles GROUP BY campus_id;');
  p('CREATE TEMP TABLE _before_events ON COMMIT DROP AS');
  p('  SELECT institution_id, count(*) AS n FROM public.events GROUP BY institution_id;');
  p();
  p('-- 1. Ids que no pueden cambiar');
  p('DO $$');
  p('BEGIN');
  for (const u of overrides.existing.universities) {
    p(`  IF EXISTS (SELECT 1 FROM public.universities WHERE slug = ${q(u.slug)} AND id <> ${q(u.id)}) THEN`);
    p(`    RAISE EXCEPTION 'ID_CHANGED universities.${u.slug}';`);
    p('  END IF;');
  }
  for (const i of overrides.existing.institutions) {
    p(`  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = ${q(i.slug)} AND id <> ${q(i.id)}) THEN`);
    p(`    RAISE EXCEPTION 'ID_CHANGED institutions.${i.slug}';`);
    p('  END IF;');
  }
  p('END $$;');
  p();

  p('-- 2. Instituciones');
  p('CREATE TEMP TABLE _u (slug text, country_code text, name text, short_name text, institution_type text, control text,');
  p('  state_region text, city text, website_url text, aliases text[], source_name text, source_ref text, source_url text,');
  p('  source_checked_at date, preserve boolean) ON COMMIT DROP;');
  p('INSERT INTO _u VALUES');
  p(catalog.institutions.map((e) => `  (${[e.slug, e.country_code, e.name, e.short_name, e.institution_type, e.control, e.state_region, e.city,
    e.website_url, e.aliases ?? [], e.source?.name, e.source?.ref, e.source?.url, e.source?.checked_at].map(q).join(', ')}, ${q(Boolean(e.preserve))})`).join(',\n') + ';');
  p();
  p('DO $$');
  p('BEGIN');
  p('  IF EXISTS (SELECT 1 FROM _u JOIN public.universities u USING (slug) WHERE u.country_code <> _u.country_code) THEN');
  p("    RAISE EXCEPTION 'SLUG_COUNTRY_CONFLICT';");
  p('  END IF;');
  p('END $$;');
  p();
  p('CREATE TEMP TABLE _report (entity text, action text, n integer) ON COMMIT DROP;');
  p();
  p('WITH upd AS (');
  p('  UPDATE public.universities u SET');
  p('    name             = CASE WHEN s.preserve THEN u.name ELSE s.name END,');
  p('    short_name       = CASE WHEN s.preserve THEN coalesce(u.short_name, s.short_name) ELSE s.short_name END,');
  p('    institution_type = s.institution_type,');
  p('    control          = coalesce(u.control, s.control),');
  p('    state_region     = CASE WHEN s.preserve THEN coalesce(u.state_region, s.state_region) ELSE s.state_region END,');
  p('    city             = CASE WHEN s.preserve THEN coalesce(u.city, s.city) ELSE s.city END,');
  p('    website_url      = coalesce(u.website_url, s.website_url),');
  p('    aliases          = ARRAY(SELECT DISTINCT a FROM unnest(u.aliases || s.aliases) a ORDER BY a),');
  p('    source_name = s.source_name, source_ref = s.source_ref, source_url = s.source_url,');
  p('    source_checked_at = s.source_checked_at');
  p('  FROM _u s');
  p('  WHERE u.slug = s.slug');
  p('    AND (u.name, u.short_name, u.institution_type, u.control, u.state_region, u.city, u.website_url, u.source_ref, u.source_checked_at)');
  p('        IS DISTINCT FROM');
  p('        (CASE WHEN s.preserve THEN u.name ELSE s.name END,');
  p('         CASE WHEN s.preserve THEN coalesce(u.short_name, s.short_name) ELSE s.short_name END,');
  p('         s.institution_type, coalesce(u.control, s.control),');
  p('         CASE WHEN s.preserve THEN coalesce(u.state_region, s.state_region) ELSE s.state_region END,');
  p('         CASE WHEN s.preserve THEN coalesce(u.city, s.city) ELSE s.city END,');
  p('         coalesce(u.website_url, s.website_url), s.source_ref, s.source_checked_at)');
  p('  RETURNING 1');
  p(') INSERT INTO _report SELECT \'universities\', \'updated\', count(*) FROM upd;');
  p();
  p('WITH ins AS (');
  p('  INSERT INTO public.universities (slug, country_code, name, short_name, institution_type, control, state_region, city,');
  p('    website_url, aliases, source_name, source_ref, source_url, source_checked_at, email_domains, is_active)');
  p("  SELECT s.slug, s.country_code, s.name, s.short_name, s.institution_type, s.control, s.state_region, s.city,");
  p("    s.website_url, s.aliases, s.source_name, s.source_ref, s.source_url, s.source_checked_at, '{}', true");
  p('  FROM _u s');
  p('  WHERE NOT EXISTS (SELECT 1 FROM public.universities u WHERE u.slug = s.slug)');
  p('  RETURNING 1');
  p(') INSERT INTO _report SELECT \'universities\', \'inserted\', count(*) FROM ins;');
  p('INSERT INTO _report SELECT \'universities\', \'in_catalog\', count(*) FROM _u;');
  p();

  p('-- 3. Campus');
  p('CREATE TEMP TABLE _c (slug text, university_slug text, campus_slug text, name text, campus_name text, city text,');
  p('  state_region text, lat double precision, lng double precision, preserve boolean) ON COMMIT DROP;');
  p('INSERT INTO _c VALUES');
  const rows = [];
  for (const e of catalog.institutions) {
    for (const c of e.campuses) {
      rows.push(`  (${[c.slug, e.slug, c.campus_slug, c.name, c.campus_name, c.city, c.state_region].map(q).join(', ')}, ${q(c.lat ?? null)}, ${q(c.lng ?? null)}, ${q(Boolean(c.preserve))})`);
    }
  }
  p(rows.join(',\n') + ';');
  p();
  p('DO $$');
  p('BEGIN');
  p('  IF EXISTS (');
  p('    SELECT 1 FROM _c JOIN public.institutions i USING (slug) JOIN public.universities u ON u.slug = _c.university_slug');
  p('    WHERE i.university_id IS NOT NULL AND i.university_id <> u.id');
  p('  ) THEN');
  p("    RAISE EXCEPTION 'CAMPUS_REPARENT';");
  p('  END IF;');
  p('END $$;');
  p();
  p('WITH upd AS (');
  p('  UPDATE public.institutions i SET');
  p('    university_id = u.id,');
  p('    campus_slug   = coalesce(i.campus_slug, s.campus_slug),');
  p('    name          = CASE WHEN s.preserve THEN i.name ELSE s.name END,');
  p('    campus_name   = CASE WHEN s.preserve THEN coalesce(i.campus_name, s.campus_name) ELSE s.campus_name END,');
  p('    city          = coalesce(i.city, s.city),');
  p('    state_region  = coalesce(i.state_region, s.state_region),');
  p('    lat           = coalesce(i.lat, s.lat),');
  p('    lng           = coalesce(i.lng, s.lng)');
  p('  FROM _c s JOIN public.universities u ON u.slug = s.university_slug');
  p('  WHERE i.slug = s.slug');
  p('    AND (i.university_id, i.campus_slug, i.name, i.campus_name, i.city, i.state_region, i.lat, i.lng)');
  p('        IS DISTINCT FROM');
  p('        (u.id, coalesce(i.campus_slug, s.campus_slug), CASE WHEN s.preserve THEN i.name ELSE s.name END,');
  p('         CASE WHEN s.preserve THEN coalesce(i.campus_name, s.campus_name) ELSE s.campus_name END,');
  p('         coalesce(i.city, s.city), coalesce(i.state_region, s.state_region), coalesce(i.lat, s.lat), coalesce(i.lng, s.lng))');
  p('  RETURNING 1');
  p(') INSERT INTO _report SELECT \'campuses\', \'updated\', count(*) FROM upd;');
  p();
  p('WITH ins AS (');
  p('  INSERT INTO public.institutions (slug, name, university_id, campus_slug, campus_name, city, state_region, lat, lng, email_domains, is_active)');
  p("  SELECT s.slug, s.name, u.id, s.campus_slug, s.campus_name, s.city, s.state_region, s.lat, s.lng, '{}', true");
  p('  FROM _c s JOIN public.universities u ON u.slug = s.university_slug');
  p('  WHERE NOT EXISTS (SELECT 1 FROM public.institutions i WHERE i.slug = s.slug)');
  p('  RETURNING 1');
  p(') INSERT INTO _report SELECT \'campuses\', \'inserted\', count(*) FROM ins;');
  p();

  p('-- 4. Dominios de correo (con evidencia)');
  p('CREATE TEMP TABLE _d (domain text, university_slug text, campus_slug text, audience text, confidence text,');
  p('  verification_enabled boolean, official_source_url text, source_title text, last_verified_at date, notes text,');
  p('  is_active boolean, student_id_pattern text) ON COMMIT DROP;');
  p('INSERT INTO _d VALUES');
  p(domains.map((d) => `  (${[normalizeDomain(d.domain), d.university_slug, d.campus_slug ?? null, d.audience, d.confidence].map(q).join(', ')}, ${q(Boolean(d.verification_enabled))}, ${[d.official_source_url ?? null, d.source_title ?? null, d.last_verified_at ?? null, d.notes ?? null].map(q).join(', ')}, ${q(d.is_active ?? true)}, ${q(d.student_id_pattern ?? null)})`).join(',\n') + ';');
  p();
  p('DO $$');
  p('BEGIN');
  p('  IF EXISTS (SELECT 1 FROM _d JOIN public.institution_email_domains d USING (domain) JOIN public.universities u ON u.slug = _d.university_slug');
  p('             WHERE d.university_id <> u.id) THEN');
  p("    RAISE EXCEPTION 'DOMAIN_REPARENT';");
  p('  END IF;');
  p('END $$;');
  p();
  p('WITH up AS (');
  p('  INSERT INTO public.institution_email_domains (domain, university_id, campus_id, audience, confidence, verification_enabled,');
  p('    official_source_url, source_title, last_verified_at, notes, is_active, student_id_pattern)');
  p('  SELECT s.domain, u.id, c.id, s.audience, s.confidence, s.verification_enabled, s.official_source_url, s.source_title,');
  p('    s.last_verified_at, s.notes, s.is_active, s.student_id_pattern');
  p('  FROM _d s JOIN public.universities u ON u.slug = s.university_slug');
  p('  LEFT JOIN public.institutions c ON c.slug = s.campus_slug');
  p('  ON CONFLICT (domain) DO UPDATE SET');
  p('    campus_id = EXCLUDED.campus_id, audience = EXCLUDED.audience, confidence = EXCLUDED.confidence,');
  p('    verification_enabled = EXCLUDED.verification_enabled, official_source_url = EXCLUDED.official_source_url,');
  p('    source_title = EXCLUDED.source_title, last_verified_at = EXCLUDED.last_verified_at, notes = EXCLUDED.notes,');
  p('    is_active = EXCLUDED.is_active, student_id_pattern = EXCLUDED.student_id_pattern');
  p('  WHERE (institution_email_domains.campus_id, institution_email_domains.audience, institution_email_domains.confidence,');
  p('         institution_email_domains.verification_enabled, institution_email_domains.official_source_url,');
  p('         institution_email_domains.is_active, institution_email_domains.student_id_pattern, institution_email_domains.notes)');
  p('    IS DISTINCT FROM (EXCLUDED.campus_id, EXCLUDED.audience, EXCLUDED.confidence, EXCLUDED.verification_enabled,');
  p('         EXCLUDED.official_source_url, EXCLUDED.is_active, EXCLUDED.student_id_pattern, EXCLUDED.notes)');
  p('  RETURNING (xmax = 0) AS inserted');
  p(') INSERT INTO _report SELECT \'domains\', CASE WHEN inserted THEN \'inserted\' ELSE \'updated\' END, count(*) FROM up GROUP BY inserted;');
  p();

  p('-- 5. Nadie cambio de campus');
  p('DO $$');
  p('BEGIN');
  p('  IF EXISTS (');
  p('    (SELECT campus_id, count(*) FROM public.profiles GROUP BY campus_id EXCEPT SELECT campus_id, n FROM _before_profiles)');
  p('    UNION ALL');
  p('    (SELECT campus_id, n FROM _before_profiles EXCEPT SELECT campus_id, count(*) FROM public.profiles GROUP BY campus_id)');
  p('  ) THEN');
  p("    RAISE EXCEPTION 'PROFILES_REASSIGNED';");
  p('  END IF;');
  p('  IF EXISTS (');
  p('    (SELECT institution_id, count(*) FROM public.events GROUP BY institution_id EXCEPT SELECT institution_id, n FROM _before_events)');
  p('    UNION ALL');
  p('    (SELECT institution_id, n FROM _before_events EXCEPT SELECT institution_id, count(*) FROM public.events GROUP BY institution_id)');
  p('  ) THEN');
  p("    RAISE EXCEPTION 'EVENTS_REASSIGNED';");
  p('  END IF;');
  p('END $$;');
  p();
  p('-- Reporte (el SQL Editor muestra este resultado)');
  p("SELECT entity, action, sum(n) AS n FROM _report GROUP BY entity, action ORDER BY entity, action;");
  p();
  p('COMMIT;');
  return `${out.join('\n')}\n`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--print-snapshot-sql')) {
    console.log(SNAPSHOT_SQL);
    return;
  }
  const dryRun = args.includes('--dry-run');
  const snapIdx = args.indexOf('--snapshot');
  const { catalog, domains, overrides } = loadInputs();
  const { errors, skipped } = validateCatalog(catalog, domains);
  const counts = catalog.institutions.reduce((acc, e) => ({ ...acc, [e.country_code]: (acc[e.country_code] ?? 0) + 1 }), {});
  console.log(`Catálogo: ${catalog.institutions.length} instituciones ${JSON.stringify(counts)}, ${catalog.institutions.reduce((s, e) => s + e.campuses.length, 0)} campus, ${domains.length} dominios (${domains.filter((d) => d.verification_enabled).length} verifican).`);
  if (skipped.length) console.log(`skipped (${skipped.length}):\n  ${skipped.join('\n  ')}`);
  if (errors.length) {
    console.error(`Errores de validación:\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }

  const snapshotPath = snapIdx >= 0 ? args[snapIdx + 1] : join(DATA, 'production-snapshot.json');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  const report = diffAgainstSnapshot(catalog, domains, snapshot, overrides);
  for (const k of ['universities', 'campuses', 'domains']) {
    const r = report[k];
    console.log(`${k.padEnd(13)} inserted ${r.inserted}  updated ${r.updated}  unchanged ${r.unchanged}  conflicted ${r.conflicted}  skipped ${r.skipped}`);
  }
  if (report.conflicts.length) {
    console.error(`Conflictos:\n  ${report.conflicts.join('\n  ')}`);
    process.exit(1);
  }
  if (dryRun) {
    console.log('--dry-run: no se escribió nada.');
    return;
  }
  writeFileSync(MIGRATION_PATH, buildMigrationSql(catalog, domains, overrides));
  console.log(`Migración escrita: ${MIGRATION_PATH}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
