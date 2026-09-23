/**
 * Supabase falso para la vista previa de la interfaz.
 *
 * Sustituye a `@/integrations/supabase/client` por un alias de Vite (ver
 * `vite.preview.config.ts`), así que la app corre ENTERA —rutas, stores,
 * AuthGate, GSAP, CSS— y lo único fingido es la red. Sirve para mirar
 * pantallas con sesión iniciada sin credenciales y sin tocar datos reales.
 *
 * NO se compila con la app: `tsconfig.app.json` solo incluye `src/`.
 *
 * ---------------------------------------------------------------------------
 * Cuatro cosas que cuesta descubrir a base de golpes, por si hay que ampliarlo:
 *
 * 1. `rpc()` NO devuelve una promesa, devuelve un builder encadenable.
 *    `usePeopleSearch` le cuelga `.abortSignal()` para cancelar la búsqueda
 *    anterior; con una promesa pelada revienta con "abortSignal is not a
 *    function" y la pantalla se queda vacía.
 *
 * 2. `order()` y `limit()` hay que implementarlos de verdad. GroupChat pide
 *    los últimos 40 en orden descendente y luego les da la vuelta: si el mock
 *    los ignora, el chat se pinta al revés y parece un fallo de la app.
 *
 * 3. Los nombres de campo tienen que ser los que lee el código, no los que
 *    uno supone. `friends_page` manda `total` en cada fila (sin él la
 *    cabecera pinta NaN), las solicitudes usan `friendship_id` (sin él React
 *    avisa de keys duplicadas) y el contador del centro de avisos lee
 *    `notifications_unread`.
 *
 * 4. El perfil usa `campus_id`, no `institution_id`. Con el campo mal, el
 *    mapa centra en el punto de respaldo y los marcadores quedan fuera de
 *    cuadro.
 *
 * Ante una pantalla vacía o un dato raro, sospechar primero de este archivo.
 * ---------------------------------------------------------------------------
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const YO = '11111111-1111-1111-1111-111111111111';
const ahora = Date.now();
/** Fecha a N horas de ahora (negativo = pasado). */
const iso = (h: number) => new Date(ahora + h * 3600e3).toISOString();

const NOMBRES = [
  'Lucía Fernández', 'Mateo Rojas', 'Valentina Ossa',
  'Tomás Iriarte', 'Camila Duarte', 'Nicolás Vega',
];
const persona = (i: number) => ({
  id: `u${i}`,
  name: NOMBRES[i % NOMBRES.length],
  avatar_url: null,
  major: ['Ingeniería', 'Derecho', 'Medicina', 'Diseño'][i % 4],
});

/** Centro del campus falso. Los eventos se reparten alrededor. */
const CAMPUS = { lat: 4.6315, lng: -74.0785 };

const EVENTOS = ([
  ['Repaso de Cálculo II antes del parcial', 'study', 2],
  ['Fútbol 5 en la cancha de atrás', 'sports', 5],
  ['Café y charla en el patio central', 'social', 27],
  ['Compras para el asado del viernes', 'shopping', 30],
  ['Voluntariado en el comedor', 'volunteering', 52],
  ['Grupo de Química Orgánica', 'study', 55],
  ['Vóley al atardecer', 'sports', -30],
] as Array<[string, string, number]>).map(([title, category, h], i) => ({
  id: `e${i}`,
  creator_id: i % 2 ? YO : 'u2',
  title,
  category,
  // En cuadrícula alrededor del campus: al zoom 15.5 caben todos en pantalla.
  lng: CAMPUS.lng + ((i % 3) - 1) * 0.0016,
  lat: CAMPUS.lat + (Math.floor(i / 3) - 1) * 0.0013,
  address: 'Campus norte, edificio B',
  description: 'Nos vemos en la entrada.',
  starts_at: iso(h),
  ends_at: iso(h + 2),
  max_spots: 10,
  current_spots: 3 + (i % 6),
  privacy: 'public',
  is_active: true,
}));

const MENSAJES = [
  '¿Alguien va a la biblioteca hoy?', 'Yo salgo a las 4', 'Dale, nos vemos allá',
  'Llevo los apuntes del parcial pasado', 'Perfecto, gracias', '¿En el tercer piso?',
  'Sí, en las mesas del fondo', 'Voy saliendo', 'Ya llegué, estoy sentado', 'Bajo en 5',
].map((content, i) => ({
  id: `m${i}`,
  content,
  created_at: iso(-3 + i * 0.2),
  sender_id: i % 3 === 0 ? YO : 'u2',
  edited_at: null,
  deleted_at: null,
}));

