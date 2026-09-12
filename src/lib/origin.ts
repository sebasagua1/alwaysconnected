/**
 * De dónde es alguien que no vive en la ciudad del campus.
 *
 * Se guarda un solo valor en profiles.origin:
 *   - internacional -> código ISO de dos letras ('CO', 'US')
 *   - foráneo       -> nombre del estado ('Jalisco')
 *
 * Los códigos se traducen al vuelo con Intl.DisplayNames, así que no hace
 * falta mantener a mano la lista de países en cada idioma.
 */

export const MEXICO_STATES = [
  'Aguascalientes', 'Baja California', 'Baja California Sur', 'Campeche',
  'Chiapas', 'Chihuahua', 'Ciudad de México', 'Coahuila', 'Colima', 'Durango',
  'Estado de México', 'Guanajuato', 'Guerrero', 'Hidalgo', 'Jalisco',
  'Michoacán', 'Morelos', 'Nayarit', 'Nuevo León', 'Oaxaca', 'Puebla',
  'Querétaro', 'Quintana Roo', 'San Luis Potosí', 'Sinaloa', 'Sonora',
  'Tabasco', 'Tamaulipas', 'Tlaxcala', 'Veracruz', 'Yucatán', 'Zacatecas',
] as const;

/** ISO 3166-1 alpha-2, sin México: quien es internacional viene de fuera. */
export const COUNTRY_CODES = [
  'AD','AE','AF','AG','AL','AM','AO','AR','AT','AU','AZ','BA','BB','BD','BE',
  'BF','BG','BH','BI','BJ','BN','BO','BR','BS','BT','BW','BY','BZ','CA','CD',
  'CF','CG','CH','CI','CL','CM','CN','CO','CR','CU','CV','CY','CZ','DE','DJ',
  'DK','DM','DO','DZ','EC','EE','EG','ER','ES','ET','FI','FJ','FR','GA','GB',
  'GD','GE','GH','GM','GN','GQ','GR','GT','GW','GY','HN','HR','HT','HU','ID',
  'IE','IL','IN','IQ','IR','IS','IT','JM','JO','JP','KE','KG','KH','KI','KM',
  'KN','KP','KR','KW','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV',
  'LY','MA','MC','MD','ME','MG','MH','MK','ML','MM','MN','MR','MT','MU','MV',
  'MW','MY','MZ','NA','NE','NG','NI','NL','NO','NP','NR','NZ','OM','PA','PE',
  'PG','PH','PK','PL','PT','PW','PY','QA','RO','RS','RU','RW','SA','SB','SC',
  'SD','SE','SG','SI','SK','SL','SM','SN','SO','SR','SS','ST','SV','SY','SZ',
  'TD','TG','TH','TJ','TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG',
  'US','UY','UZ','VC','VE','VN','VU','WS','YE','ZA','ZM','ZW',
] as const;

const isCountryCode = (v: string) => /^[A-Z]{2}$/.test(v);

export type ResidenceType = 'local' | 'foraneo' | 'international';

/**
 * De dónde es alguien, deducido de su `origin`.
 *
 * `residence_type` y `origin` decían lo mismo con dos columnas, y podían
 * contradecirse —residencia «local» con origen «Jalisco»—. Ahora solo se
 * pregunta una vez y esto deriva la otra: es la misma distinción que ya hacía
 * formatOrigin, puesta donde se pueda reutilizar y probar.
 *
 * No hay ambigüedad posible: un código de país son dos letras mayúsculas y
 * ningún estado de México se llama así.
 */
export function residenceFromOrigin(origin: string | null | undefined): ResidenceType {
  if (!origin) return 'local';
  return isCountryCode(origin) ? 'international' : 'foraneo';
}

/** Nombre legible de un valor de profiles.origin, en el idioma que se pida. */
export function formatOrigin(value: string | null | undefined, lang: string): string | null {
  if (!value) return null;
  if (!isCountryCode(value)) return value; // ya es el nombre del estado
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(value) ?? value;
  } catch {
    // Intl.DisplayNames no está en todos los WebView antiguos.
    return value;
  }
}

/** Países ordenados alfabéticamente ya traducidos. */
export function countryList(lang: string): Array<{ code: string; name: string }> {
  return COUNTRY_CODES.map((code) => ({ code, name: formatOrigin(code, lang) ?? code }))
    .sort((a, b) => a.name.localeCompare(b.name, lang));
}
