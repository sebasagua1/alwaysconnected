// Los colores apuntan a las variables de index.css en vez de repetir el
// valor: antes el mismo color estaba escrito en tres sitios (aquí, en
// --cat-* y en tailwind.config), y el que mandaba era este, así que
// corregir el contraste en el CSS no cambiaba nada de lo que se ve.
// Se usan siempre como `style={{ background }}` sobre elementos del DOM,
// donde las variables sí resuelven.
//
// Se quitaron dos campos que no usaba nadie: `textOnColor` (el texto que
// va encima es siempre text-primary-foreground) y `twClass` (las clases
// bg-category-* existen en tailwind.config pero no se usaban).
export const EVENT_CATEGORIES = [
  { key: 'study',        label: 'categories.study',        color: 'hsl(var(--cat-study))' },
  { key: 'sports',       label: 'categories.sports',       color: 'hsl(var(--cat-sports))' },
  { key: 'social',       label: 'categories.social',       color: 'hsl(var(--cat-social))' },
  { key: 'shopping',     label: 'categories.shopping',     color: 'hsl(var(--cat-shopping))' },
  { key: 'volunteering', label: 'categories.volunteering', color: 'hsl(var(--cat-volunteering))' },
  { key: 'other',        label: 'categories.other',        color: 'hsl(var(--cat-other))' },
] as const;

export type EventCategory = typeof EVENT_CATEGORIES[number]['key'];

// Agrupados para que la pantalla de intereses se pueda ojear: 54 opciones
// sueltas serían un muro de chips. Los nombres originales se conservan tal
// cual: son los que ya están guardados en los perfiles existentes.
export const INTEREST_GROUPS = [
  { key: 'sports', items: ['Sports', 'Soccer', 'Basketball', 'Fitness', 'Running', 'Swimming', 'Tennis', 'Volleyball', 'Yoga', 'Climbing', 'Cycling', 'MartialArts'] },
  { key: 'arts', items: ['Music', 'Art', 'Photography', 'Dance', 'Theater', 'Writing', 'Design', 'Singing'] },
  { key: 'tech', items: ['Tech', 'Gaming', 'Robotics', 'AI', 'Startups', 'Coding'] },
  { key: 'social', items: ['Food', 'Cooking', 'Coffee', 'Travel', 'Volunteering', 'Parties', 'BoardGames', 'Karaoke', 'Pets'] },
  { key: 'culture', items: ['Reading', 'Movies', 'Series', 'Anime', 'Podcasts', 'History'] },
  { key: 'academic', items: ['StudyGroups', 'Debate', 'Languages', 'Science', 'Finance', 'Sustainability', 'Entrepreneurship'] },
  { key: 'outdoors', items: ['Hiking', 'Camping', 'Beach', 'Skating', 'Fishing', 'Astronomy'] },
] as const;

export const INTEREST_OPTIONS = INTEREST_GROUPS.flatMap(g => g.items as readonly string[]);

// Cada idioma en su propio idioma (endónimo), que es como se listan los
// idiomas en cualquier selector decente. El valor se guarda tal cual en
// profiles.languages y se pinta en crudo: NO hay clave de traducción detrás,
// así que cambiar uno de estos cambia también el dato guardado.
export const LANGUAGE_OPTIONS = [
  'Español', 'English', 'Français', 'Deutsch', 'Português', '中文', '日本語', '한국어',
] as const;

/** 1 a 12, para la rueda de semestre del alta y de editar perfil. */
export const SEMESTER_OPTIONS = Array.from({ length: 12 }, (_, i) => String(i + 1));

export const RESIDENCE_OPTIONS = [
  { key: 'local', label: 'residence.local' },
  { key: 'foraneo', label: 'residence.foraneo' },
  { key: 'international', label: 'residence.international' },
] as const;

export const BADGE_DEFINITIONS = [
  { type: 'organizer' },
  { type: 'explorer' },
  { type: 'study_buddy' },
  { type: 'team_player' },
  { type: 'streak_7' },
] as const;

export const POINTS = {
  JOIN_EVENT: 10,
  ORGANIZE_EVENT: 25,
  CHECK_IN: 15,
  RATE_EVENT: 5,
} as const;

/**
 * Respaldo del centro del mapa.
 *
 * El centro de verdad sale de la fila de la institución del usuario
 * (ver useInstitutionCenter). Esto es lo que se usa mientras esa consulta
 * va en camino, o si el usuario todavía no pertenece a ninguna.
 */
export const MAP_FALLBACK_CENTER = {
  lng: -100.4063,
  lat: 20.6134,
} as const;

// El mapa no hereda la clase .dark, así que el tema se le cambia a mano
// (ver el efecto de MapHome que escucha onColorSchemeChange).
export const MAPBOX_STYLE_LIGHT = 'mapbox://styles/mapbox/light-v11';
export const MAPBOX_STYLE_DARK  = 'mapbox://styles/mapbox/dark-v11';
