-- ============================================================
-- Buscar personas: busqueda instantanea, sugerencias y amistades a prueba
-- de duplicados
--
-- 1. Amistades
--
--    La politica de INSERT de friendships solo exige ser el solicitante y no
--    estar bloqueado. Con eso, cualquiera podia:
--
--      - insertar la fila ya con status = 'accepted' y hacerse "amigo" de
--        quien quisiera sin que aceptara, con acceso a sus eventos de amigos;
--      - pedirse amistad a si mismo;
--      - crear A->B y B->A a la vez (el UNIQUE es por par ordenado), con dos
--        filas para una misma relacion;
--      - pedir amistad a alguien de otro campus, que ni siquiera la ve;
--      - disparar solicitudes en bucle, cada una con su notificacion push.
--
--    Y quien la recibe podia, en el UPDATE, cambiar requester_id por otra
--    persona.
--
--    Todo se cierra en la base, no en la interfaz. A 2026-09-15 produccion
--    no tiene ninguna fila que choque con estas reglas (0 consigo mismo,
--    0 pares duplicados, 0 entre campus), asi que no se toca ni se borra
--    ninguna amistad existente.
--
-- 2. search_people(): por nombre, apellido o nombre completo, sin distinguir
--    mayusculas ni acentos, acotada al campus propio (como public_profiles),
--    sin bloqueados, sin uno mismo y con el estado de la relacion.
--
-- 3. people_suggestions(): "personas que quiza conozcas", con senales que la
--    base ya tiene: amigos en comun y grupos compartidos. No hay usuario
--    (@handle) ni telefono en los perfiles, asi que no se usan.
--
-- Idempotente: se puede pegar dos veces en el SQL Editor.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 0. Extensiones para buscar sin acentos y con indice
-- ------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA extensions;

-- Minusculas, sin acentos y con los espacios colapsados. IMMUTABLE para
-- poder indexarla: el diccionario va nombrado, que es lo que la hace estable.
CREATE OR REPLACE FUNCTION public.search_normalize(_t text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT btrim(regexp_replace(
    lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(_t, ''))),
    '\s+', ' ', 'g'
  ));
$$;

