-- ============================================================
-- Chat de grupo de cada actividad
--
-- Cada evento tiene EXACTAMENTE un chat: el que forman sus mensajes con
-- messages.event_id = <evento>. La columna existe desde la primera
-- migracion para esto mismo y nunca se llego a usar (20260920000000, de la
-- PR #17, la marco como "muerta" y quito su rama de las politicas). Aqui se
-- reactiva, en vez de crear una tabla de chats o de miembros paralela.
--
-- Quien esta en el chat NO se guarda aparte: se calcula en cada lectura.
--   miembro = quien organiza  +  participantes con status = 'joined'
--             y que no esten bloqueados con quien organiza
-- Asi no hay una segunda lista de miembros que pueda desincronizarse:
-- salir del evento, que te expulsen o que haya un bloqueo corta el acceso
-- en la misma transaccion, y los mensajes anteriores se quedan donde estan.
--
-- Lo que hay:
--   1. messages: menciones, aviso del organizador y quien borro.
--   2. event_removals: expulsiones (no se puede volver a entrar solo).
--   3. event_chat_state: leido, silenciado y "lo estoy viendo" por persona.
--   4. event_moderation_log: registro de lo que hace el organizador.
--   5. Funciones de acceso y politicas de messages (las tres).
--   6. Disparadores: validar al enviar, al editar, al entrar y al bloquear.
--   7. RPC del chat y de moderacion.
--   8. notification_counts gana event_chat_unread.
--   9. Push del chat (version sencilla; 20260925000000 la cambia por la
--      cola de notificaciones con agrupacion y preferencias).
--
-- No borra ni reescribe mensajes. Compatible con la version publicada de
-- la app: no toca ninguna columna que lea y las politicas de grupos y DM
-- conceden exactamente lo mismo que antes.
--
-- ASCII puro (textos de push con U&'...'). Idempotente.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. messages
-- ------------------------------------------------------------
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS mentions        uuid[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_announcement boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.messages.event_id IS
  'Chat de la actividad (20260923000000). Exactamente uno de event_id y '
  'group_id. Leen y escriben quien organiza y los participantes joined.';
COMMENT ON COLUMN public.messages.mentions IS
  'Personas mencionadas (@). Las filtra el servidor: solo miembros del chat, '
  'sin quien escribe, sin bloqueados, maximo 10. No se cambian al editar.';
COMMENT ON COLUMN public.messages.is_announcement IS
  'Aviso del organizador. Solo en chats de actividad y solo quien organiza.';
COMMENT ON COLUMN public.messages.deleted_by IS
  'Quien lo borro: su autor o el organizador de la actividad.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_mentions_max') THEN
    ALTER TABLE public.messages
      ADD CONSTRAINT messages_mentions_max CHECK (cardinality(mentions) <= 10);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_announcement_in_event') THEN
    ALTER TABLE public.messages
      ADD CONSTRAINT messages_announcement_in_event CHECK (NOT is_announcement OR event_id IS NOT NULL);
  END IF;
  -- El mismo tope que puso 20260920000000 (PR #17, ya aplicada en
  -- produccion). Si esa migracion ya corrio, esto no hace nada; si no,
  -- el chat de actividad no queda sin limite de longitud.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_content_len') THEN
    ALTER TABLE public.messages
      ADD CONSTRAINT messages_content_len
      CHECK (length(content) <= 2000
             AND (deleted_at IS NOT NULL OR length(btrim(content)) > 0)) NOT VALID;
  END IF;
  -- Un mensaje pertenece a UN chat. NOT VALID para que la migracion no
  -- dependa de filas historicas; se valida justo debajo.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_one_chat') THEN
    ALTER TABLE public.messages
      ADD CONSTRAINT messages_one_chat CHECK (num_nonnulls(event_id, group_id) = 1) NOT VALID;
  END IF;
END $$;

-- Si alguna fila vieja lo impidiera, el CHECK sigue protegiendo lo nuevo y
-- solo se avisa. No hay que tocar datos para aplicar la migracion.
DO $$
BEGIN
  ALTER TABLE public.messages VALIDATE CONSTRAINT messages_one_chat;
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'messages_one_chat queda NOT VALID: hay filas antiguas sin chat o con dos.';
END $$;

-- El chat se pide por evento y fecha, como el de grupo por grupo y fecha.
CREATE INDEX IF NOT EXISTS messages_event_created_idx
  ON public.messages (event_id, created_at DESC)
  WHERE event_id IS NOT NULL;

-- Para el limite de envio (abajo): los mensajes recientes de una persona.
CREATE INDEX IF NOT EXISTS messages_sender_created_idx
  ON public.messages (sender_id, created_at DESC);


-- ------------------------------------------------------------
-- 2. Expulsiones
--
-- Expulsar borra la participacion (libera la plaza y corta el chat) y deja
-- esta fila para que la persona no pueda volver a unirse por su cuenta. El
-- organizador puede deshacerlo.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.event_removals (
  event_id   uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  removed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id),
  CONSTRAINT event_removals_reason_len CHECK (reason IS NULL OR length(reason) <= 300)
);

