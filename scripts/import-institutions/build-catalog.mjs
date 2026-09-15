#!/usr/bin/env node
/**
 * Construye data/catalog.json a partir de los datasets oficiales (raw/) y de
 * las correcciones curadas (data/overrides.json).
 *
 *   node scripts/import-institutions/build-catalog.mjs
 *
 * Criterios de selección (reproducibles, no rankings comerciales):
 *
 *   México (SEP 911, 2023-2024). Se agrupan las claves de una misma
 *   institución en varios estados como campus. Entran:
 *     - las autónomas con al menos 2,000 estudiantes;
 *     - en cada estado, las dos públicas no autónomas y las dos privadas con
 *       más matrícula en ese estado (tecnológicos, politécnicas, UT...);
 *     - las que ya existían en Always Connected.
 *     Se excluyen normales, unidades de la UPN, centros de actualización del
 *     magisterio y escuelas sueltas del IPN (el IPN entra como institución).
 *
 *   Colombia (SNIES). Todas las de carácter "Universidad" y las demás IES
 *   con acreditación de alta calidad; las seccionales son campus. Se excluyen
 *   las escuelas de formación militar y policial (acceso restringido).
 *
 *   Estados Unidos (IPEDS HD2023). Activas, que otorgan títulos y no lucrativas.
 *   En cada estado: las dos públicas de cuatro años más grandes (tamaño IPEDS,
 *   luego Carnegie R1/R2 y land-grant), la privada sin fines de lucro de
 *   cuatro años más grande y el community college público más grande.
 *
 *   Más las entradas manuales de overrides.json (Colegio Bolívar), y las que
 *   ya existían en producción, que conservan slug e id.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCSV, fold, slugify, titleCase, stripLegalSuffix, US_STATES } from './lib.mjs';
import { SOURCES } from './fetch-sources.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const RAW = join(DIR, 'raw');
const DATA = join(DIR, 'data');
const overrides = JSON.parse(readFileSync(join(DATA, 'overrides.json'), 'utf8'));
const CHECKED = overrides.checked_at;
const ACRONYMS = new Set(overrides.acronyms);

const EXISTING_BY_SOURCE = new Map(
  overrides.existing.universities.filter((u) => u.source_ref).map((u) => [`${u.country_code}:${u.source_ref}`, u]),
);

const report = { mx: {}, co: {}, us: {}, manual: 0 };

function applyNameOverride(country, key, entry) {
  const o = overrides.names[country]?.[key];
  if (o) {
    Object.assign(entry, o);
    if (o.name && !o.slug) entry.slug = slugify(o.name);
  }
  return entry;
}

/** "La Salle", "El Bosque": nombres propios que titleCase deja en minúscula. */
function fixProperNouns(name) {
  return overrides.proper_nouns.reduce((n, [from, to]) => n.replace(new RegExp(from, 'g'), to), name);
}

function pinExisting(entry) {
  const ex = EXISTING_BY_SOURCE.get(`${entry.country_code}:${entry.source.ref}`);
  if (ex) {
    entry.slug = ex.slug;
    entry.existing_id = ex.id;
    entry.preserve = true;
  }
  return entry;
}

