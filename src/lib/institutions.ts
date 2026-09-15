/**
 * El catálogo de instituciones tal como lo sirve la RPC `search_institutions`
 * (ver 20260917000000_verificacion-institucional.sql).
 *
 * Aquí solo va lo que se puede probar sin pantallas: cómo se describe cada
 * resultado. Qué opciones existen y cuáles puede elegir cada quien lo decide
 * la base, no este archivo.
 */
import type { TFunction } from 'i18next';
import type { Database } from '@/integrations/supabase/types';

export type InstitutionResult = Database['public']['Functions']['search_institutions']['Returns'][number];
export type VerificationState = Database['public']['Functions']['my_institution_verification']['Returns'][number];

export const INSTITUTION_TYPES = [
  'university', 'technological_university', 'polytechnic_university', 'technological_institute',
  'university_institution', 'technological_institution', 'technical_institution', 'college',
  'community_college', 'school', 'other',
] as const;

/** Países del catálogo, en el orden en que se ofrecen como filtro. */
export const CATALOG_COUNTRIES = ['MX', 'CO', 'US'] as const;

/** Sin acentos y en minúsculas: "queretaro" tiene que encontrar "Querétaro". */
export const normalizeSearch = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

export function countryLabel(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** "Universidad", "Community college", "Colegio"... Nunca llama universidad a una escuela. */
export function institutionTypeLabel(type: string | null | undefined, t: TFunction): string {
  const key = (INSTITUTION_TYPES as readonly string[]).includes(type ?? '') ? type : 'other';
  return t(`institutionTypes.${key}`);
}

/**
 * Las dos líneas de un resultado, para distinguir instituciones con nombres
 * parecidos: arriba el nombre (y el campus si la institución tiene varios),
 * abajo ciudad/estado, país y tipo.
 */
export function describeInstitution(r: InstitutionResult, t: TFunction, locale: string) {
  const title = r.campus_name && r.campus_count > 1
    ? `${r.university_name} — ${t('onboarding.campusLabel', { campus: r.campus_name })}`
    : r.university_name;
  const place = [r.campus_city ?? r.city, r.state_region].filter((p, i, a) => p && a.indexOf(p) === i).join(', ');
  const subtitle = [place, countryLabel(r.country_code, locale), institutionTypeLabel(r.institution_type, t)]
    .filter(Boolean)
    .join(' · ');
  return { title, subtitle };
}

/** La afiliación pública de un perfil: "Tecnológico de Monterrey · Campus Querétaro". */
export function formatAffiliation(
  p: { university_name?: string | null; campus_name?: string | null },
  t: TFunction,
): string | null {
  if (!p.university_name) return null;
  return p.campus_name ? `${p.university_name} · ${t('onboarding.campusLabel', { campus: p.campus_name })}` : p.university_name;
}

/** Lo que la tarjeta del perfil necesita decidir a partir del estado. */
export function verificationCardMode(v: VerificationState | null): 'verified' | 'pending' | 'review' | 'unverified' {
  if (!v) return 'unverified';
  if (v.status === 'verified') return 'verified';
  if (v.status === 'manual_review') return 'review';
  if (v.status === 'pending_email' && v.pending_email_masked) return 'pending';
  return 'unverified';
}
