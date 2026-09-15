/**
 * El catálogo de universidades y campus, tal como lo sirve la RPC
 * `campus_options` (ver 20260915000000_catalogo-universidades.sql).
 *
 * Aquí solo va lo que se puede probar sin pantallas: cómo se agrupa y cómo se
 * busca. Qué opciones existen y cuáles puede elegir cada quien lo decide la
 * base, no este archivo.
 */

export interface CampusOption {
  id: string;
  slug: string;
  name: string;
  campus_name: string | null;
  city: string | null;
  short_name: string | null;
  university_slug: string;
  university_name: string;
  university_short_name: string;
  country_code: string;
  /** El correo de quien pregunta ya acredita la universidad. */
  email_verified: boolean;
}

export interface CountryGroup {
  code: string;
  label: string;
  options: CampusOption[];
}

/**
 * Orden de los países en el selector. México primero porque es donde nació la
 * comunidad; el resto, en el orden en que se sumaron. Un país que no esté aquí
 * sale al final, por nombre, en vez de desaparecer.
 */
const COUNTRY_ORDER = ['MX', 'US', 'CO'];

/** Sin acentos y en minúsculas: "queretaro" tiene que encontrar "Querétaro". */
export const normalizeSearch = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/** Busca por nombre, abreviatura, ciudad o campus, y por la universidad. */
export function matchesQuery(option: CampusOption, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  return [
    option.name,
    option.short_name,
    option.campus_name,
    option.city,
    option.university_name,
    option.university_short_name,
  ].some((campo) => campo && normalizeSearch(campo).includes(q));
}

export function countryLabel(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function groupByCountry(options: CampusOption[], locale: string): CountryGroup[] {
  const grupos = new Map<string, CampusOption[]>();
  for (const o of options) {
    const lista = grupos.get(o.country_code) ?? [];
    lista.push(o);
    grupos.set(o.country_code, lista);
  }
  const rango = (c: string) => {
    const i = COUNTRY_ORDER.indexOf(c);
    return i === -1 ? COUNTRY_ORDER.length : i;
  };
  return [...grupos.entries()]
    .map(([code, lista]) => ({
      code,
      label: countryLabel(code, locale),
      // Dentro del país: por universidad y, dentro de ella, por campus.
      options: lista.slice().sort((a, b) =>
        a.university_name.localeCompare(b.university_name, locale)
        || (a.campus_name ?? '').localeCompare(b.campus_name ?? '', locale)),
    }))
    .sort((a, b) => rango(a.code) - rango(b.code) || a.label.localeCompare(b.label, locale));
}
