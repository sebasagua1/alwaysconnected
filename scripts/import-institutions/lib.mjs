/**
 * Utilidades puras del importador de instituciones. Sin acceso a disco ni a
 * red, para poder probarlas (src/test/institutionImport.test.ts).
 */

/** CSV con comillas dobles, comas dentro de comillas y saltos \r\n. */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"') {
        if (t[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const [header, ...body] = rows;
  return body.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i].trim()])));
}

/** Sin acentos, minúsculas y espacios simples: la forma de comparar nombres. */
export function fold(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}

export function slugify(s) {
  return fold(s).replace(/ñ/g, 'n').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Palabras que en los datasets oficiales llegan en mayúsculas y sin tilde.
 * Solo se corrige lo que es inequívoco en nombres de instituciones.
 */
const ACCENTS = Object.fromEntries(
  `autonoma:autónoma autonomo:autónomo tecnologico:tecnológico tecnologica:tecnológica tecnologicos:tecnológicos
  politecnica:politécnica politecnico:politécnico mexico:méxico queretaro:querétaro leon:león benemerita:benemérita
  benemerito:benemérito juarez:juárez michoacan:michoacán nicolas:nicolás potosi:potosí yucatan:yucatán merida:mérida
  tlahuac:tláhuac cancun:cancún obregon:obregón gutierrez:gutiérrez pedagogica:pedagógica pedagogico:pedagógico
  catolica:católica bogota:bogotá medellin:medellín cordoba:córdoba ibague:ibagué atlantico:atlántico quindio:quindío
  choco:chocó simon:simón bolivar:bolívar jose:josé maria:maría garcia:garcía ingenieria:ingeniería economicas:económicas
  economia:economía administracion:administración educacion:educación comunicacion:comunicación investigacion:investigación
  tecnica:técnica tecnicas:técnicas tecnico:técnico informatica:informática musica:música diseno:diseño peninsula:península
  america:américa americas:américas chimalhuacan:chimalhuacán jocotitlan:jocotitlán cuautitlan:cuautitlán tehuacan:tehuacán
  teziutlan:teziutlán zitacuaro:zitácuaro lazaro:lázaro cardenas:cárdenas culiacan:culiacán mazatlan:mazatlán
  minatitlan:minatitlán alamo:álamo andres:andrés calkini:calkiní zacualtipan:zacualtipán petatlan:petatlán
  cuauhtemoc:cuauhtémoc torreon:torreón acuna:acuña carbonifera:carbonífera region:región bajio:bajío rio:río
  marques:marqués colon:colón jauregui:jáuregui aeronautica:aeronáutica cristobal:cristóbal guzman:guzmán anahuac:anáhuac
  tecamac:tecámac tultitlan:tultitlán nezahualcoyotl:nezahualcóyotl atizapan:atizapán ejercito:ejército aerea:aérea
  antropologia:antropología estomatologia:estomatología purisima:purísima rincon:rincón indigena:indígena paraiso:paraíso
  cientifica:científica cientifico:científico academica:académica academico:académico politica:política juridicas:jurídicas
  criminologicas:criminológicas fisica:física quimica:química energia:energía agricola:agrícola odontologia:odontología
  psicologia:psicología filosofia:filosofía teologia:teología boyaca:boyacá sinu:sinú elias:elías pacifico:pacífico
  cucuta:cúcuta popayan:popayán monteria:montería quibdo:quibdó fusagasuga:fusagasugá chia:chía beltran:beltrán
  tomas:tomás arevalo:arévalo area:área patzcuaro:pátzcuaro apatzingan:apatzingán sonora:sonora estadistica:estadística
  matematicas:matemáticas cooperacion:cooperación formacion:formación enfermeria:enfermería medicas:médicas medica:médica
  fundacion:fundación corporacion:corporación chavez:chávez rene:rené hipocrates:hipócrates ecologia:ecología biologia:biología turistica:turística gastronomia:gastronomía`
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.split(':')),
);

const LOWER = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'en', 'el', 'a', 'al', 'para', 'por', 'con', 'of', 'and', 'the', 'at', 'in', 'for']);

