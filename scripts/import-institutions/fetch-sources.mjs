#!/usr/bin/env node
/**
 * Descarga los datasets oficiales que alimentan el catálogo de instituciones.
 *
 *   node scripts/import-institutions/fetch-sources.mjs [--only mx,co,us]
 *
 * Deja los archivos crudos en scripts/import-institutions/raw/ (no se suben al
 * repositorio: son grandes y se pueden volver a bajar). Lo que sí se versiona
 * es lo que sale de build-catalog.mjs.
 *
 * Fuentes:
 *   MX  SEP — Estadísticos del formato 911, educación superior escolarizada
 *       2023-2024, publicado en datos.gob.mx.
 *   CO  Ministerio de Educación Nacional — Instituciones de Educación Superior
 *       registradas en el SNIES, publicado en datos.gov.co (n5yy-8nav).
 *   US  U.S. Department of Education, NCES — IPEDS HD2023 (directorio de
 *       instituciones). Se usa IPEDS y no la API de College Scorecard porque
 *       la clave de demostración de esa API se agota en pocas peticiones.
 *
 * datos.gob.mx bloquea algunos clientes sin agente de navegador; por eso se
 * manda uno. Si aun así responde 403, descarga el CSV a mano desde la página
 * del dataset y déjalo en raw/ con el mismo nombre.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAW = join(dirname(fileURLToPath(import.meta.url)), 'raw');

export const SOURCES = {
  mx: {
    file: 'mx_sup_2023_2024.csv',
    title: 'SEP — Estadísticos del formato 911: educación superior escolarizada, ciclo 2023-2024',
    page: 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911',
    url: 'https://www.datos.gob.mx/dataset/59c589fe-c3cd-4134-9e0f-6b04fd9244c0/resource/ecd6b2d1-6698-4918-af23-6a122b6dd915/download/superior_escolarizada_2023-2024.csv',
  },
  co: {
    file: 'co_snies_ies.json',
    title: 'Ministerio de Educación Nacional — Instituciones de Educación Superior (SNIES)',
    page: 'https://www.datos.gov.co/d/n5yy-8nav',
    url: 'https://www.datos.gov.co/resource/n5yy-8nav.json?$limit=5000',
  },
  us: {
    file: 'us_ipeds_hd2023.csv',
    title: 'U.S. Department of Education, NCES — IPEDS Institutional Characteristics, Directory Information (HD2023)',
    page: 'https://nces.ed.gov/ipeds/datacenter/DataFiles.aspx',
    url: 'https://nces.ed.gov/ipeds/datacenter/data/HD2023.zip',
  },
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
  if (!res.ok) throw new Error(`${res.status} al descargar ${url}`);
  return as === 'json' ? res.json() : res.text();
}

async function fetchMx() {
  const csv = await get(SOURCES.mx.url);
  if (!csv.startsWith('cve_entidad')) throw new Error('El CSV de la SEP no tiene la cabecera esperada');
  await writeFile(join(RAW, SOURCES.mx.file), csv);
  return csv.split('\n').length - 1;
}

async function fetchCo() {
  const rows = await get(SOURCES.co.url, 'json');
  await writeFile(join(RAW, SOURCES.co.file), JSON.stringify(rows, null, 1));
  return rows.length;
}

async function fetchUs() {
  // IPEDS publica el directorio como ZIP con un CSV dentro. Se descomprime con
  // `unzip` del sistema para no anadir dependencias.
  const res = await fetch(SOURCES.us.url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} al descargar ${SOURCES.us.url}`);
  const zip = join(RAW, 'hd2023.zip');
  await writeFile(zip, Buffer.from(await res.arrayBuffer()));
  const { execFileSync } = await import('node:child_process');
  const csv = execFileSync('unzip', ['-p', zip, 'HD2023.csv'], { maxBuffer: 64 * 1024 * 1024 });
  await writeFile(join(RAW, SOURCES.us.file), csv);
  return csv.toString('latin1').split('\n').length - 1;
}

async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith('--only'));
  const only = onlyArg ? (onlyArg.split('=')[1] ?? process.argv[process.argv.indexOf(onlyArg) + 1]).split(',') : ['mx', 'co', 'us'];
  await mkdir(RAW, { recursive: true });
  const run = { mx: fetchMx, co: fetchCo, us: fetchUs };
  for (const c of only) {
    const n = await run[c]();
    console.log(`${c}: ${n} filas -> raw/${SOURCES[c].file}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