CREATE INDEX IF NOT EXISTS event_removals_user_idx ON public.event_removals (user_id);

ALTER TABLE public.event_removals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_removals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.event_removals TO authenticated;

-- Lo ve quien organiza y la persona afectada (para decirle por que no
-- puede volver a entrar). Nadie escribe directo: solo las RPC de abajo.
DROP POLICY IF EXISTS "Organizer and removed user can read removals" ON public.event_removals;
CREATE POLICY "Organizer and removed user can read removals"
  ON public.event_removals FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_event_creator(event_id, auth.uid()));


-- ------------------------------------------------------------
-- 3. Estado del chat por persona
--
-- last_read_at   hasta donde leyo (no leidos).
-- muted          no avisar de mensajes normales (menciones y avisos del
--                organizador si llegan).
-- active_until   la pantalla del chat esta abierta: no hace falta push.
-- last_pushed_at para agrupar mensajes seguidos en un solo aviso.
--
-- Se crea al entrar (organizador al crear, participante al unirse o ser
-- aprobado) y se borra al salir. Solo se escribe por RPC.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.event_chat_state (
  event_id       uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_at   timestamptz NOT NULL DEFAULT now(),
  muted          boolean NOT NULL DEFAULT false,
  active_until   timestamptz,
  last_pushed_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS event_chat_state_user_idx ON public.event_chat_state (user_id);

ALTER TABLE public.event_chat_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_chat_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.event_chat_state TO authenticated;

DROP POLICY IF EXISTS "Users read own chat state" ON public.event_chat_state;
CREATE POLICY "Users read own chat state"
  ON public.event_chat_state FOR SELECT TO authenticated
  USING (user_id = auth.uid());


-- ------------------------------------------------------------
-- 4. Registro de moderacion del organizador
--
-- La moderacion de la app sigue siendo reportes + bloqueos + revision a
-- mano (supabase/setup/README.md). Esto deja constancia de lo que hace
-- cada organizador en su actividad, para esa revision.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.event_moderation_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id       uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  actor_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action         text NOT NULL CHECK (action IN ('delete_message', 'remove_participant', 'readmit_participant')),
  target_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  message_id     uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_moderation_log_event_idx
  ON public.event_moderation_log (event_id, created_at DESC);

ALTER TABLE public.event_moderation_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_moderation_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.event_moderation_log TO authenticated;

DROP POLICY IF EXISTS "Organizer reads own event log" ON public.event_moderation_log;
CREATE POLICY "Organizer reads own event log"
  ON public.event_moderation_log FOR SELECT TO authenticated
  USING (public.is_event_creator(event_id, auth.uid()));


-- ------------------------------------------------------------
-- 5. Quien esta en el chat
--
-- event_chat_member(evento, persona): para el propio servidor. No se
-- concede a authenticated: con dos argumentos serviria para preguntar si
-- CUALQUIERA esta en CUALQUIER evento.
--
-- can_access_event_chat(evento): la que usan las politicas. Pregunta
-- siempre por quien llama.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.event_chat_member(_event_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _event_id IS NOT NULL AND _user_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.events e
    WHERE e.id = _event_id
      AND (
        e.creator_id = _user_id
        OR (
          EXISTS (
            SELECT 1 FROM public.event_participants ep
            WHERE ep.event_id = e.id
              AND ep.user_id  = _user_id
              AND ep.status   = 'joined'
          )
          AND NOT public.is_blocked(_user_id, e.creator_id)
        )
      )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.event_chat_member(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.can_access_event_chat(_event_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.event_chat_member(_event_id, auth.uid());
$$;

REVOKE EXECUTE ON FUNCTION public.can_access_event_chat(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.can_access_event_chat(uuid) TO authenticated;


-- ------------------------------------------------------------
-- 5b. Politicas de messages
--
-- Grupos y DM conceden lo mismo que antes (incluido leer lo propio). El
-- chat de actividad es estricto: si ya no estas, no lees ni lo tuyo.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view messages in their events or groups" ON public.messages;
CREATE POLICY "Users can view messages in their events or groups"
  ON public.messages FOR SELECT TO authenticated
  USING (
    NOT public.is_blocked(auth.uid(), sender_id)
    AND (
      (group_id IS NOT NULL
        AND (sender_id = auth.uid() OR public.is_group_member(group_id, auth.uid())))
      OR (event_id IS NOT NULL AND public.can_access_event_chat(event_id))
    )
  );

DROP POLICY IF EXISTS "Members can send messages" ON public.messages;
CREATE POLICY "Members can send messages"
  ON public.messages FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND (
      (group_id IS NOT NULL AND event_id IS NULL AND public.is_group_member(group_id, auth.uid()))
      OR (event_id IS NOT NULL AND group_id IS NULL AND public.can_access_event_chat(event_id))
    )
  );

DROP POLICY IF EXISTS "Senders can edit own messages" ON public.messages;
CREATE POLICY "Senders can edit own messages"
  ON public.messages FOR UPDATE TO authenticated
  USING (
    sender_id = auth.uid()
    AND deleted_at IS NULL
    AND (
      (group_id IS NOT NULL AND public.is_group_member(group_id, auth.uid()))
      OR (event_id IS NOT NULL AND public.can_access_event_chat(event_id))
    )
  )
  WITH CHECK (sender_id = auth.uid());


-- ------------------------------------------------------------
-- 6a. Al enviar
--
-- DEFINER: tiene que mirar si cada mencionado esta en el chat. Sin sesion
-- (service_role, migraciones) no toca nada.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_message_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_recent  integer;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  -- Lo que describe el estado del mensaje lo pone el servidor.
  NEW.edited_at  := NULL;
  NEW.deleted_at := NULL;
  NEW.deleted_by := NULL;

  -- Un script no inunda un chat: 30 mensajes por minuto es mucho para una
  -- persona escribiendo.
  SELECT count(*) INTO v_recent
  FROM public.messages m
  WHERE m.sender_id = v_uid
    AND m.created_at > now() - interval '1 minute';
  IF v_recent >= 30 THEN
    RAISE EXCEPTION 'MESSAGE_RATE_LIMIT' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.is_announcement THEN
    IF NEW.event_id IS NULL OR NOT public.is_event_creator(NEW.event_id, v_uid) THEN
      RAISE EXCEPTION 'ANNOUNCEMENT_NOT_ALLOWED' USING ERRCODE = '42501';
    END IF;
    -- Un aviso llega aunque el chat este silenciado: se acota.
    IF (SELECT count(*) FROM public.messages m
        WHERE m.event_id = NEW.event_id AND m.is_announcement
          AND m.created_at > now() - interval '1 day') >= 5 THEN
      RAISE EXCEPTION 'ANNOUNCEMENT_RATE_LIMIT' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Menciones: se quedan solo las validas, sin error, igual que un @ mal
  -- escrito en cualquier chat simplemente no menciona a nadie.
  NEW.mentions := COALESCE(ARRAY(
    SELECT DISTINCT m
    FROM unnest(COALESCE(NEW.mentions, '{}'::uuid[])) AS m
    WHERE m IS NOT NULL
      AND m <> v_uid
      AND NOT public.is_blocked(v_uid, m)
      AND CASE
            WHEN NEW.event_id IS NOT NULL THEN public.event_chat_member(NEW.event_id, m)
            ELSE public.is_group_member(NEW.group_id, m)
          END
    LIMIT 10
  ), '{}'::uuid[]);

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_message_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_message_insert ON public.messages;
CREATE TRIGGER trg_guard_message_insert
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_message_insert();


-- ------------------------------------------------------------
-- 6b. Al editar o borrar
--
-- Mismo cuerpo que en 20260914000000 mas tres columnas bloqueadas y
-- deleted_by, que lo pone el servidor: quien borra (autor u organizador).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_message_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.id              IS DISTINCT FROM OLD.id
  OR NEW.sender_id       IS DISTINCT FROM OLD.sender_id
  OR NEW.group_id        IS DISTINCT FROM OLD.group_id
  OR NEW.event_id        IS DISTINCT FROM OLD.event_id
  OR NEW.created_at      IS DISTINCT FROM OLD.created_at
  OR NEW.expires_at      IS DISTINCT FROM OLD.expires_at
  OR NEW.mentions        IS DISTINCT FROM OLD.mentions
  OR NEW.is_announcement IS DISTINCT FROM OLD.is_announcement THEN
    RAISE EXCEPTION 'MESSAGE_FIELD_LOCKED' USING ERRCODE = '42501';
  END IF;

  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'MESSAGE_DELETED' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.deleted_at IS NOT NULL THEN
    NEW.deleted_at := now();
    NEW.deleted_by := auth.uid();
    NEW.content    := '';
    NEW.edited_at  := OLD.edited_at;
    RETURN NEW;
  END IF;

  NEW.deleted_by := OLD.deleted_by;

  IF NEW.content IS DISTINCT FROM OLD.content THEN
    IF NEW.content IS NULL OR length(btrim(NEW.content)) = 0 THEN
      RAISE EXCEPTION 'EMPTY_MESSAGE' USING ERRCODE = 'P0001';
    END IF;
    NEW.content   := btrim(NEW.content);
    NEW.edited_at := now();
  ELSE
    NEW.edited_at := OLD.edited_at;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_message_update() FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 6c. Entrar y salir del chat va con la participacion
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_event_chat_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'events' THEN
    INSERT INTO public.event_chat_state (event_id, user_id)
    VALUES (NEW.id, NEW.creator_id)
    ON CONFLICT (event_id, user_id) DO NOTHING;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.event_chat_state
    WHERE event_id = OLD.event_id AND user_id = OLD.user_id
      AND NOT EXISTS (SELECT 1 FROM public.events e WHERE e.id = OLD.event_id AND e.creator_id = OLD.user_id);
    RETURN OLD;
  END IF;

  -- INSERT o UPDATE hacia 'joined': quien entra empieza al dia. Lo que se
  -- dijo antes lo puede leer, pero no le aparece como pendiente.
  IF NEW.status = 'joined' THEN
    INSERT INTO public.event_chat_state (event_id, user_id)
    VALUES (NEW.event_id, NEW.user_id)
    ON CONFLICT (event_id, user_id) DO UPDATE
      SET last_read_at = now(), updated_at = now();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sync_event_chat_state() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_event_chat_state_creator ON public.events;
CREATE TRIGGER trg_event_chat_state_creator
  AFTER INSERT ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.sync_event_chat_state();

DROP TRIGGER IF EXISTS trg_event_chat_state_join ON public.event_participants;
CREATE TRIGGER trg_event_chat_state_join
  AFTER INSERT OR UPDATE OF status ON public.event_participants
  FOR EACH ROW
  WHEN (NEW.status = 'joined')
  EXECUTE FUNCTION public.sync_event_chat_state();

DROP TRIGGER IF EXISTS trg_event_chat_state_leave ON public.event_participants;
CREATE TRIGGER trg_event_chat_state_leave
  AFTER DELETE ON public.event_participants
  FOR EACH ROW EXECUTE FUNCTION public.sync_event_chat_state();

-- Los que ya estaban: al dia (el chat de actividad no tenia mensajes).
INSERT INTO public.event_chat_state (event_id, user_id)
SELECT e.id, e.creator_id FROM public.events e
ON CONFLICT (event_id, user_id) DO NOTHING;

INSERT INTO public.event_chat_state (event_id, user_id)
SELECT ep.event_id, ep.user_id FROM public.event_participants ep WHERE ep.status = 'joined'
ON CONFLICT (event_id, user_id) DO NOTHING;


-- ------------------------------------------------------------
-- 6d. Expulsado no vuelve a entrar solo
--
-- Mismo cuerpo que 20260820000000 mas la comprobacion de event_removals.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_participant_initial_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_privacy    text;
  v_creator_id uuid;
BEGIN
  SELECT privacy, creator_id INTO v_privacy, v_creator_id
  FROM public.events WHERE id = NEW.event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EVENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.event_removals r
    WHERE r.event_id = NEW.event_id AND r.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'REMOVED_FROM_EVENT' USING ERRCODE = '42501';
  END IF;

  IF v_privacy = 'private' AND NEW.user_id <> v_creator_id THEN
    NEW.status := 'pending';
  ELSE
    NEW.status := 'joined';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_participant_initial_status() FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 6e. Bloquear tambien saca de las actividades del otro
--
-- Mismo cuerpo que 20260817010000 mas el ultimo DELETE. El acceso al chat
-- ya se corta solo (event_chat_member mira is_blocked); esto ademas libera
-- la plaza en lo que todavia no ha terminado. Lo pasado se queda: borrar
-- la participacion se llevaria el historial de asistencia.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.on_block_cleanup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dm_name text;
BEGIN
  DELETE FROM public.friendships
  WHERE (requester_id = NEW.blocker_id AND addressee_id = NEW.blocked_id)
     OR (requester_id = NEW.blocked_id AND addressee_id = NEW.blocker_id);

  v_dm_name := '__dm_' || least(NEW.blocker_id, NEW.blocked_id)::text
                       || '_' || greatest(NEW.blocker_id, NEW.blocked_id)::text;

  DELETE FROM public.group_members
  WHERE user_id IN (NEW.blocker_id, NEW.blocked_id)
    AND group_id IN (SELECT id FROM public.groups WHERE name = v_dm_name);

  DELETE FROM public.event_participants ep
  USING public.events e
  WHERE e.id = ep.event_id
    AND e.ends_at > now()
    AND (
      (e.creator_id = NEW.blocker_id AND ep.user_id = NEW.blocked_id)
      OR (e.creator_id = NEW.blocked_id AND ep.user_id = NEW.blocker_id)
    );

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.on_block_cleanup() FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 7. RPC del chat
-- ------------------------------------------------------------

-- Cabecera del chat: lo que necesita la pantalla sobre quien la abre.
CREATE OR REPLACE FUNCTION public.event_chat_summary(_event_id uuid)
RETURNS TABLE (
  can_access   boolean,
  is_organizer boolean,
  removed      boolean,
  muted        boolean,
  last_read_at timestamptz,
  unread       bigint,
  member_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_access boolean;
  v_state  public.event_chat_state%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  v_access := public.event_chat_member(_event_id, v_uid);

  IF NOT v_access THEN
    -- Sin acceso no se cuenta nada del chat: solo si te expulsaron, que es
    -- una fila tuya y ya la puedes leer por RLS.
    RETURN QUERY SELECT false, false,
      EXISTS (SELECT 1 FROM public.event_removals r WHERE r.event_id = _event_id AND r.user_id = v_uid),
      false, NULL::timestamptz, 0::bigint, 0;
    RETURN;
  END IF;

  SELECT * INTO v_state FROM public.event_chat_state s
  WHERE s.event_id = _event_id AND s.user_id = v_uid;

  RETURN QUERY
  SELECT
    true,
    public.is_event_creator(_event_id, v_uid),
    false,
    COALESCE(v_state.muted, false),
    v_state.last_read_at,
    (SELECT count(*) FROM public.messages m
      WHERE m.event_id = _event_id
        AND m.sender_id <> v_uid
        AND m.deleted_at IS NULL
        AND m.created_at > COALESCE(v_state.last_read_at, now())
        AND NOT public.is_blocked(v_uid, m.sender_id)),
    (SELECT 1 + count(*)::int FROM public.event_participants ep
      JOIN public.events e ON e.id = ep.event_id
      WHERE ep.event_id = _event_id AND ep.status = 'joined' AND ep.user_id <> e.creator_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.event_chat_summary(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.event_chat_summary(uuid) TO authenticated;


-- Quien esta en el chat, para la lista de miembros y las menciones.
-- Organizador primero. Sin bloqueados en ningun sentido.
CREATE OR REPLACE FUNCTION public.event_chat_members(_event_id uuid)
RETURNS TABLE (
  user_id      uuid,
  name         text,
  avatar_url   text,
  is_organizer boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ev AS (
    SELECT e.id, e.creator_id FROM public.events e
    WHERE e.id = _event_id AND public.event_chat_member(_event_id, auth.uid())
  ), gente AS (
    SELECT ev.creator_id AS uid, true AS org, NULL::timestamptz AS desde FROM ev
    UNION ALL
    SELECT ep.user_id, false, ep.joined_at
    FROM public.event_participants ep JOIN ev ON ev.id = ep.event_id
    WHERE ep.status = 'joined' AND ep.user_id <> ev.creator_id
      AND NOT public.is_blocked(ep.user_id, ev.creator_id)
  )
  SELECT p.id, p.name, p.avatar_url, g.org
  FROM gente g
  JOIN public.profiles p ON p.id = g.uid
  WHERE p.id = auth.uid() OR NOT public.is_blocked(auth.uid(), p.id)
  ORDER BY g.org DESC, g.desde ASC NULLS FIRST, p.id;
$$;

REVOKE EXECUTE ON FUNCTION public.event_chat_members(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.event_chat_members(uuid) TO authenticated;


-- Marcar leido. Solo si estas en el chat.
CREATE OR REPLACE FUNCTION public.mark_event_chat_read(_event_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.event_chat_member(_event_id, v_uid) THEN
    RETURN;
  END IF;
  INSERT INTO public.event_chat_state (event_id, user_id, last_read_at)
  VALUES (_event_id, v_uid, now())
  ON CONFLICT (event_id, user_id) DO UPDATE
    SET last_read_at = now(), updated_at = now();
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mark_event_chat_read(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.mark_event_chat_read(uuid) TO authenticated;


-- Silenciar o reactivar los avisos de mensajes de una actividad.
CREATE OR REPLACE FUNCTION public.set_event_chat_muted(_event_id uuid, _muted boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.event_chat_member(_event_id, v_uid) THEN
    RAISE EXCEPTION 'NOT_A_CHAT_MEMBER' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.event_chat_state (event_id, user_id, muted)
  VALUES (_event_id, v_uid, COALESCE(_muted, false))
  ON CONFLICT (event_id, user_id) DO UPDATE
    SET muted = COALESCE(_muted, false), updated_at = now();
  RETURN COALESCE(_muted, false);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_event_chat_muted(uuid, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_event_chat_muted(uuid, boolean) TO authenticated;


-- "Lo estoy viendo": la app lo renueva cada ~30 s con el chat abierto y lo
-- apaga al salir. Mientras dure, no se manda push de ese chat (el mensaje
-- ya llega por tiempo real) y cuenta como leido.
CREATE OR REPLACE FUNCTION public.set_event_chat_presence(_event_id uuid, _active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.event_chat_member(_event_id, v_uid) THEN
    RETURN;
  END IF;
  INSERT INTO public.event_chat_state (event_id, user_id, last_read_at, active_until)
  VALUES (_event_id, v_uid, now(), CASE WHEN _active THEN now() + interval '45 seconds' END)
  ON CONFLICT (event_id, user_id) DO UPDATE
    SET active_until = CASE WHEN _active THEN now() + interval '45 seconds' END,
        last_read_at = now(),
        updated_at   = now();
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_event_chat_presence(uuid, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_event_chat_presence(uuid, boolean) TO authenticated;


-- No leidos por actividad, para Mis eventos y la ficha del evento.
CREATE OR REPLACE FUNCTION public.event_chat_unread()
RETURNS TABLE (event_id uuid, unread bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.event_id, count(m.id)
  FROM public.event_chat_state s
  JOIN public.messages m
    ON m.event_id = s.event_id
   AND m.created_at > s.last_read_at
   AND m.sender_id <> s.user_id
   AND m.deleted_at IS NULL
  WHERE s.user_id = auth.uid()
    AND public.event_chat_member(s.event_id, s.user_id)
    AND NOT public.is_blocked(s.user_id, m.sender_id)
  GROUP BY s.event_id;
$$;

REVOKE EXECUTE ON FUNCTION public.event_chat_unread() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.event_chat_unread() TO authenticated;


-- ------------------------------------------------------------
-- 7b. Moderacion del organizador
-- ------------------------------------------------------------

-- Borra (logicamente) un mensaje de SU actividad. Pasa por
-- guard_message_update igual que un borrado del autor: vacia el texto y
-- apunta en deleted_by quien lo hizo.
CREATE OR REPLACE FUNCTION public.moderate_event_message(_message_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_msg record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT m.id, m.event_id, m.sender_id, m.deleted_at INTO v_msg
  FROM public.messages m WHERE m.id = _message_id;

  -- Mismo error si no existe o si no es de una actividad tuya.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_THE_ORGANIZER' USING ERRCODE = '42501';
  END IF;
  IF v_msg.event_id IS NULL OR NOT public.is_event_creator(v_msg.event_id, v_uid) THEN
    RAISE EXCEPTION 'NOT_THE_ORGANIZER' USING ERRCODE = '42501';
  END IF;

  IF v_msg.deleted_at IS NOT NULL THEN
    RETURN;
  END IF;

  UPDATE public.messages SET deleted_at = now() WHERE id = _message_id;

  INSERT INTO public.event_moderation_log (event_id, actor_id, action, target_user_id, message_id)
  VALUES (v_msg.event_id, v_uid, 'delete_message', v_msg.sender_id, _message_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.moderate_event_message(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.moderate_event_message(uuid) TO authenticated;


-- Expulsa a un participante (unido o pendiente) de SU actividad.
CREATE OR REPLACE FUNCTION public.remove_event_participant(_event_id uuid, _user_id uuid, _reason text DEFAULT NULL)
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
  IF NOT public.is_event_creator(_event_id, v_uid) THEN
    RAISE EXCEPTION 'NOT_THE_ORGANIZER' USING ERRCODE = '42501';
  END IF;
  IF _user_id IS NULL OR _user_id = v_uid THEN
    RAISE EXCEPTION 'INVALID_TARGET' USING ERRCODE = 'P0001';
  END IF;

  -- Misma serializacion que respond_to_join_request: el evento primero.
  PERFORM 1 FROM public.events WHERE id = _event_id FOR UPDATE;

  DELETE FROM public.event_participants
  WHERE event_id = _event_id AND user_id = _user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_A_PARTICIPANT' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.event_removals (event_id, user_id, removed_by, reason)
  VALUES (_event_id, _user_id, v_uid, left(nullif(btrim(COALESCE(_reason, '')), ''), 300))
  ON CONFLICT (event_id, user_id) DO UPDATE
    SET removed_by = EXCLUDED.removed_by, reason = EXCLUDED.reason, created_at = now();

  INSERT INTO public.event_moderation_log (event_id, actor_id, action, target_user_id)
  VALUES (_event_id, v_uid, 'remove_participant', _user_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.remove_event_participant(uuid, uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.remove_event_participant(uuid, uuid, text) TO authenticated;


-- Deshace una expulsion: la persona puede volver a unirse (o pedirlo).
CREATE OR REPLACE FUNCTION public.readmit_event_participant(_event_id uuid, _user_id uuid)
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
  IF NOT public.is_event_creator(_event_id, v_uid) THEN
    RAISE EXCEPTION 'NOT_THE_ORGANIZER' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.event_removals WHERE event_id = _event_id AND user_id = _user_id;
  IF FOUND THEN
    INSERT INTO public.event_moderation_log (event_id, actor_id, action, target_user_id)
    VALUES (_event_id, v_uid, 'readmit_participant', _user_id);
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.readmit_event_participant(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.readmit_event_participant(uuid, uuid) TO authenticated;


-- Expulsados de una actividad, para poder deshacerlo. Solo el organizador.
CREATE OR REPLACE FUNCTION public.event_removed_people(_event_id uuid)
RETURNS TABLE (user_id uuid, name text, avatar_url text, removed_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.user_id, p.name, p.avatar_url, r.created_at
  FROM public.event_removals r
  JOIN public.profiles p ON p.id = r.user_id
  WHERE r.event_id = _event_id
    AND public.is_event_creator(_event_id, auth.uid())
  ORDER BY r.created_at DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.event_removed_people(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.event_removed_people(uuid) TO authenticated;


-- ------------------------------------------------------------
-- 8. notification_counts gana event_chat_unread
--
-- Cambia la forma del resultado: hay que borrarla y crearla (42P13). Las
-- cinco columnas de antes quedan igual y en el mismo orden; la version de
-- la App Store ignora la nueva.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.notification_counts();

CREATE FUNCTION public.notification_counts()
RETURNS TABLE (
  join_requests     bigint,
  friend_requests   bigint,
  unread_messages   bigint,
  approvals         bigint,
  group_invites     bigint,
  event_chat_unread bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (SELECT count(*)
       FROM public.event_participants p
       JOIN public.events e ON e.id = p.event_id
      WHERE e.creator_id = auth.uid()
        AND e.is_active
        AND p.status = 'pending'),

    (SELECT count(*)
       FROM public.friendships f
      WHERE f.addressee_id = auth.uid()
        AND f.status = 'pending'
        AND NOT public.is_blocked(auth.uid(), f.requester_id)),

    (SELECT count(*)
       FROM public.group_members gm
       JOIN public.messages m ON m.group_id = gm.group_id
      WHERE gm.user_id   = auth.uid()
        AND m.sender_id <> auth.uid()
        AND m.created_at > gm.last_read_at
        AND m.deleted_at IS NULL
        AND NOT public.is_blocked(auth.uid(), m.sender_id)),

    (SELECT count(*)
       FROM public.event_participants p
       JOIN public.events e ON e.id = p.event_id
      WHERE p.user_id = auth.uid()
        AND p.approved_at IS NOT NULL
        AND p.approval_seen = false
        AND e.is_active),

    (SELECT count(*)
       FROM public.group_invites gi
      WHERE gi.invitee_id = auth.uid()
        AND gi.status = 'pending'
        AND NOT public.is_blocked(auth.uid(), gi.inviter_id)),

    -- Solo actividades activas: las canceladas ya no se listan en ningun
    -- sitio, y un globo que no lleva a ninguna parte no se puede apagar.
    (SELECT count(*)
       FROM public.event_chat_state s
       JOIN public.events e   ON e.id = s.event_id AND e.is_active
       JOIN public.messages m ON m.event_id = s.event_id
      WHERE s.user_id = auth.uid()
        AND m.created_at > s.last_read_at
        AND m.sender_id <> s.user_id
        AND m.deleted_at IS NULL
        AND public.event_chat_member(s.event_id, s.user_id)
        AND NOT public.is_blocked(s.user_id, m.sender_id));
$$;

REVOKE EXECUTE ON FUNCTION public.notification_counts() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.notification_counts() TO authenticated;


-- ------------------------------------------------------------
-- 9. Push del chat de actividad
--
-- Version sencilla, con lo que ya hay (push_send). 20260925000000 la
-- sustituye por la cola de notificaciones. Reglas:
--   * nunca a quien escribe ni a quien esta bloqueado con quien escribe;
--   * nunca a quien tiene el chat abierto (active_until);
--   * una mencion o un aviso del organizador siempre avisa, aunque el
--     chat este silenciado;
--   * los mensajes normales respetan el silencio y se agrupan: tras un
--     aviso, no hay otro hasta pasados 3 minutos si no has leido nada.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_event_chat_message(_msg public.messages)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event  record;
  v_sender text;
  v_title  text;
  v_body   text;
  r        record;
BEGIN
  SELECT e.id, e.title, e.creator_id INTO v_event FROM public.events e WHERE e.id = _msg.event_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(NULLIF(p.name, ''), 'Alguien') INTO v_sender
  FROM public.profiles p WHERE p.id = _msg.sender_id;
  v_sender := COALESCE(v_sender, 'Alguien');

  v_title := left(v_event.title, 80);
  v_body  := left(_msg.content, 120);
  IF length(_msg.content) > 120 THEN v_body := v_body || U&'\2026'; END IF;

  FOR r IN
    SELECT s.user_id, s.muted, s.active_until, s.last_pushed_at, s.last_read_at,
           (s.user_id = ANY (_msg.mentions)) AS mencionado
    FROM public.event_chat_state s
    WHERE s.event_id = _msg.event_id
      AND s.user_id <> _msg.sender_id
      AND public.event_chat_member(s.event_id, s.user_id)
      AND NOT public.is_blocked(s.user_id, _msg.sender_id)
  LOOP
    CONTINUE WHEN r.active_until IS NOT NULL AND r.active_until > now();

    IF _msg.is_announcement THEN
      PERFORM public.push_send(r.user_id, U&'Aviso del organizador \00B7 ' || v_title, v_body,
        jsonb_build_object('type', 'organizer_announcement', 'event_id', _msg.event_id));
    ELSIF r.mencionado THEN
      PERFORM public.push_send(r.user_id, v_sender || U&' te mencion\00F3', v_title || ': ' || v_body,
        jsonb_build_object('type', 'chat_mention', 'event_id', _msg.event_id));
    ELSE
      CONTINUE WHEN r.muted;
      CONTINUE WHEN r.last_pushed_at IS NOT NULL
                AND r.last_pushed_at > now() - interval '3 minutes'
                AND r.last_read_at < r.last_pushed_at;
      PERFORM public.push_send(r.user_id, v_title, v_sender || ': ' || v_body,
        jsonb_build_object('type', 'event_message', 'event_id', _msg.event_id));
    END IF;

    UPDATE public.event_chat_state SET last_pushed_at = now()
    WHERE event_id = _msg.event_id AND user_id = r.user_id;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.notify_event_chat_message(public.messages) FROM PUBLIC, anon, authenticated;

-- on_message_push: mismo cuerpo que 20260827000000 para grupos y DM; la
-- rama de actividad pasa a notify_event_chat_message.
CREATE OR REPLACE FUNCTION public.on_message_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group  text;
  v_sender text;
  v_title  text;
  v_body   text;
  r        RECORD;
BEGIN
  IF NEW.event_id IS NOT NULL THEN
    PERFORM public.notify_event_chat_message(NEW);
    RETURN NEW;
  END IF;

  IF NEW.group_id IS NULL THEN RETURN NEW; END IF;

  SELECT g.name INTO v_group FROM public.groups g WHERE g.id = NEW.group_id;

  SELECT COALESCE(NULLIF(p.name, ''), 'Alguien') INTO v_sender
  FROM   public.profiles p WHERE p.id = NEW.sender_id;
  v_sender := COALESCE(v_sender, 'Alguien');

  v_body := left(NEW.content, 120);
  IF length(NEW.content) > 120 THEN v_body := v_body || U&'\2026'; END IF;

  IF left(COALESCE(v_group, ''), 5) = '__dm_' THEN
    v_title := v_sender;
  ELSE
    v_title := COALESCE(v_group, 'Grupo');
    v_body  := v_sender || ': ' || v_body;
  END IF;

  FOR r IN
    SELECT gm.user_id
    FROM   public.group_members gm
    WHERE  gm.group_id  = NEW.group_id
      AND  gm.user_id  <> NEW.sender_id
      AND  NOT public.is_blocked(gm.user_id, NEW.sender_id)
  LOOP
    PERFORM public.push_send(
      r.user_id, v_title, v_body,
      jsonb_build_object('type', 'message', 'group_id', NEW.group_id)
    );
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.on_message_push() FROM PUBLIC, anon, authenticated;

COMMIT;