/**
 * "UNIVERSIDAD AUTONOMA DE QUERETARO" -> "Universidad Autónoma de Querétaro".
 * `acronyms` son tokens que se dejan en mayúsculas (UNAM, IPN...).
 */
export function titleCase(raw, acronyms = new Set()) {
  const words = String(raw ?? '').trim().replace(/\s+/g, ' ').split(' ');
  return words
    .map((w, i) => {
      const core = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.]+$/gu, '');
      if (acronyms.has(core.toUpperCase())) return w.toUpperCase();
      const lower = w.toLowerCase();
      const coreLower = core.toLowerCase();
      const accented = ACCENTS[coreLower.normalize('NFD').replace(/[̀-ͯ]/g, '')];
      const word = accented && coreLower ? lower.replace(coreLower, accented) : lower;
      if (i > 0 && LOWER.has(coreLower)) return word;
      return word.replace(/\p{L}/u, (l) => l.toUpperCase()).replace(/-(\p{L})/gu, (_, l) => `-${l.toUpperCase()}`);
    })
    .join(' ');
}

/** Quita sufijos legales y de sede que no forman parte del nombre canónico. */
export function stripLegalSuffix(name) {
  return String(name)
    .replace(/,?\s*(A\.\s?C\.|S\.\s?C\.|S\.A\.( DE C\.V\.)?)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

export const INSTITUTION_TYPES = [
  'university', 'technological_university', 'polytechnic_university', 'technological_institute',
  'university_institution', 'technological_institution', 'technical_institution', 'college',
  'community_college', 'school', 'other',
];

/**
 * Dominio de correo normalizado: minúsculas, sin espacios ni punto final, IDN
 * en punycode. null si no es un hostname válido. Nunca "termina en".
 */
export function normalizeDomain(input) {
  const raw = String(input ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!raw || /[\s@/\\:]/.test(raw)) return null;
  let host;
  try {
    host = new URL(`http://${raw}`).hostname;
  } catch {
    return null;
  }
  if (host !== raw && host !== raw.normalize('NFC') && !host.includes('xn--')) return null;
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host) && host.length <= 253
    ? host
    : null;
}

/** Comprueba las reglas de un dominio del archivo curado. Devuelve errores. */
export function validateDomainEntry(d) {
  const errors = [];
  const domain = normalizeDomain(d.domain);
  if (!domain) errors.push(`dominio inválido: ${d.domain}`);
  if (!['student', 'faculty_staff', 'all_affiliates', 'alumni', 'unknown'].includes(d.audience)) errors.push(`${d.domain}: audience inválida`);
  if (!['confirmed', 'probable', 'unconfirmed'].includes(d.confidence)) errors.push(`${d.domain}: confidence inválida`);
  if (d.verification_enabled) {
    if (d.confidence !== 'confirmed') errors.push(`${d.domain}: solo un dominio confirmado puede verificar`);
    if (!['student', 'all_affiliates'].includes(d.audience)) errors.push(`${d.domain}: audiencia ${d.audience} no puede verificar`);
    if (!/^https:\/\//.test(d.official_source_url ?? '')) errors.push(`${d.domain}: falta la URL oficial`);
    if (!d.last_verified_at) errors.push(`${d.domain}: falta last_verified_at`);
    if (d.is_active === false) errors.push(`${d.domain}: inactivo no puede verificar`);
  }
  return errors;
}

/** Literal SQL seguro (comillas simples duplicadas, NULL). */
export function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (Array.isArray(v)) return `ARRAY[${v.map(sqlLiteral).join(', ')}]::text[]`;
  const s = String(v);
  // U&'' para que el archivo sea ASCII puro y se pueda pegar en el SQL Editor.
  if (/^[\x20-\x7e]*$/.test(s)) return `'${s.replace(/'/g, "''")}'`;
  const body = [...s]
    .map((ch) => {
      const cp = ch.codePointAt(0);
      if (ch === "'") return "''";
      if (ch === '\\') return '\\\\';
      if (cp >= 0x20 && cp <= 0x7e) return ch;
      return cp > 0xffff ? `\\+${cp.toString(16).padStart(6, '0').toUpperCase()}` : `\\${cp.toString(16).padStart(4, '0').toUpperCase()}`;
    })
    .join('');
  return `U&'${body}'`;
}