// ------------------------------------------------------------------ México
function buildMx() {
  const rows = parseCSV(readFileSync(join(RAW, SOURCES.mx.file), 'utf8'));
  const exclude = new RegExp(overrides.mx.exclude, 'i');
  const perClave = new Map();
  for (const r of rows) {
    const alumnos = ['alumnos_tec_esc', 'alumnos_lic_esc', 'alum_pos_esc'].reduce((s, k) => s + (Number(r[k]) || 0), 0);
    const c = perClave.get(r.institucion) ?? {
      clave: r.institucion, raw: r.nombre_institucion, state: r.entidad_etq, subcontrol: r.c_subcontrol,
      control: r.control, alumnos: 0, municipios: new Map(),
    };
    c.alumnos += alumnos;
    c.municipios.set(r.municipio, (c.municipios.get(r.municipio) ?? 0) + alumnos);
    perClave.set(r.institucion, c);
  }

  // Nombre base: sin "RECTORIA DE LA", sin la sede, sin sufijos legales.
  const groupRules = overrides.mx.groups.map((g) => ({ ...g, re: new RegExp(g.match, 'i') }));
  const baseOf = (raw) => {
    for (const g of groupRules) if (g.re.test(raw)) return { key: g.key, campus: raw.match(/CAMPUS\s+(.+)$/i)?.[1] ?? raw.match(/UNIDAD\s+"?([^"]+)"?$/i)?.[1] ?? null };
    let name = stripLegalSuffix(raw.replace(/^RECTORIA DE (LA )?/i, '').replace(/["]/g, '').replace(/\.(CAMPUS|PLANTEL)\b/i, '. $1'));
    const m = name.match(/^(.*?)[,\s]+(?:CAMPUS|PLANTEL)\s+(.+)$/i);
    let campus = null;
    if (m) { name = stripLegalSuffix(m[1]); campus = m[2]; }
    return { key: fold(name), name, campus };
  };

  const groups = new Map();
  for (const c of perClave.values()) {
    if (c.alumnos === 0) continue;
    if (exclude.test(c.raw)) continue;
    const b = baseOf(c.raw);
    const g = groups.get(b.key) ?? { key: b.key, rawName: b.name ?? c.raw, claves: [] };
    g.claves.push({ ...c, campus: b.campus, municipio: [...c.municipios].sort((a, z) => z[1] - a[1])[0][0] });
    groups.set(b.key, g);
  }
  for (const g of groups.values()) {
    g.claves.sort((a, z) => z.alumnos - a.alumnos);
    g.total = g.claves.reduce((s, c) => s + c.alumnos, 0);
    g.main = g.claves[0];
    g.autonomous = g.claves.some((c) => c.subcontrol === 'AUTÓNOMO');
    g.private = g.main.control === 'PRIVADO';
  }

  const picked = new Map();
  const why = {};
  const take = (g, reason) => { if (!picked.has(g.key)) { picked.set(g.key, g); why[reason] = (why[reason] ?? 0) + 1; } };
  for (const key of overrides.mx.force) {
    const g = groups.get(key);
    if (!g) throw new Error(`MX forzada sin datos en la SEP: ${key}`);
    take(g, 'existente');
  }
  for (const g of groups.values()) if (g.autonomous && g.total >= 2000) take(g, 'autónoma');
  const states = [...new Set([...perClave.values()].map((c) => c.state))];
  for (const st of states) {
    const inState = [...groups.values()]
      .map((g) => ({ g, clave: g.claves.find((c) => c.state === st) }))
      .filter((x) => x.clave && x.clave.alumnos >= 1000)
      .sort((a, z) => z.clave.alumnos - a.clave.alumnos);
    inState.filter((x) => !x.g.private && !x.g.autonomous && !picked.has(x.g.key)).slice(0, 2).forEach((x) => take(x.g, 'pública por estado'));
    inState.filter((x) => x.g.private && !picked.has(x.g.key)).slice(0, 2).forEach((x) => take(x.g, 'privada por estado'));
  }

  const out = [];
  for (const g of picked.values()) {
    const main = g.main;
    const rawName = overrides.mx.group_names?.[g.key] ?? g.rawName;
    const paren = rawName.match(/^(.*?)\s*\(([A-Z]{2,8})\)\s*$/);
    const displayRaw = paren ? paren[1] : rawName;
    const entry = applyNameOverride('MX', g.key, {
      country_code: 'MX',
      slug: slugify(fixProperNouns(titleCase(displayRaw, ACRONYMS))),
      name: fixProperNouns(titleCase(displayRaw, ACRONYMS)),
      short_name: paren ? paren[2] : null,
      institution_type: mxType(displayRaw),
      control: g.private ? 'private' : 'public',
      state_region: main.state,
      city: main.state === 'Ciudad de México' ? 'Ciudad de México' : titleCase(main.municipio),
      website_url: null,
      aliases: [],
      source: { name: 'SEP-911', ref: main.clave, url: SOURCES.mx.page, title: SOURCES.mx.title, checked_at: CHECKED },
    });
    pinExisting(entry);
    const campusMin = overrides.mx.campus_min_students;
    const claves = g.claves.filter((c, i) => i === 0 || c.alumnos >= campusMin).slice(0, overrides.mx.max_campuses);
    const multi = claves.length > 1;
    entry.campuses = claves.map((c) => {
      const campusLabel = c.campus ? titleCase(c.campus.replace(/"/g, ''), ACRONYMS) : (c.state === 'Ciudad de México' ? 'Ciudad de México' : titleCase(c.municipio));
      return {
        campus_name: multi ? campusLabel : null,
        city: c.state === 'Ciudad de México' ? 'Ciudad de México' : titleCase(c.municipio),
        state_region: c.state,
        source_ref: c.clave,
      };
    });
    out.push(entry);
  }
  report.mx = { groups: groups.size, picked: out.length, why };
  return out;
}

function mxType(raw) {
  const n = fold(raw);
  if (/^universidad tecnologica/.test(n)) return 'technological_university';
  if (/^universidad politecnica/.test(n)) return 'polytechnic_university';
  if (/^(instituto tecnologico|tecnologico)/.test(n) && !/monterrey/.test(n)) return 'technological_institute';
  if (/universidad|politecnico nacional/.test(n)) return 'university';
  if (/instituto|centro|escuela|colegio/.test(n)) return 'university_institution';
  return 'other';
}

// ---------------------------------------------------------------- Colombia
function buildCo() {
  const rows = JSON.parse(readFileSync(join(RAW, SOURCES.co.file), 'utf8'));
  const exclude = new RegExp(overrides.co.exclude, 'i');
  const typeOf = { Universidad: 'university', 'Institución Universitaria/Escuela Tecnológica': 'university_institution', 'Institución Tecnológica': 'technological_institution', 'Institución Técnica Profesional': 'technical_institution' };
  const splitAcronym = (raw) => {
    const m = raw.match(/^(.*?)\s*[-–]\s*([A-ZÁÉÍÓÚÑ]{2,14})\s*-?\s*$/) || raw.match(/^(.*?)\s+-?([A-Z]{2,14})-$/);
    return m ? { name: m[1].replace(/[-\s]+$/, ''), acronym: m[2] } : { name: raw.replace(/-$/, ''), acronym: null };
  };
  const principals = rows.filter((r) => r.principal_seccional === 'Principal'
    && (r.car_cter_acad_mico === 'Universidad' || r.acreditada_alta_calidad === 'SI' || overrides.co.force.includes(r.c_digo_instituci_n))
    && !exclude.test(r.nombre_instituci_n));
  const out = principals.map((r) => {
    const { name, acronym } = splitAcronym(r.nombre_instituci_n.trim());
    const city = r.municipio_domicilio.replace(/, D\.C\.$/, '');
    const entry = applyNameOverride('CO', r.c_digo_instituci_n, {
      country_code: 'CO',
      slug: slugify(fixProperNouns(titleCase(name, ACRONYMS))),
      name: fixProperNouns(titleCase(name, ACRONYMS)),
      short_name: acronym,
      institution_type: typeOf[r.car_cter_acad_mico] ?? 'other',
      control: r.sector === 'Oficial' ? 'public' : 'private',
      state_region: r.departamento_domicilio,
      city,
      website_url: r.p_gina_web && !r.p_gina_web.includes('@') ? `https://${r.p_gina_web.replace(/^https?:\/\//, '').replace(/\/$/, '')}` : null,
      aliases: [],
      source: { name: 'SNIES', ref: r.c_digo_instituci_n, url: SOURCES.co.page, title: SOURCES.co.title, checked_at: CHECKED },
    });
    pinExisting(entry);
    const seccionales = rows.filter((s) => s.principal_seccional === 'Seccional' && fold(splitAcronym(s.nombre_instituci_n).name) === fold(name));
    const multi = seccionales.length > 0;
    entry.campuses = [
      { campus_name: multi ? city : null, city, state_region: r.departamento_domicilio, source_ref: r.c_digo_instituci_n },
      ...seccionales.map((s) => ({
        campus_name: s.municipio_domicilio.replace(/, D\.C\.$/, ''),
        city: s.municipio_domicilio.replace(/, D\.C\.$/, ''),
        state_region: s.departamento_domicilio,
        source_ref: s.c_digo_instituci_n,
      })),
    ];
    return entry;
  });
  report.co = { rows: rows.length, picked: out.length };
  return out;
}

// ----------------------------------------------------------- Estados Unidos
function buildUs() {
  const rows = parseCSV(readFileSync(join(RAW, SOURCES.us.file), 'utf8'))
    .filter((r) => r.CYACTIVE === '1' && r.DEGGRANT === '1' && r.POSTSEC === '1' && r.CLOSEDAT === '-2' && US_STATES[r.STABBR]);
  const score = (r) => Number(r.INSTSIZE) * 10 + (r.C21BASIC === '15' ? 5 : r.C21BASIC === '16' ? 3 : 0) + (r.LANDGRNT === '1' ? 2 : 0);
  const bySector = (st, sector) => rows.filter((r) => r.STABBR === st && r.SECTOR === sector && Number(r.INSTSIZE) >= 2)
    .sort((a, z) => score(z) - score(a) || a.INSTNM.localeCompare(z.INSTNM));
  const picked = new Map();
  const force = new Set(overrides.us.force);
  rows.filter((r) => force.has(r.UNITID)).forEach((r) => picked.set(r.UNITID, r));
  for (const st of Object.keys(US_STATES)) {
    bySector(st, '1').filter((r) => !picked.has(r.UNITID)).slice(0, 2).forEach((r) => picked.set(r.UNITID, r));
    bySector(st, '2').filter((r) => !picked.has(r.UNITID)).slice(0, 1).forEach((r) => picked.set(r.UNITID, r));
    bySector(st, '4').filter((r) => !picked.has(r.UNITID)).slice(0, 1).forEach((r) => picked.set(r.UNITID, r));
  }
  const out = [...picked.values()].map((r) => {
    const name = overrides.us.name_replace.reduce((n, [from, to]) => n.replace(new RegExp(from), to), r.INSTNM).trim();
    const entry = applyNameOverride('US', r.UNITID, {
      country_code: 'US',
      slug: slugify(name),
      name,
      // IALIAS mezcla abreviaturas con apodos ("The U"): va a alias, que se
      // busca pero no se muestra.
      short_name: null,
      institution_type: r.SECTOR === '4' ? 'community_college' : /university|institute of technology|polytechnic/i.test(name) ? 'university' : 'college',
      control: r.CONTROL === '1' ? 'public' : 'private',
      state_region: US_STATES[r.STABBR],
      city: r.CITY,
      website_url: r.WEBADDR ? `https://${r.WEBADDR.replace(/^https?:\/\//, '').replace(/\/$/, '')}` : null,
      aliases: r.IALIAS ? r.IALIAS.split(/[,|;]/).map((a) => a.trim()).filter((a) => a && a.length <= 60).slice(0, 5) : [],
      source: { name: 'IPEDS', ref: r.UNITID, url: `https://nces.ed.gov/collegenavigator/?id=${r.UNITID}`, title: SOURCES.us.title, checked_at: CHECKED },
    });
    pinExisting(entry);
    const lat = Number(r.LATITUDE);
    const lng = Number(r.LONGITUD);
    entry.campuses = [{
      campus_name: null, city: r.CITY, state_region: US_STATES[r.STABBR], source_ref: r.UNITID,
      lat: Number.isFinite(lat) && lat !== 0 ? lat : null, lng: Number.isFinite(lng) && lng !== 0 ? lng : null,
    }];
    return entry;
  });
  report.us = { rows: rows.length, picked: out.length };
  return out;
}

// ---------------------------------------------------------------- Campus
/** Slugs de campus y la correspondencia con los campus que ya existen. */
function finishCampuses(entry) {
  const existingCampuses = overrides.existing.institutions.filter((i) => i.university_slug === entry.slug || i.attach_to === `${entry.country_code}:${entry.slug}`);
  const seen = new Set();
  entry.campuses = entry.campuses.map((c, i) => {
    let campusSlug = c.campus_name ? slugify(c.campus_name) : 'principal';
    while (seen.has(campusSlug)) campusSlug = `${campusSlug}-${i + 1}`;
    seen.add(campusSlug);
    const pin = existingCampuses.find((x) => x.source_ref === c.source_ref) ?? (i === 0 ? existingCampuses.find((x) => !x.source_ref) : null);
    return {
      ...c,
      campus_slug: pin?.campus_slug ?? campusSlug,
      slug: pin?.slug ?? (campusSlug === 'principal' ? entry.slug : `${entry.slug}-${campusSlug}`),
      name: pin?.name ?? (c.campus_name ? `${entry.name}, Campus ${c.campus_name}` : entry.name),
      campus_name: pin?.campus_name ?? c.campus_name,
      existing_id: pin?.id ?? null,
      preserve: Boolean(pin),
    };
  });
  // Campus que ya existían y no salen en el dataset: se conservan tal cual.
  for (const x of existingCampuses) {
    if (!entry.campuses.some((c) => c.existing_id === x.id)) {
      entry.campuses.push({ campus_slug: x.campus_slug, slug: x.slug, name: x.name, campus_name: x.campus_name, city: x.city, state_region: null, source_ref: null, existing_id: x.id, preserve: true });
    }
  }
  return entry;
}

function main() {
  const manual = overrides.manual.map((m) => ({ ...m, source: { ...m.source, checked_at: CHECKED } }));
  report.manual = manual.length;
  const all = [...buildMx(), ...buildCo(), ...buildUs(), ...manual];

  // Slugs únicos en todo el catálogo: si chocan entre países, sufijo de país.
  const bySlug = new Map();
  for (const e of all) {
    if (bySlug.has(e.slug) && !e.preserve) e.slug = `${e.slug}-${e.country_code.toLowerCase()}`;
    bySlug.set(e.slug, e);
  }
  all.forEach(finishCampuses);

  // institutions.name es UNIQUE: dos campus homónimos de países distintos
  // llevan el país entre paréntesis.
  const byName = new Map();
  for (const e of all) for (const c of e.campuses) {
    if (byName.has(c.name) && !c.preserve) c.name = `${c.name} (${e.country_code})`;
    byName.set(c.name, c);
  }
  all.sort((a, z) => a.country_code.localeCompare(z.country_code) || a.name.localeCompare(z.name, 'es'));
  const catalog = {
    generated_by: 'scripts/import-institutions/build-catalog.mjs',
    checked_at: CHECKED,
    sources: Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, { title: v.title, page: v.page }])),
    institutions: all,
  };
  writeFileSync(join(DATA, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  const counts = all.reduce((acc, e) => ({ ...acc, [e.country_code]: (acc[e.country_code] ?? 0) + 1 }), {});
  console.log(JSON.stringify({ report, counts, total: all.length, campuses: all.reduce((s, e) => s + e.campuses.length, 0) }, null, 2));
}

main();