/** Una fila por tipo, para que el centro de avisos enseñe variedad. */
const AVISOS = ([
  ['friend_request', 'friend_requests', 0.4, null],
  ['event_message', 'activity_messages', 1.2, 'Fútbol 5 en la cancha de atrás'],
  ['chat_mention', 'mentions', 2.5, 'Repaso de Cálculo II'],
  ['join_request', 'event_requests', 5, 'Café y charla en el patio'],
  ['event_reminder', 'reminders', 9, 'Voluntariado en el comedor'],
  ['friend_accepted', 'friend_activity', 26, null],
  ['event_cancelled', 'event_updates', 32, 'Compras para el asado'],
  ['participant_joined', 'event_requests', 50, 'Vóley al atardecer'],
] as Array<[string, string, number, string | null]>).map(([type, category, h, titulo], i) => ({
  id: `n${i}`,
  type,
  category,
  count: i === 1 ? 3 : 1,
  created_at: iso(-h),
  updated_at: iso(-h),
  // Los tres primeros sin leer: así se ve el fondo resaltado y el filtro
  // "sin leer" tiene algo que enseñar.
  read_at: i < 3 ? null : iso(-h + 0.5),
  data: {},
  actor_id: `u${i % 6}`,
  actor_name: NOMBRES[i % NOMBRES.length],
  actor_avatar: null,
  event_id: titulo ? `e${i}` : null,
  event_title: titulo,
  event_starts_at: titulo ? iso(4) : null,
  group_id: null,
  group_name: null,
  is_dm: false,
}));

/** Personas con las cuatro relaciones posibles, para ver todos los botones. */
const PERSONAS = Array.from({ length: 5 }, (_, i) => ({
  ...persona(i),
  relation: ['none', 'pending_out', 'friends', 'none', 'pending_in'][i],
  friendship_id: i === 2 ? 'f9' : null,
  mutual_friends: (i * 3) % 7,
  shared_groups: i % 3,
  in_contacts: i % 2 === 0,
}));

const TABLAS: Record<string, any[]> = {
  // campus_id y no institution_id: es lo que lee useInstitutionCenter.
  profiles: [{
    id: YO, name: 'Sebastián', avatar_url: null, major: 'Ingeniería',
    onboarding_completed: !(typeof location !== 'undefined' && location.search.includes('onboarding=1')),
    institution_id: 'i1', campus_id: 'i1',
  }],
  public_profiles: [
    { id: YO, name: 'Sebastián', avatar_url: null },
    ...Array.from({ length: 6 }, (_, i) => persona(i)),
  ],
  events: EVENTOS,
  event_participants: EVENTOS.slice(0, 4).map((e) => ({
    event_id: e.id, user_id: YO, events: e, approval_seen: true, approved_at: null,
  })),
  messages: MENSAJES,
  groups: [{ id: 'g1', name: 'Estudio Cálculo II' }],
  group_members: [],
  friendships: [],
  institutions: [{ id: 'i1', name: 'Universidad Nacional', ...CAMPUS }],
  // Vista de compatibilidad que consulta useInstitutionCenter.
  campuses: [{ id: 'i1', name: 'Universidad Nacional', ...CAMPUS }],
  notification_preferences: [],
  blocks: [],
  reports: [],
  badges: [],
  point_events: [],
};

/** Lo que devuelve cada RPC. Las que no estén aquí devuelven []. */
const RPC: Record<string, any> = {
  notification_counts: [{
    join_requests: 2, friend_requests: 1, unread_messages: 3, approvals: 1,
    group_invites: 0, event_chat_unread: 3, notifications_unread: 3,
  }],
  pending_requests_by_event: [{ event_id: 'e1', pending: 2 }],
  // `total` va en CADA fila: sin él la cabecera de amigos pinta NaN.
  friends_page: Array.from({ length: 6 }, (_, i) => ({
    ...persona(i), total: 6,
    last_message_at: iso(-i), last_content: 'Nos vemos allá', last_sender_id: `u${i}`,
  })),
  // friendship_id, no request_id: es la key de la lista de solicitudes.
  friend_requests_incoming: [{ ...persona(3), friendship_id: 'f1' }],
  chat_summaries: [{
    group_id: 'g1', name: 'Estudio Cálculo II',
    last_content: 'Bajo en 5', last_message_at: iso(-1), unread: 2,
  }],
  unread_by_group: [{ group_id: 'g1', unread: 2 }],
  my_institution_verification: [{ status: 'verified', institution_name: 'Universidad Nacional' }],
  my_notifications: AVISOS,
  search_people: PERSONAS,
  people_suggestions: PERSONAS,
  my_contact_settings: [{ contacts_enabled: true, discoverable: true, last_synced_at: iso(-20) }],
  my_invite_code: [{ code: 'SEBA-2026', uses: 3 }],
  event_chat_unread: [{ event_id: 'e1', unread: 3 }],
  leaderboard: [],
};

