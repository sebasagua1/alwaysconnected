-- ============================================================
-- Contactos: encontrar a quien ya usa la app, e invitar a quien no
--
-- Nada de la agenda llega en claro. El flujo es:
--   1. En el telefono: se normaliza cada correo o telefono ELEGIDO y se
--      manda solo su SHA-256 a la Edge Function contacts-match, con sesion.
--   2. En la Edge Function: HMAC-SHA256 con CONTACTS_HMAC_KEY (secreto del
--      servidor, NO esta en la base) sobre "tipo:sha256". Un SHA-256 solo se
--      adivina probando telefonos; sin la clave, el HMAC no.
--   3. En la base: solo se comparan HMAC. Aqui no llega nunca ni un correo
--      ni un telefono, ni siquiera su SHA-256.
--
-- Reglas de coincidencia (contacts_match):
--   * solo cuentas que eligieron ser encontrables (discoverable), con
--     identificadores VERIFICADOS (los registra la Edge Function a partir
--     de auth.users: correo confirmado, telefono confirmado);
--   * solo del mismo campus: es la regla de visibilidad de toda la app
--     (public_profiles, eventos, amistades). Alguien de otro campus no se
--     ve en ningun sitio, tampoco aqui;
--   * nunca bloqueados; nunca uno mismo; nunca por nombre.
--   * con cuota: 500 por peticion, 2000 al dia y 20 peticiones al dia. Es
--     lo que hace inviable enumerar cuentas probando numeros.
--
-- Lo que se guarda, y cuanto:
--   * contact_identifiers: los HMAC de TUS identificadores, solo mientras
--     seas encontrable. Dejar de serlo los borra.
--   * contact_matches: a quien encontraste (para sugerencias). Se borra con
--     "borrar mis datos de contactos".
--   * contact_book_hashes: los HMAC de la agenda SOLO si pediste que te
--     avisemos cuando un contacto se una. Caducan a los 180 dias.
--   * contact_sync_usage: recuentos por dia, para la cuota.
--
-- Invitaciones: un codigo opaco por persona (sin telefono, correo ni nada
-- que la identifique) y eventos minimos para medir: compartido, aceptado.
-- La agenda no se toca.
--
-- ASCII puro. Idempotente.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Ajustes de contactos de cada persona
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contact_settings (
  user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  discoverable         boolean NOT NULL DEFAULT false,
  notify_contacts_join boolean NOT NULL DEFAULT false,
  last_synced_at       timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.contact_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.contact_settings TO authenticated;

DROP POLICY IF EXISTS "Users read own contact settings" ON public.contact_settings;
CREATE POLICY "Users read own contact settings"
  ON public.contact_settings FOR SELECT TO authenticated
  USING (user_id = auth.uid());


-- ------------------------------------------------------------
-- 2. Tablas que solo toca el servidor
--
-- RLS activada y SIN politicas, y sin GRANT a nadie de la app: ni leer ni
-- escribir desde el cliente. Las usan las funciones de abajo, que corren
-- como su dueno.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contact_identifiers (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('email', 'phone')),
  digest     text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, digest)
);
CREATE INDEX IF NOT EXISTS contact_identifiers_digest_idx ON public.contact_identifiers (digest);
ALTER TABLE public.contact_identifiers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_identifiers FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.contact_book_hashes (
  owner_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  digest     text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '180 days',
  PRIMARY KEY (owner_id, digest)
);
CREATE INDEX IF NOT EXISTS contact_book_hashes_digest_idx ON public.contact_book_hashes (digest);
ALTER TABLE public.contact_book_hashes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_book_hashes FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.contact_matches (
  owner_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  matched_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, matched_user_id),
  CONSTRAINT contact_matches_no_self CHECK (owner_id <> matched_user_id)
);
CREATE INDEX IF NOT EXISTS contact_matches_matched_idx ON public.contact_matches (matched_user_id);
ALTER TABLE public.contact_matches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_matches FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.contact_sync_usage (
  user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day      date NOT NULL DEFAULT current_date,
  requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  digests  integer NOT NULL DEFAULT 0 CHECK (digests >= 0),
  PRIMARY KEY (user_id, day)
);
ALTER TABLE public.contact_sync_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_sync_usage FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 3. Invitaciones
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invite_codes (
  code       text PRIMARY KEY CHECK (code ~ '^[A-Za-z0-9]{10}$'),
  inviter_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.invite_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invite_codes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.invite_codes TO authenticated;

DROP POLICY IF EXISTS "Users read own invite code" ON public.invite_codes;
CREATE POLICY "Users read own invite code"
  ON public.invite_codes FOR SELECT TO authenticated
  USING (inviter_id = auth.uid());

-- Solo lo necesario para medir: quien invito, que paso y cuando. Ni a quien
-- se envio ni por que numero: la app solo sabe cuantos contactos se eligieron.
CREATE TABLE IF NOT EXISTS public.invite_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inviter_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  invitee_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  kind       text NOT NULL CHECK (kind IN ('shared', 'accepted', 'signed_up')),
  channel    text CHECK (channel IS NULL OR channel IN ('messages', 'whatsapp', 'mail', 'copy', 'other')),
  recipients integer CHECK (recipients IS NULL OR recipients BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invite_events_inviter_idx ON public.invite_events (inviter_id, created_at DESC);
-- Aceptar una invitacion cuenta una vez por pareja.
CREATE UNIQUE INDEX IF NOT EXISTS invite_events_accept_once
  ON public.invite_events (inviter_id, invitee_id, kind) WHERE kind IN ('accepted', 'signed_up');
ALTER TABLE public.invite_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invite_events FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 4. Lo que usa la app
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_contact_settings()
RETURNS TABLE (
  discoverable         boolean,
  notify_contacts_join boolean,
  last_synced_at       timestamptz,
  identifiers          integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(s.discoverable, false),
         COALESCE(s.notify_contacts_join, false),
         s.last_synced_at,
         (SELECT count(*)::int FROM public.contact_identifiers ci WHERE ci.user_id = auth.uid())
  FROM (SELECT auth.uid() AS uid) me
  LEFT JOIN public.contact_settings s ON s.user_id = me.uid
  WHERE me.uid IS NOT NULL;
$$;
REVOKE EXECUTE ON FUNCTION public.my_contact_settings() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.my_contact_settings() TO authenticated;

-- Cambiar los ajustes. Apagar algo borra en el acto lo que ese algo
-- necesitaba guardar: no hay datos "dormidos".
CREATE OR REPLACE FUNCTION public.set_contact_settings(_discoverable boolean, _notify_join boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.contact_settings (user_id, discoverable, notify_contacts_join)
  VALUES (v_uid, COALESCE(_discoverable, false), COALESCE(_notify_join, false))
  ON CONFLICT (user_id) DO UPDATE
    SET discoverable         = COALESCE(_discoverable, false),
        notify_contacts_join = COALESCE(_notify_join, false),
        updated_at           = now();

  IF NOT COALESCE(_discoverable, false) THEN
    DELETE FROM public.contact_identifiers WHERE user_id = v_uid;
  END IF;
  IF NOT COALESCE(_notify_join, false) THEN
    DELETE FROM public.contact_book_hashes WHERE owner_id = v_uid;
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.set_contact_settings(boolean, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_contact_settings(boolean, boolean) TO authenticated;

-- "Borrar mis datos de contactos": todo lo que se derivo de la agenda.
CREATE OR REPLACE FUNCTION public.clear_contact_data()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.contact_book_hashes WHERE owner_id = v_uid;
  DELETE FROM public.contact_matches     WHERE owner_id = v_uid;
  DELETE FROM public.contact_identifiers WHERE user_id  = v_uid;
  INSERT INTO public.contact_settings (user_id) VALUES (v_uid)
  ON CONFLICT (user_id) DO UPDATE
    SET discoverable = false, notify_contacts_join = false, last_synced_at = NULL, updated_at = now();
END;
$$;
REVOKE EXECUTE ON FUNCTION public.clear_contact_data() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.clear_contact_data() TO authenticated;


-- ------------------------------------------------------------
-- 5. Lo que usa la Edge Function (solo service_role)
-- ------------------------------------------------------------

-- Cuota. Suma y comprueba en la misma sentencia, con la fila bloqueada: dos
-- peticiones a la vez no se saltan el limite.
CREATE OR REPLACE FUNCTION public.contacts_consume_quota(_user_id uuid, _count integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.contact_sync_usage%ROWTYPE;
BEGIN
  IF _user_id IS NULL OR _count IS NULL OR _count < 0 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = 'P0001';
  END IF;
  IF _count > 500 THEN
    RAISE EXCEPTION 'CONTACTS_BATCH_TOO_LARGE' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.contact_sync_usage (user_id, day, requests, digests)
  VALUES (_user_id, current_date, 1, _count)
  ON CONFLICT (user_id, day) DO UPDATE
    SET requests = public.contact_sync_usage.requests + 1,
        digests  = public.contact_sync_usage.digests + _count
  RETURNING * INTO v_row;

  IF v_row.requests > 20 OR v_row.digests > 2000 THEN
    RAISE EXCEPTION 'CONTACTS_RATE_LIMIT' USING ERRCODE = 'P0001';
  END IF;

  -- Lo viejo no sirve para nada.
  DELETE FROM public.contact_sync_usage WHERE user_id = _user_id AND day < current_date - 7;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.contacts_consume_quota(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.contacts_consume_quota(uuid, integer) TO service_role;


-- Coincidencias. Devuelve solo lo publico minimo: nombre, foto, campus y la
-- relacion con quien pregunta. Nunca un identificador.
CREATE OR REPLACE FUNCTION public.contacts_match(_user_id uuid, _digests text[], _keep boolean DEFAULT false)
RETURNS TABLE (
  digest        text,
  user_id       uuid,
  name          text,
  avatar_url    text,
  campus_name   text,
  relation      text,
  friendship_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_keep boolean;
BEGIN
  IF _user_id IS NULL OR _digests IS NULL THEN
    RETURN;
  END IF;
  IF cardinality(_digests) > 500 THEN
    RAISE EXCEPTION 'CONTACTS_BATCH_TOO_LARGE' USING ERRCODE = 'P0001';
  END IF;

  -- Guardar la agenda solo si la persona lo pidio (aviso cuando se una
  -- alguien) y solo HMAC validos.
  SELECT COALESCE(s.notify_contacts_join, false) INTO v_keep
  FROM public.contact_settings s WHERE s.user_id = _user_id;

  INSERT INTO public.contact_settings (user_id, last_synced_at)
  VALUES (_user_id, now())
  ON CONFLICT (user_id) DO UPDATE SET last_synced_at = now(), updated_at = now();

  IF COALESCE(v_keep, false) AND COALESCE(_keep, false) THEN
    INSERT INTO public.contact_book_hashes (owner_id, digest)
    SELECT DISTINCT _user_id, d FROM unnest(_digests) AS d WHERE d ~ '^[0-9a-f]{64}$'
    ON CONFLICT (owner_id, digest) DO UPDATE SET expires_at = now() + interval '180 days';

    -- Tope por persona: lo mas viejo sale primero.
    DELETE FROM public.contact_book_hashes b
    WHERE b.owner_id = _user_id
      AND b.digest IN (
        SELECT x.digest FROM public.contact_book_hashes x
        WHERE x.owner_id = _user_id
        ORDER BY x.created_at DESC
        OFFSET 3000
      );
  END IF;

  RETURN QUERY
  WITH hits AS (
    SELECT DISTINCT ON (ci.digest, ci.user_id) ci.digest, ci.user_id AS uid
    FROM public.contact_identifiers ci
    JOIN public.contact_settings cs ON cs.user_id = ci.user_id AND cs.discoverable
    WHERE ci.digest = ANY (_digests)
      AND ci.user_id <> _user_id
  ), visibles AS (
    SELECT h.digest, h.uid, p.name, p.avatar_url, i.campus_name,
           EXISTS (SELECT 1 FROM public.blocks b WHERE b.blocker_id = _user_id AND b.blocked_id = h.uid) AS lo_bloquee
    FROM hits h
    JOIN public.profiles p ON p.id = h.uid
    LEFT JOIN public.institutions i ON i.id = p.campus_id
    WHERE p.onboarding_completed
      AND nullif(btrim(p.name), '') IS NOT NULL
      AND public.same_institution(_user_id, h.uid)
      -- Si la otra persona me bloqueo, no existo para ella ni ella para mi.
      AND NOT EXISTS (SELECT 1 FROM public.blocks b WHERE b.blocker_id = h.uid AND b.blocked_id = _user_id)
  ), guardar AS (
    INSERT INTO public.contact_matches (owner_id, matched_user_id)
    SELECT DISTINCT _user_id, v.uid FROM visibles v WHERE NOT v.lo_bloquee
    ON CONFLICT (owner_id, matched_user_id) DO NOTHING
    RETURNING 1
  )
  SELECT v.digest, v.uid, v.name, v.avatar_url, v.campus_name,
    CASE
      WHEN v.lo_bloquee THEN 'blocked'
      WHEN f.status = 'accepted' THEN 'friends'
      WHEN f.status = 'pending' AND f.requester_id = _user_id THEN 'outgoing'
      WHEN f.status = 'pending' THEN 'incoming'
      ELSE 'none'
    END::text,
    -- Para poder aceptar o cancelar desde la lista sin otra consulta.
    CASE WHEN f.status = 'pending' AND NOT v.lo_bloquee THEN f.id END
  FROM visibles v
  LEFT JOIN LATERAL (
    SELECT fr.id, fr.status, fr.requester_id FROM public.friendships fr
    WHERE (fr.requester_id = _user_id AND fr.addressee_id = v.uid)
       OR (fr.requester_id = v.uid AND fr.addressee_id = _user_id)
    ORDER BY (fr.status = 'accepted') DESC
    LIMIT 1
  ) f ON true;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.contacts_match(uuid, text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.contacts_match(uuid, text[], boolean) TO service_role;


-- Aviso "alguien que conoces se unio". Version sencilla con push_send; la
-- migracion de notificaciones la pasa a la cola con preferencias.
CREATE OR REPLACE FUNCTION public.notify_contact_joined(_owner uuid, _joined uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text;
BEGIN
  SELECT COALESCE(NULLIF(p.name, ''), 'Alguien') INTO v_name FROM public.profiles p WHERE p.id = _joined;
  PERFORM public.push_send(
    _owner,
    U&'Alguien que conoces est\00E1 aqu\00ED',
    COALESCE(v_name, 'Alguien') || U&' se uni\00F3 a Always Connected',
    jsonb_build_object('type', 'contact_joined', 'user_id', _joined)
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.notify_contact_joined(uuid, uuid) FROM PUBLIC, anon, authenticated;


-- Registrar los identificadores VERIFICADOS de una cuenta (los calcula la
-- Edge Function a partir de auth.users). Solo si la persona es encontrable.
-- Reemplaza los anteriores: un correo que ya no es suyo deja de coincidir.
--
-- Despues avisa a quien la tenia en la agenda y pidio el aviso, una vez por
-- pareja y como mucho a 50 personas, con las mismas reglas de visibilidad.
CREATE OR REPLACE FUNCTION public.contacts_register_identifiers(_user_id uuid, _items jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_discoverable boolean;
  v_new          text[];
  v_avisados     integer := 0;
  r              record;
BEGIN
  IF _user_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(s.discoverable, false) INTO v_discoverable
  FROM public.contact_settings s WHERE s.user_id = _user_id;

  IF NOT COALESCE(v_discoverable, false) THEN
    DELETE FROM public.contact_identifiers WHERE user_id = _user_id;
    RETURN 0;
  END IF;

  -- Los que no tenia antes: solo esos pueden provocar un aviso.
  SELECT array_agg(x.digest) INTO v_new
  FROM (
    SELECT DISTINCT e->>'digest' AS digest
    FROM jsonb_array_elements(COALESCE(_items, '[]'::jsonb)) e
    WHERE e->>'kind' IN ('email', 'phone') AND e->>'digest' ~ '^[0-9a-f]{64}$'
  ) x
  WHERE NOT EXISTS (SELECT 1 FROM public.contact_identifiers ci WHERE ci.user_id = _user_id AND ci.digest = x.digest);

  DELETE FROM public.contact_identifiers WHERE user_id = _user_id;
  INSERT INTO public.contact_identifiers (user_id, kind, digest)
  SELECT DISTINCT _user_id, e->>'kind', e->>'digest'
  FROM jsonb_array_elements(COALESCE(_items, '[]'::jsonb)) e
  WHERE e->>'kind' IN ('email', 'phone') AND e->>'digest' ~ '^[0-9a-f]{64}$'
  LIMIT 4
  ON CONFLICT DO NOTHING;

  IF v_new IS NULL THEN
    RETURN 0;
  END IF;

  FOR r IN
    SELECT DISTINCT b.owner_id
    FROM public.contact_book_hashes b
    JOIN public.contact_settings s ON s.user_id = b.owner_id AND s.notify_contacts_join
    WHERE b.digest = ANY (v_new)
      AND b.expires_at > now()
      AND b.owner_id <> _user_id
      AND public.same_institution(b.owner_id, _user_id)
      AND NOT public.is_blocked(b.owner_id, _user_id)
      AND NOT public.are_friends(b.owner_id, _user_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.contact_matches m
        WHERE m.owner_id = b.owner_id AND m.matched_user_id = _user_id
      )
    LIMIT 50
  LOOP
    INSERT INTO public.contact_matches (owner_id, matched_user_id)
    VALUES (r.owner_id, _user_id)
    ON CONFLICT DO NOTHING;
    PERFORM public.notify_contact_joined(r.owner_id, _user_id);
    v_avisados := v_avisados + 1;
  END LOOP;

  RETURN v_avisados;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.contacts_register_identifiers(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.contacts_register_identifiers(uuid, jsonb) TO service_role;

-- Un correo que cambia deja de valer como identificador en el acto: hasta
-- que la app vuelva a registrar el nuevo, no coincide con nada.
CREATE OR REPLACE FUNCTION public.on_auth_identity_change_contacts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email OR NEW.email_confirmed_at IS DISTINCT FROM OLD.email_confirmed_at THEN
    DELETE FROM public.contact_identifiers WHERE user_id = NEW.id AND kind = 'email';
  END IF;
  IF NEW.phone IS DISTINCT FROM OLD.phone OR NEW.phone_confirmed_at IS DISTINCT FROM OLD.phone_confirmed_at THEN
    DELETE FROM public.contact_identifiers WHERE user_id = NEW.id AND kind = 'phone';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.on_auth_identity_change_contacts() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_auth_identity_change_contacts ON auth.users;
CREATE TRIGGER trg_auth_identity_change_contacts
  AFTER UPDATE OF email, email_confirmed_at, phone, phone_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.on_auth_identity_change_contacts();


-- ------------------------------------------------------------
-- 6. Sugerencias: se suma "esta en tus contactos"
--
-- Mismo cuerpo que 20260916000000 (people_suggestions) mas los contactos
-- como senal y como columna. Cambia la forma del resultado: hay que
-- borrarla y crearla.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.people_suggestions(integer);

CREATE FUNCTION public.people_suggestions(_limit integer DEFAULT 10)
RETURNS TABLE (
  id             uuid,
  name           text,
  avatar_url     text,
  major          text,
  mutual_friends integer,
  shared_groups  integer,
  in_contacts    boolean
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
  contactos AS (
    SELECT cm.matched_user_id AS pid FROM public.contact_matches cm WHERE cm.owner_id = v_uid
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
    UNION SELECT pid FROM contactos
    UNION SELECT pid FROM recientes
  )
  SELECT p.id, p.name, p.avatar_url, p.major,
         coalesce(c.n, 0), coalesce(g.n, 0), (k.pid IS NOT NULL)
  FROM cand
  JOIN public.profiles p ON p.id = cand.pid
  LEFT JOIN comun     c ON c.pid = p.id
  LEFT JOIN grupos    g ON g.pid = p.id
  LEFT JOIN contactos k ON k.pid = p.id
  WHERE p.id <> v_uid
    AND p.campus_id = v_campus
    AND nullif(btrim(p.name), '') IS NOT NULL
    AND NOT public.is_blocked(v_uid, p.id)
    AND NOT EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE least(f.requester_id, f.addressee_id)    = least(v_uid, p.id)
        AND greatest(f.requester_id, f.addressee_id) = greatest(v_uid, p.id)
    )
  ORDER BY (k.pid IS NOT NULL) DESC, coalesce(c.n, 0) DESC, coalesce(g.n, 0) DESC, p.created_at DESC, p.id
  LIMIT least(greatest(coalesce(_limit, 10), 1), 20);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.people_suggestions(integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.people_suggestions(integer) TO authenticated;


-- ------------------------------------------------------------
-- 7. Invitaciones
-- ------------------------------------------------------------

-- Tu codigo (uno por persona, se reutiliza). Opaco: 10 caracteres al azar.
CREATE OR REPLACE FUNCTION public.my_invite_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_code text;
  v_abc  constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  i      integer;
  b      bytea;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT c.code INTO v_code FROM public.invite_codes c WHERE c.inviter_id = v_uid;
  IF v_code IS NOT NULL THEN
    RETURN v_code;
  END IF;

  FOR attempt IN 1..5 LOOP
    b := extensions.gen_random_bytes(10);
    v_code := '';
    FOR i IN 0..9 LOOP
      v_code := v_code || substr(v_abc, 1 + (get_byte(b, i) % length(v_abc)), 1);
    END LOOP;
    BEGIN
      INSERT INTO public.invite_codes (code, inviter_id) VALUES (v_code, v_uid);
      RETURN v_code;
    EXCEPTION WHEN unique_violation THEN
      -- Otra peticion de la misma persona gano la carrera: se usa la suya.
      SELECT c.code INTO v_code FROM public.invite_codes c WHERE c.inviter_id = v_uid;
      IF v_code IS NOT NULL THEN
        RETURN v_code;
      END IF;
    END;
  END LOOP;
  RAISE EXCEPTION 'INVITE_CODE_UNAVAILABLE' USING ERRCODE = 'P0001';
END;
$$;
REVOKE EXECUTE ON FUNCTION public.my_invite_code() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.my_invite_code() TO authenticated;

-- Apuntar que se compartio (la app no sabe a quien, solo cuantos eligio).
CREATE OR REPLACE FUNCTION public.log_invite_share(_channel text, _recipients integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  -- Metrica, no funcionalidad: pasado el tope simplemente no se apunta.
  IF (SELECT count(*) FROM public.invite_events e
      WHERE e.inviter_id = v_uid AND e.kind = 'shared' AND e.created_at > now() - interval '1 day') >= 50 THEN
    RETURN;
  END IF;
  INSERT INTO public.invite_events (inviter_id, kind, channel, recipients)
  VALUES (
    v_uid, 'shared',
    CASE WHEN _channel IN ('messages', 'whatsapp', 'mail', 'copy', 'other') THEN _channel ELSE 'other' END,
    least(greatest(COALESCE(_recipients, 0), 0), 100)
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.log_invite_share(text, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.log_invite_share(text, integer) TO authenticated;

-- Quien abrio la app desde una invitacion. Devuelve a quien invito SOLO si
-- esa persona es visible (mismo campus, sin bloqueo): la app puede ofrecer
-- "Agregar". El codigo no dice nada si no hay nada que ver.
CREATE OR REPLACE FUNCTION public.redeem_invite(_code text)
RETURNS TABLE (inviter_id uuid, name text, avatar_url text, relation text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid     uuid := auth.uid();
  v_inviter uuid;
  v_new     boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT c.inviter_id INTO v_inviter FROM public.invite_codes c WHERE c.code = _code;
  IF v_inviter IS NULL OR v_inviter = v_uid THEN
    RETURN;
  END IF;

  SELECT u.created_at > now() - interval '7 days' INTO v_new FROM auth.users u WHERE u.id = v_uid;

  INSERT INTO public.invite_events (inviter_id, invitee_id, kind)
  VALUES (v_inviter, v_uid, 'accepted')
  ON CONFLICT DO NOTHING;
  IF COALESCE(v_new, false) THEN
    INSERT INTO public.invite_events (inviter_id, invitee_id, kind)
    VALUES (v_inviter, v_uid, 'signed_up')
    ON CONFLICT DO NOTHING;
  END IF;

  IF public.is_blocked(v_uid, v_inviter) OR NOT public.same_institution(v_uid, v_inviter) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id, p.name, p.avatar_url,
    CASE
      WHEN f.status = 'accepted' THEN 'friends'
      WHEN f.status = 'pending' AND f.requester_id = v_uid THEN 'outgoing'
      WHEN f.status = 'pending' THEN 'incoming'
      ELSE 'none'
    END::text
  FROM public.profiles p
  LEFT JOIN LATERAL (
    SELECT fr.status, fr.requester_id FROM public.friendships fr
    WHERE (fr.requester_id = v_uid AND fr.addressee_id = p.id)
       OR (fr.requester_id = p.id AND fr.addressee_id = v_uid)
    LIMIT 1
  ) f ON true
  WHERE p.id = v_inviter;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.redeem_invite(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.redeem_invite(text) TO authenticated;

-- Cuantas personas llegaron por tu invitacion (solo recuentos).
CREATE OR REPLACE FUNCTION public.my_invite_stats()
RETURNS TABLE (shared bigint, accepted bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    count(*) FILTER (WHERE e.kind = 'shared'),
    count(*) FILTER (WHERE e.kind = 'accepted')
  FROM public.invite_events e
  WHERE e.inviter_id = auth.uid();
$$;
REVOKE EXECUTE ON FUNCTION public.my_invite_stats() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.my_invite_stats() TO authenticated;


-- ------------------------------------------------------------
-- 8. Limpieza diaria de la agenda caducada (la programa 20260925010000
--    junto a los trabajos de notificaciones).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_expired_contact_hashes()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v integer;
BEGIN
  DELETE FROM public.contact_book_hashes WHERE expires_at < now();
  GET DIAGNOSTICS v = ROW_COUNT;
  DELETE FROM public.contact_sync_usage WHERE day < current_date - 7;
  RETURN v;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.purge_expired_contact_hashes() FROM PUBLIC, anon, authenticated;

COMMIT;
