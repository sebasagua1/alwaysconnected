-- ============================================================
-- Cuentas de auth.users SIN fila en public.profiles.
--
-- Se pega entero en el SQL Editor de Supabase y se ejecuta. NO cambia
-- nada: solo mira.
--
-- Por que importa: public.same_institution() resuelve la pertenencia
-- leyendo public.profiles. Sin perfil devuelve false siempre, asi que la
-- RLS de events, public_profiles y el chat dejan de mostrar a esa persona
-- lo de su propio campus. La app se ve medio vacia y no falla nada
-- visible: no hay error, no hay log, no hay nada.
--
-- Es UNA sola consulta a proposito: el SQL Editor solo ensena el
-- resultado de la ultima sentencia, asi que un script de seis SELECT deja
-- cinco resultados invisibles. Todo sale en la misma tabla.
--
-- Las columnas opcionales de auth.users (deleted_at, is_anonymous) se
-- leen via to_jsonb() porque no existen en todas las versiones de GoTrue
-- y referenciarlas directamente haria fallar la consulta entera.
-- ============================================================

WITH huerfanos AS (
  SELECT
    u.id,
    u.email,
    u.created_at,
    coalesce(nullif(u.raw_app_meta_data ->> 'provider', ''), '(sin provider)') AS proveedor,
    (to_jsonb(u) ->> 'deleted_at')   IS NOT NULL AS borrada,
    (to_jsonb(u) ->> 'is_anonymous') = 'true'    AS anonima
  FROM auth.users u
  WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)
)
SELECT bloque, detalle, cuentas, desde, hasta
FROM (

  -- ----------------------------------------------------------
  -- 1. El disparador. Si no existe o esta desactivado, no hay mas
  --    que mirar. Ojo con el modo: un trigger 'O' (el normal) NO corre
  --    cuando la sesion tiene session_replication_role = 'replica', que
  --    es como se restauran los backups y como importa datos el panel.
  --    Ese es el unico camino por el que un alta normal puede saltarselo.
  -- ----------------------------------------------------------
  SELECT 10 AS n, '1. Disparador' AS bloque,
         CASE
           WHEN t.tgname IS NULL  THEN 'on_auth_user_created NO EXISTE -- ninguna alta crea perfil'
           WHEN t.tgenabled = 'D' THEN 'on_auth_user_created existe pero esta DESACTIVADO'
           WHEN t.tgenabled = 'O' THEN 'on_auth_user_created activo (se salta con session_replication_role=replica)'
           WHEN t.tgenabled = 'A' THEN 'on_auth_user_created activo SIEMPRE (modo A, tampoco lo salta una restauracion)'
           ELSE 'on_auth_user_created en modo ' || t.tgenabled::text
         END AS detalle,
         NULL::bigint AS cuentas, NULL::timestamptz AS desde, NULL::timestamptz AS hasta
  FROM (SELECT 1) z
  LEFT JOIN pg_trigger t
    ON t.tgname = 'on_auth_user_created'
   AND t.tgrelid = 'auth.users'::regclass
   AND NOT t.tgisinternal

  UNION ALL
  SELECT 11, '1. Disparador',
         CASE
           WHEN p.oid IS NULL              THEN 'handle_new_user() NO EXISTE'
           WHEN p.prosrc LIKE '%ON CONFLICT%' THEN 'handle_new_user() endurecida: la migracion 20260920 esta aplicada'
           ELSE 'handle_new_user() sin ON CONFLICT: migracion 20260920 PENDIENTE'
         END,
         NULL, NULL, NULL
  FROM (SELECT 1) z
  LEFT JOIN pg_proc p
    ON p.proname = 'handle_new_user'
   AND p.pronamespace = 'public'::regnamespace

  -- ----------------------------------------------------------
  -- 2. Cuantas cuentas estan asi y desde cuando, por proveedor.
  --    El proveedor separa dos historias distintas: si solo salen
  --    'apple'/'google' apunta al alta social (correo ausente en el
  --    idToken); si sale de todo, apunta a algo que se salto el
  --    disparador para todas por igual (una restauracion).
  -- ----------------------------------------------------------
  UNION ALL
  SELECT 20, '2. Huerfanos por proveedor', h.proveedor,
         count(*), min(h.created_at), max(h.created_at)
  FROM huerfanos h
  GROUP BY h.proveedor

  -- ----------------------------------------------------------
  -- 3. Totales, para saber si es un caso raro o la mitad de la base.
  -- ----------------------------------------------------------
  UNION ALL
  SELECT 30, '3. Total', 'cuentas sin perfil',
         count(*), min(h.created_at), max(h.created_at)
  FROM huerfanos h

  UNION ALL
  SELECT 31, '3. Total', 'cuentas en auth.users',
         count(*), min(u.created_at), max(u.created_at)
  FROM auth.users u

  UNION ALL
  SELECT 32, '3. Total', 'filas en public.profiles',
         count(*), min(p.created_at), max(p.created_at)
  FROM public.profiles p

  -- ----------------------------------------------------------
  -- 4. Senales que distinguen una causa de otra.
  -- ----------------------------------------------------------

  -- Sin correo: el INSERT del disparador choca con profiles.email NOT NULL.
  -- Si esta fila sale con cuentas > 0, esa es la causa de esas altas.
  UNION ALL
  SELECT 40, '4. Senales', 'sin correo (choca con profiles.email NOT NULL)',
         count(*), min(h.created_at), max(h.created_at)
  FROM huerfanos h WHERE coalesce(h.email, '') = ''

  -- Anteriores al disparador (se creo el 2026-03-25): no es un fallo,
  -- es que entonces no existia.
  UNION ALL
  SELECT 41, '4. Senales', 'anteriores al disparador (antes de 2026-03-25)',
         count(*), min(h.created_at), max(h.created_at)
  FROM huerfanos h WHERE h.created_at < timestamptz '2026-03-25'

  -- Posteriores al disparador y CON correo: estas son las que no tienen
  -- explicacion en el codigo. Apuntan a un camino que salto el trigger
  -- (restauracion, import del panel) o a un borrado manual del perfil.
  UNION ALL
  SELECT 42, '4. Senales', 'posteriores al disparador y con correo (sin explicacion en el codigo)',
         count(*), min(h.created_at), max(h.created_at)
  FROM huerfanos h
  WHERE h.created_at >= timestamptz '2026-03-25'
    AND coalesce(h.email, '') <> ''
    AND NOT h.borrada

  UNION ALL
  SELECT 43, '4. Senales', 'cuentas borradas en blando (deleted_at): no hay que rellenarlas',
         count(*), min(h.created_at), max(h.created_at)
  FROM huerfanos h WHERE h.borrada

  UNION ALL
  SELECT 44, '4. Senales', 'cuentas anonimas (is_anonymous)',
         count(*), min(h.created_at), max(h.created_at)
  FROM huerfanos h WHERE h.anonima

  -- El otro agujero silencioso: sync_profile_verified() hace
  -- UPDATE profiles WHERE id = NEW.user_id, que sin perfil es un no-op
  -- sin error. Se puede quedar verificada una afiliacion cuyo perfil
  -- no existe, y nadie se entera.
  UNION ALL
  SELECT 45, '4. Senales', 'con afiliacion en profile_affiliations pero sin perfil',
         count(*), min(a.created_at), max(a.created_at)
  FROM public.profile_affiliations a
  JOIN huerfanos h ON h.id = a.user_id

  -- ----------------------------------------------------------
  -- 5. Que arrastran. Estas filas ya estan en la base y apuntan a
  --    gente sin perfil: es lo que se ve al auditar event_participants.
  -- ----------------------------------------------------------
  UNION ALL
  SELECT 50, '5. Arrastre', 'eventos creados por cuentas sin perfil',
         count(*), min(e.created_at), max(e.created_at)
  FROM public.events e JOIN huerfanos h ON h.id = e.creator_id

  UNION ALL
  SELECT 51, '5. Arrastre', 'participaciones de cuentas sin perfil',
         count(*), min(ep.joined_at), max(ep.joined_at)
  FROM public.event_participants ep JOIN huerfanos h ON h.id = ep.user_id

  UNION ALL
  SELECT 52, '5. Arrastre', 'mensajes de cuentas sin perfil',
         count(*), min(m.created_at), max(m.created_at)
  FROM public.messages m JOIN huerfanos h ON h.id = m.sender_id

) t
ORDER BY n, detalle;