/** Cadena de consulta que se puede esperar en cualquier punto. */
function query(table: string) {
  let filas: any[] = (TABLAS[table] ?? []).slice();
  const o: any = {};
  const paso = () => o;
  for (const m of [
    'select', 'eq', 'in', 'lt', 'gt', 'gte', 'lte', 'neq', 'or', 'not',
    'range', 'ilike', 'contains', 'overlaps', 'insert', 'update', 'upsert', 'delete',
  ]) o[m] = paso;

  o.order = (col: string, opts: any = {}) => {
    const asc = opts.ascending !== false;
    filas = filas.slice().sort((a, b) =>
      (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
    return o;
  };
  o.limit = (n: number) => { filas = filas.slice(0, n); return o; };
  o.single = () => Promise.resolve({ data: filas[0] ?? null, error: null });
  o.maybeSingle = o.single;
  o.then = (res: any, rej: any) =>
    Promise.resolve({ data: filas, error: null, count: filas.length }).then(res, rej);
  return o;
}

/**
 * Callbacks de INSERT registrados por los chats. Permite inyectar un mensaje
 * entrante desde la consola o desde Playwright:
 *
 *     window.__entra('hola')        // de otra persona
 *     window.__entra('hola', true)  // tuyo
 *
 * Es lo único que permite comprobar de verdad que un mensaje ajeno no arranca
 * de la lectura a quien va desplazándose hacia arriba.
 */
const oyentes: any[] = [];
let siguienteId = 100;

const canal = () => {
  const c: any = {};
  c.on = (_tipo: string, cfg: any, cb: any) => {
    if (cfg?.event === 'INSERT') oyentes.push(cb);
    return c;
  };
  c.subscribe = () => c;
  c.unsubscribe = () => Promise.resolve('ok');
  return c;
};

(globalThis as any).__entra = (content: string, mio = false) => {
  const fila = {
    id: `m${siguienteId++}`, content, created_at: new Date().toISOString(),
    sender_id: mio ? YO : 'u2', edited_at: null, deleted_at: null,
  };
  oyentes.forEach((cb) => cb({ new: fila }));
  return fila.id;
};

const sesion = {
  access_token: 'falso', refresh_token: 'falso', expires_in: 3600, token_type: 'bearer',
  user: {
    id: YO, email: 'demo@ejemplo.com', app_metadata: {}, user_metadata: {},
    aud: 'authenticated', created_at: iso(-999),
  },
};

export const supabase: any = {
  from: (t: string) => query(t),

  // Builder encadenable, NO una promesa: ver la nota 1 de la cabecera.
  rpc: (name: string) => {
    const filas = RPC[name] ?? [];
    const o: any = {};
    for (const m of ['abortSignal', 'select', 'eq', 'in', 'order', 'limit', 'throwOnError'])
      o[m] = () => o;
    o.single = () => Promise.resolve({ data: filas[0] ?? null, error: null });
    o.maybeSingle = o.single;
    o.then = (res: any, rej: any) =>
      Promise.resolve({ data: filas, error: null }).then(res, rej);
    return o;
  },

  channel: canal,
  removeChannel: () => Promise.resolve('ok'),

  auth: {
    getSession: () => Promise.resolve({ data: { session: sesion }, error: null }),
    getUser: () => Promise.resolve({ data: { user: sesion.user }, error: null }),
    onAuthStateChange: (cb: any) => {
      setTimeout(() => cb('SIGNED_IN', sesion), 0);
      return { data: { subscription: { unsubscribe: () => {} } } };
    },
    signOut: () => Promise.resolve({ error: null }),
  },

  storage: {
    from: () => ({
      upload: async () => ({ data: null, error: null }),
      getPublicUrl: () => ({ data: { publicUrl: '' } }),
    }),
  },
  functions: { invoke: async () => ({ data: null, error: null }) },
};