REVOKE EXECUTE ON FUNCTION public.search_normalize(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.search_normalize(text) TO authenticated;

-- ------------------------------------------------------------
-- 1. Indices
-- ------------------------------------------------------------
-- La busqueda y las sugerencias filtran primero por campus.
CREATE INDEX IF NOT EXISTS profiles_campus_id_idx ON public.profiles (campus_id);

-- LIKE '%texto%' sobre el nombre normalizado, desde 3 letras.
CREATE INDEX IF NOT EXISTS profiles_name_search_trgm_idx
  ON public.profiles USING gin (public.search_normalize(name) extensions.gin_trgm_ops);

-- Una sola fila por pareja, en cualquier sentido. Tambien sirve para buscar
-- la relacion entre dos personas sin mirar los dos ordenes.
CREATE UNIQUE INDEX IF NOT EXISTS friendships_pair_key
  ON public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

-- ------------------------------------------------------------
-- 2. Nadie es amigo de si mismo
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.friendships'::regclass AND conname = 'friendships_no_self'
  ) THEN
    ALTER TABLE public.friendships
      ADD CONSTRAINT friendships_no_self CHECK (requester_id <> addressee_id);
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. Registro minimo para el limite de solicitudes
--
-- Contar filas de friendships no basta: pedir, cancelar y volver a pedir no
-- deja rastro y cada vez sale una push. Solo quien pidio y cuando; se purga
-- sola al pasar un dia. Sin politicas: solo la ve el disparador (DEFINER).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.friend_request_attempts (
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS friend_request_attempts_user_idx
  ON public.friend_request_attempts (user_id, created_at);
ALTER TABLE public.friend_request_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.friend_request_attempts FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 4. Reglas de escritura de friendships
--
-- Codigos estables que traduce rpcErrors.ts. FRIEND_REQUEST_EXISTS sale con
-- SQLSTATE 23505, el mismo que daba el UNIQUE: la version publicada en App
-- Store ya lo reconoce como "ya enviaste solicitud".
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_friendship_write()
RETURNS trigger
LANGUAGE plpgsql
-- DEFINER: tiene que ver la fila en sentido contrario y el registro de
-- intentos, que la RLS de quien escribe no deja ver entero.
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_otra   public.friendships%ROWTYPE;
  v_hora   int;
  v_dia    int;
BEGIN
  -- Sin sesion: service_role, borrado de cuenta, migraciones.
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id           IS DISTINCT FROM OLD.id
    OR NEW.requester_id IS DISTINCT FROM OLD.requester_id
    OR NEW.addressee_id IS DISTINCT FROM OLD.addressee_id
    OR NEW.created_at   IS DISTINCT FROM OLD.created_at
    OR (NEW.status IS DISTINCT FROM OLD.status
        AND NOT (OLD.status = 'pending' AND NEW.status = 'accepted')) THEN
      RAISE EXCEPTION 'FRIENDSHIP_FIELD_LOCKED';
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT
  IF NEW.requester_id = NEW.addressee_id THEN
    RAISE EXCEPTION 'FRIEND_SELF';
  END IF;

  -- Una solicitud nace pendiente: aceptar es cosa de quien la recibe.
  IF NEW.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'FRIENDSHIP_FIELD_LOCKED';
  END IF;

  -- Mismo alcance que public_profiles: no se pide amistad a quien no se ve.
  IF public.is_blocked(NEW.requester_id, NEW.addressee_id)
     OR NOT public.same_institution(NEW.requester_id, NEW.addressee_id) THEN
    RAISE EXCEPTION 'FRIEND_NOT_AVAILABLE';
  END IF;

  SELECT * INTO v_otra
  FROM public.friendships f
  WHERE least(f.requester_id, f.addressee_id)    = least(NEW.requester_id, NEW.addressee_id)
    AND greatest(f.requester_id, f.addressee_id) = greatest(NEW.requester_id, NEW.addressee_id)
  LIMIT 1;

  IF FOUND THEN
    IF v_otra.status = 'accepted' THEN
      RAISE EXCEPTION 'ALREADY_FRIENDS';
    ELSIF v_otra.requester_id = NEW.requester_id THEN
      RAISE EXCEPTION 'FRIEND_REQUEST_EXISTS' USING ERRCODE = '23505';
    ELSE
      RAISE EXCEPTION 'FRIEND_REQUEST_INCOMING';
    END IF;
  END IF;

  DELETE FROM public.friend_request_attempts
  WHERE user_id = v_uid AND created_at < now() - interval '1 day';

  SELECT
    count(*) FILTER (WHERE created_at > now() - interval '1 hour'),
    count(*)
  INTO v_hora, v_dia
  FROM public.friend_request_attempts
  WHERE user_id = v_uid;

  -- Holgado: agregar a 30 personas en una hora es mucho para una persona y
  -- poco para un script.
  IF v_hora >= 30 OR v_dia >= 100 THEN
    RAISE EXCEPTION 'FRIEND_RATE_LIMIT';
  END IF;

  INSERT INTO public.friend_request_attempts (user_id) VALUES (v_uid);
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_friendship_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_friendship_write ON public.friendships;
CREATE TRIGGER trg_guard_friendship_write
  BEFORE INSERT OR UPDATE ON public.friendships
  FOR EACH ROW EXECUTE FUNCTION public.guard_friendship_write();

-- ------------------------------------------------------------
-- 5. search_people
--
-- DEFINER porque el estado de la relacion y los amigos en comun necesitan
-- leer amistades ajenas; a cambio, los filtros de public_profiles van
-- escritos aqui a mano: sesion, mismo campus, sin bloqueos, sin uno mismo.
-- Solo devuelve columnas que public_profiles ya expone, mas la relacion con
-- quien busca y un recuento.
--
-- Cada palabra escrita tiene que aparecer en el nombre: "ana lop" encuentra
-- a "Ana Lopez" y a "Lopez, Ana". Con 1 o 2 letras, al principio de una
-- palabra (una sola letra dentro de cualquier nombre seria ruido); desde 3,
-- en cualquier parte.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_people(
  _query  text,
  _limit  integer DEFAULT 20,
  _offset integer DEFAULT 0
)
RETURNS TABLE (
  id             uuid,
  name           text,
  avatar_url     text,
  major          text,
  relation       text,
  friendship_id  uuid,
  mutual_friends integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid    uuid := auth.uid();
  v_campus uuid;
  v_q      text;
  v_tokens text[];
  v_largo  text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  SELECT p.campus_id INTO v_campus FROM public.profiles p WHERE p.id = v_uid;
  IF v_campus IS NULL THEN
    RETURN;
  END IF;

  v_q := public.search_normalize(left(coalesce(_query, ''), 100));
  IF v_q = '' THEN
    RETURN;
  END IF;

  SELECT array_agg(t ORDER BY o) INTO v_tokens
  FROM (
    SELECT t, o FROM unnest(string_to_array(v_q, ' ')) WITH ORDINALITY AS u(t, o)
    WHERE t <> '' LIMIT 5
  ) x;

  -- La palabra mas larga, para que el indice trigram descarte lo que pueda.
  SELECT t INTO v_largo FROM unnest(v_tokens) t ORDER BY length(t) DESC LIMIT 1;

  RETURN QUERY
  WITH mis_amigos AS (
    SELECT CASE WHEN f.requester_id = v_uid THEN f.addressee_id ELSE f.requester_id END AS fid
    FROM public.friendships f
    WHERE f.status = 'accepted' AND (f.requester_id = v_uid OR f.addressee_id = v_uid)
  ),
  cand AS (
    SELECT p.id, p.name, p.avatar_url, p.major, public.search_normalize(p.name) AS n
    FROM public.profiles p
    WHERE p.campus_id = v_campus
      AND p.id <> v_uid
      AND nullif(btrim(p.name), '') IS NOT NULL
      AND (length(v_largo) < 3
           OR public.search_normalize(p.name) LIKE '%' || replace(replace(replace(v_largo, '\', '\\'), '%', '\%'), '_', '\_') || '%')
  ),
  coinciden AS (
    SELECT c.*,
      CASE
        WHEN c.n = v_q THEN 0
        WHEN left(c.n, length(v_q)) = v_q THEN 1
        WHEN NOT EXISTS (
          SELECT 1 FROM unnest(v_tokens) t
          WHERE position(' ' || t IN ' ' || c.n) = 0
        ) THEN 2
        ELSE 3
      END AS rango
    FROM cand c
    WHERE NOT EXISTS (
      SELECT 1 FROM unnest(v_tokens) t
      WHERE CASE WHEN length(t) < 3
                 THEN position(' ' || t IN ' ' || c.n) = 0
                 ELSE position(t IN c.n) = 0
            END
    )
      AND NOT public.is_blocked(v_uid, c.id)
  )
  SELECT
    c.id,
    c.name,
    c.avatar_url,
    c.major,
    CASE
      WHEN f.status = 'accepted'                          THEN 'friends'
      WHEN f.status = 'pending' AND f.requester_id = v_uid THEN 'outgoing'
      WHEN f.status = 'pending'                           THEN 'incoming'
      ELSE 'none'
    END::text,
    CASE WHEN f.status = 'pending' THEN f.id END,
    (SELECT count(*)::int
     FROM public.friendships g
     JOIN mis_amigos m
       ON m.fid = CASE WHEN g.requester_id = c.id THEN g.addressee_id ELSE g.requester_id END
     WHERE g.status = 'accepted' AND (g.requester_id = c.id OR g.addressee_id = c.id))
  FROM coinciden c
  LEFT JOIN public.friendships f
    ON least(f.requester_id, f.addressee_id)    = least(v_uid, c.id)
   AND greatest(f.requester_id, f.addressee_id) = greatest(v_uid, c.id)
  ORDER BY c.rango, 7 DESC, c.name, c.id
  LIMIT  least(greatest(coalesce(_limit, 20), 1), 50)
  OFFSET least(greatest(coalesce(_offset, 0), 0), 500);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.search_people(text, integer, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.search_people(text, integer, integer) TO authenticated;

-- ------------------------------------------------------------
-- 6. people_suggestions
--
-- Candidatos: amigos de mis amigos, gente de mis grupos (no DM) y, para
-- rellenar, lo mas reciente del campus. Fuera quien ya tiene cualquier
-- relacion conmigo (las solicitudes recibidas ya salen en su seccion),
-- bloqueados y uno mismo. Solo se devuelven recuentos, nunca quienes son
-- esos amigos o grupos.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.people_suggestions(_limit integer DEFAULT 10)
RETURNS TABLE (
  id             uuid,
  name           text,
  avatar_url     text,
  major          text,
  mutual_friends integer,
  shared_groups  integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid    uuid := auth.uid();
  v_campus uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  SELECT p.campus_id INTO v_campus FROM public.profiles p WHERE p.id = v_uid;
  IF v_campus IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH mis_amigos AS (
    SELECT CASE WHEN f.requester_id = v_uid THEN f.addressee_id ELSE f.requester_id END AS fid
    FROM public.friendships f
    WHERE f.status = 'accepted' AND (f.requester_id = v_uid OR f.addressee_id = v_uid)
  ),
  comun AS (
    SELECT CASE WHEN g.requester_id = m.fid THEN g.addressee_id ELSE g.requester_id END AS pid,
           count(*)::int AS n
    FROM mis_amigos m
    JOIN public.friendships g
      ON g.status = 'accepted' AND (g.requester_id = m.fid OR g.addressee_id = m.fid)
    GROUP BY 1
  ),
  grupos AS (
    SELECT otro.user_id AS pid, count(DISTINCT yo.group_id)::int AS n
    FROM public.group_members yo
    JOIN public.groups gr ON gr.id = yo.group_id AND gr.name NOT LIKE '\_\_dm\_%'
    JOIN public.group_members otro ON otro.group_id = yo.group_id AND otro.user_id <> v_uid
    WHERE yo.user_id = v_uid
    GROUP BY 1
  ),
  recientes AS (
    SELECT p.id AS pid
    FROM public.profiles p
    WHERE p.campus_id = v_campus AND p.id <> v_uid
    ORDER BY p.created_at DESC
    LIMIT 50
  ),
  cand AS (
    SELECT pid FROM comun
    UNION SELECT pid FROM grupos
    UNION SELECT pid FROM recientes
  )
  SELECT p.id, p.name, p.avatar_url, p.major,
         coalesce(c.n, 0), coalesce(g.n, 0)
  FROM cand
  JOIN public.profiles p ON p.id = cand.pid
  LEFT JOIN comun  c ON c.pid = p.id
  LEFT JOIN grupos g ON g.pid = p.id
  WHERE p.id <> v_uid
    AND p.campus_id = v_campus
    AND nullif(btrim(p.name), '') IS NOT NULL
    AND NOT public.is_blocked(v_uid, p.id)
    AND NOT EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE least(f.requester_id, f.addressee_id)    = least(v_uid, p.id)
        AND greatest(f.requester_id, f.addressee_id) = greatest(v_uid, p.id)
    )
  ORDER BY coalesce(c.n, 0) DESC, coalesce(g.n, 0) DESC, p.created_at DESC, p.id
  LIMIT least(greatest(coalesce(_limit, 10), 1), 20);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.people_suggestions(integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.people_suggestions(integer) TO authenticated;

COMMIT;
