// @vitest-environment node
/**
 * El importador de instituciones y las utilidades de correo institucional.
 * Lo que se ejecuta en PGlite está en institutionVerification.sql.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  fold, slugify, titleCase, sqlLiteral, normalizeDomain, validateDomainEntry, parseCSV,
} from '../../scripts/import-institutions/lib.mjs';
import {
  loadInputs, validateCatalog, diffAgainstSnapshot, buildMigrationSql, MIGRATION_PATH,
} from '../../scripts/import-institutions/import.mjs';
import {
  normalizeInstitutionalEmail, isAppleRelayDomain, maskEmail, buildVerificationEmail, hashIp, clientIp,
} from '../../supabase/functions/_shared/institutionalEmail';

describe('correo institucional', () => {
  it('normaliza mayúsculas, espacios y punto final', () => {
    expect(normalizeInstitutionalEmail('  A01714719@TEC.MX. ')).toEqual({ ok: true, email: 'a01714719@tec.mx', domain: 'tec.mx' });
  });

  it('convierte un dominio IDN a punycode y rechaza lo que no es un correo', () => {
    const idn = normalizeInstitutionalEmail('ana@universität.de');
    expect(idn).toEqual({ ok: true, email: 'ana@xn--universitt-y5a.de', domain: 'xn--universitt-y5a.de' });
    for (const bad of ['', 'sin-arroba', 'a@b@tec.mx', 'a b@tec.mx', 'a@tec', 'a@tec..mx', '@tec.mx', 'a@-tec.mx', `${'x'.repeat(65)}@tec.mx`, 'a@tec.mx/evil', null]) {
      expect(normalizeInstitutionalEmail(bad).ok, String(bad)).toBe(false);
    }
  });

  it('reconoce los dos dominios de relay de Apple y ninguno más', () => {
    expect(isAppleRelayDomain('privaterelay.appleid.com')).toBe(true);
    expect(isAppleRelayDomain('PRIVATE.ICLOUD.COM')).toBe(true);
    expect(isAppleRelayDomain('icloud.com')).toBe(false);
    expect(isAppleRelayDomain('private.icloud.com.evil.com')).toBe(false);
  });

  it('enmascara el correo', () => {
    expect(maskEmail('sebastian@tec.mx')).toBe('s***@tec.mx');
  });

  it('el correo del código no lleva enlaces ni pide contraseñas', () => {
    const m = buildVerificationEmail({ code: '123456', appName: 'Always Connected', lang: 'es', minutes: 10 });
    expect(m.subject).toContain('123456');
    expect(m.html).not.toMatch(/<a\s|https?:\/\/|<img/i);
    expect(m.text).toMatch(/10 minutos/);
    expect(() => buildVerificationEmail({ code: '12<b>', appName: 'x', lang: 'en', minutes: 10 })).toThrow();
  });

  it('el hash de IP no contiene la IP y la primera de x-forwarded-for es la del cliente', async () => {
    const h = await hashIp('201.1.2.3', 'sal');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('201');
    expect(clientIp(new Headers({ 'x-forwarded-for': '201.1.2.3, 10.0.0.1' }))).toBe('201.1.2.3');
  });
});

describe('utilidades del importador', () => {
  it('title case en español con tildes y conectores', () => {
    expect(titleCase('UNIVERSIDAD AUTONOMA DE QUERETARO')).toBe('Universidad Autónoma de Querétaro');
    expect(titleCase('INSTITUTO TECNOLOGICO DE LA LAGUNA')).toBe('Instituto Tecnológico de la Laguna');
    expect(titleCase('UNIVERSIDAD TECNOLOGICA TULA-TEPEJI')).toBe('Universidad Tecnológica Tula-Tepeji');
    expect(titleCase('CENTRO UNIVERSITARIO UNE', new Set(['UNE']))).toBe('Centro Universitario UNE');
  });

  it('fold y slugify ignoran acentos y signos', () => {
    expect(fold('Bogotá, D.C.')).toBe('bogota d c');
    expect(slugify('Universidad de Nariño')).toBe('universidad-de-narino');
  });

  it('parseCSV maneja comillas, comas internas, BOM y espacios de relleno', () => {
    const rows = parseCSV('﻿a,b\r\n"x, y",  "z""w"  \r\n');
    expect(rows).toEqual([{ a: 'x, y', b: 'z"w' }]);
  });

  it('dominios: hostname exacto, nunca "termina en"', () => {
    expect(normalizeDomain('Comunidad.UNAM.mx.')).toBe('comunidad.unam.mx');
    expect(normalizeDomain('*.edu')).toBeNull();
    expect(normalizeDomain('edu')).toBeNull();
    expect(normalizeDomain('tec.mx/x')).toBeNull();
  });

  it('un dominio solo puede verificar si está confirmado, con fuente y audiencia vigente', () => {
    const base = { domain: 'x.edu', audience: 'student', confidence: 'confirmed', verification_enabled: true, official_source_url: 'https://x.edu/it', last_verified_at: '2026-09-14' };
    expect(validateDomainEntry(base)).toEqual([]);
    expect(validateDomainEntry({ ...base, confidence: 'probable' })).not.toEqual([]);
    expect(validateDomainEntry({ ...base, audience: 'alumni' })).not.toEqual([]);
    expect(validateDomainEntry({ ...base, official_source_url: undefined })).not.toEqual([]);
    expect(validateDomainEntry({ ...base, is_active: false })).not.toEqual([]);
    expect(validateDomainEntry({ ...base, verification_enabled: false, confidence: 'unconfirmed', official_source_url: undefined })).toEqual([]);
  });

  it('los literales SQL son ASCII y escapan comillas', () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
    expect(sqlLiteral('Bogotá')).toBe("U&'Bogot\\00E1'");
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(['a', 'b'])).toBe("ARRAY['a', 'b']::text[]");
  });
});

describe('catálogo curado', () => {
  const { catalog, domains, overrides } = loadInputs();

  it('valida sin errores: sin duplicados de slug, nombre, fuente ni campus', () => {
    const { errors, skipped } = validateCatalog(catalog, domains);
    expect(errors).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('tiene entre 300 y 500 instituciones con la distribución pedida', () => {
    const por = (c: string) => catalog.institutions.filter((e: { country_code: string }) => e.country_code === c).length;
    expect(catalog.institutions.length).toBeGreaterThanOrEqual(300);
    expect(catalog.institutions.length).toBeLessThanOrEqual(500);
    expect(por('MX')).toBeGreaterThanOrEqual(120);
    expect(por('MX')).toBeLessThanOrEqual(180);
    expect(por('CO')).toBeGreaterThanOrEqual(80);
    expect(por('CO')).toBeLessThanOrEqual(120);
    expect(por('US')).toBeGreaterThanOrEqual(150);
    expect(por('US')).toBeLessThanOrEqual(220);
  });

  it('incluye todas las instituciones y campus que ya existían, con su slug e id', () => {
    const campus = new Map(catalog.institutions.flatMap((e: { campuses: { slug: string; existing_id: string | null }[] }) => e.campuses.map((c) => [c.slug, c.existing_id])));
    for (const i of overrides.existing.institutions) expect(campus.get(i.slug), i.slug).toBe(i.id);
    const unis = new Map(catalog.institutions.map((e: { slug: string; existing_id?: string }) => [e.slug, e.existing_id]));
    for (const u of overrides.existing.universities) expect(unis.get(u.slug), u.slug).toBe(u.id);
  });

  it('Colegio Bolívar es escuela y tiene fuente oficial', () => {
    const b = catalog.institutions.find((e: { slug: string }) => e.slug === 'colegio-bolivar');
    expect(b).toMatchObject({ institution_type: 'school', country_code: 'CO', city: 'Cali' });
    expect(b.source.ref).toBe('376001001221');
  });

  it('solo verifican dominios confirmados; tec.mx y exatec.tec.mx no verifican', () => {
    const enabled = domains.filter((d: { verification_enabled: boolean }) => d.verification_enabled);
    expect(enabled.every((d: { confidence: string; official_source_url?: string }) => d.confidence === 'confirmed' && d.official_source_url?.startsWith('https://'))).toBe(true);
    const by = Object.fromEntries(domains.map((d: { domain: string }) => [d.domain, d]));
    expect(by['tec.mx'].verification_enabled).toBe(false);
    expect(by['exatec.tec.mx']).toMatchObject({ audience: 'alumni', verification_enabled: false });
    expect(by['my.fsu.edu'].verification_enabled).toBe(false);
    expect(by['fsu.edu'].verification_enabled).toBe(true);
    expect(domains.some((d: { domain: string }) => /appleid|icloud|gmail/.test(d.domain))).toBe(false);
  });
});

describe('dry-run contra una foto de la base', () => {
  const { catalog, domains, overrides } = loadInputs();
  const snapshot = JSON.parse(readFileSync(new URL('../../scripts/import-institutions/data/production-snapshot.json', import.meta.url), 'utf8'));

  it('contra producción: todo se inserta o actualiza, sin conflictos', () => {
    const r = diffAgainstSnapshot(catalog, domains, snapshot, overrides);
    expect(r.conflicts).toEqual([]);
    expect(r.universities.updated + r.universities.unchanged).toBe(6);
    expect(r.universities.inserted).toBe(catalog.institutions.length - 6);
  });

  it('una segunda pasada sobre lo ya importado no inserta nada', () => {
    const imported = {
      universities: catalog.institutions.map((e: Record<string, unknown>) => ({ ...e, id: e.existing_id ?? `new-${e.slug}` })),
      institutions: catalog.institutions.flatMap((e: { slug: string; campuses: Record<string, unknown>[] }) => e.campuses.map((c) => ({ ...c, id: c.existing_id ?? `new-${c.slug}`, university_slug: e.slug }))),
      domains: domains.map((d: Record<string, unknown>) => ({ ...d, is_active: d.is_active ?? true })),
    };
    const r = diffAgainstSnapshot(catalog, domains, imported, overrides);
    expect(r.universities.inserted + r.campuses.inserted + r.domains.inserted).toBe(0);
    expect(r.conflicts).toEqual([]);
  });

  it('marca conflicto si un id cambiaría, si un campus cambiaría de institución o si un nombre ya existe con otro slug', () => {
    const cambiado = structuredClone(snapshot);
    cambiado.universities.find((u: { slug: string }) => u.slug === 'tec').id = '00000000-0000-0000-0000-000000000000';
    cambiado.institutions.find((i: { slug: string }) => i.slug === 'tec-queretaro').university_slug = 'purdue';
    cambiado.universities.push({ slug: 'otra-unam', country_code: 'MX', name: 'Universidad Nacional Autónoma de México', id: 'x' });
    const r = diffAgainstSnapshot(catalog, domains, cambiado, overrides);
    expect(r.conflicts.some((c: string) => /tec: el id cambiaría/.test(c))).toBe(true);
    expect(r.conflicts.some((c: string) => /tec-queretaro: pasaría de purdue/.test(c))).toBe(true);
    expect(r.conflicts.some((c: string) => /ya existe "Universidad Nacional Autónoma de México"/.test(c))).toBe(true);
  });

  it('la migración de datos versionada está al día con el catálogo, es ASCII y nunca borra', () => {
    const generated = buildMigrationSql(catalog, domains, overrides);
    expect(readFileSync(MIGRATION_PATH, 'utf8')).toBe(generated);
    expect([...generated].every((ch) => ch === '\t' || ch === '\n' || ch === '\r' || (ch >= ' ' && ch <= '~'))).toBe(true);
    expect(generated).not.toMatch(/\bDELETE\s+FROM\b|\bDROP\s+TABLE\s+public\b|\bTRUNCATE\b/i);
    expect(generated).not.toMatch(/UPDATE\s+public\.profiles|UPDATE\s+public\.events/i);
  });
});
