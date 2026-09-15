-- ============================================================
-- Despues del evento: repetir el plan y convertirlo en grupo
--
-- Decisiones de Sebastian (2026-09-15):
--   * "Repetir el plan" crea un evento nuevo copiado del anterior y AVISA
--     por push a quienes fueron la vez anterior.
--   * "Convertir en grupo" crea un grupo e INVITA a quienes fueron; cada
--     persona entra solo si acepta. Nadie aparece en un chat sin querer.
--
-- Lo que hay:
--   1. events.repeated_from: de que evento sale. Solo lo puede poner quien
--      organizo o se unio al original, y no se cambia despues.
--   2. Push al publicar una repeticion, a quien fue y puede ver el evento
--      nuevo. Una vez por original y persona cada 12 horas.
--   3. groups.source_event_id y group_invites (sin acceso directo: todo
--      por funciones).
--   4. create_group_from_event, my_group_invites, respond_group_invite.
--   5. notification_counts suma group_invites.
--
-- No borra ni reescribe datos. ASCII puro (textos con U&'...').
-- Idempotente: se puede pegar dos veces.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Repetir el plan
-- ------------------------------------------------------------
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS repeated_from uuid REFERENCES public.events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS events_repeated_from_idx
  ON public.events (repeated_from) WHERE repeated_from IS NOT NULL;

CREATE OR REPLACE FUNCTION public.guard_event_repeat()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.repeated_from IS DISTINCT FROM OLD.repeated_from THEN
      RAISE EXCEPTION 'REPEAT_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.repeated_from IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.events o
    WHERE o.id = NEW.repeated_from
      AND (
        o.creator_id = NEW.creator_id
        OR EXISTS (
          SELECT 1 FROM public.event_participants ep
          WHERE ep.event_id = o.id AND ep.user_id = NEW.creator_id AND ep.status = 'joined'
        )
      )
  ) THEN
    RAISE EXCEPTION 'REPEAT_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_event_repeat() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_event_repeat ON public.events;
CREATE TRIGGER trg_guard_event_repeat
  BEFORE INSERT OR UPDATE OF repeated_from ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_repeat();

-- ------------------------------------------------------------
-- 2. Aviso a quienes fueron
--
-- Solo a quien puede ver el evento nuevo (mismas reglas que
-- "Events visibility policy"): repetir un plan como "solo amigos" no
-- avisa a quien no es amigo. Tope de 100 avisos.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.on_event_repeat_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_who text;
  r record;
BEGIN
  -- Publicar y borrar para volver a publicar no vuelve a avisar.
  IF EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.repeated_from = NEW.repeated_from
      AND e.creator_id = NEW.creator_id
      AND e.id <> NEW.id
      AND e.created_at > now() - interval '12 hours'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(p.name, ''), 'Alguien') INTO v_who
  FROM public.profiles p WHERE p.id = NEW.creator_id;

  FOR r IN
    SELECT DISTINCT g.uid
    FROM (
      SELECT o.creator_id AS uid FROM public.events o WHERE o.id = NEW.repeated_from
      UNION
      SELECT ep.user_id FROM public.event_participants ep
      WHERE ep.event_id = NEW.repeated_from AND ep.status = 'joined'
    ) g
    WHERE g.uid <> NEW.creator_id
      AND NOT public.is_blocked(g.uid, NEW.creator_id)
      AND public.same_institution(g.uid, NEW.creator_id)
      AND (
        NEW.privacy IN ('open', 'private')
        OR (NEW.privacy = 'friends' AND public.are_friends(NEW.creator_id, g.uid))
      )
    LIMIT 100
  LOOP
    PERFORM public.push_send(
      r.uid,
      'Se repite un plan',
      COALESCE(v_who, 'Alguien') || U&' organiz\00F3 otra vez \00AB' || NEW.title || U&'\00BB. \00BFTe apuntas?',
      jsonb_build_object('type', 'event_repeat', 'event_id', NEW.id)
    );
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.on_event_repeat_push() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_event_repeat_push ON public.events;
CREATE TRIGGER trg_event_repeat_push
  AFTER INSERT ON public.events
  FOR EACH ROW
  WHEN (NEW.repeated_from IS NOT NULL)
  EXECUTE FUNCTION public.on_event_repeat_push();

-- ------------------------------------------------------------
-- 3. Grupos que salen de un evento, e invitaciones
-- ------------------------------------------------------------
ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS source_event_id uuid REFERENCES public.events(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.group_invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  inviter_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invitee_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_event_id uuid REFERENCES public.events(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  responded_at    timestamptz,
  UNIQUE (group_id, invitee_id),
  CONSTRAINT group_invites_no_self CHECK (inviter_id <> invitee_id)
);

CREATE INDEX IF NOT EXISTS group_invites_pending_idx
  ON public.group_invites (invitee_id) WHERE status = 'pending';

-- Sin politicas: ni se lee ni se escribe directo, solo por las funciones.
ALTER TABLE public.group_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.group_invites FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 4a. create_group_from_event
--
-- Quien organizo o se unio a un evento que ya empezo crea el grupo, entra
-- (lo mete trg_group_created_add_creator) e invita al resto. Llamarla dos
-- veces para el mismo evento devuelve el mismo grupo: no se puede usar para
-- mandar invitaciones en bucle.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_group_from_event(_event_id uuid, _name text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_ev    record;
  v_group uuid;
  v_name  text;
  v_who   text;
  r       record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT e.id, e.title, e.creator_id, e.starts_at INTO v_ev
  FROM public.events e WHERE e.id = _event_id;

  -- Mismo error si no existe o si no fuiste: no confirma que exista. Van en
  -- dos IF porque plpgsql no garantiza cortocircuito y leer v_ev sin fila
  -- falla.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_AN_ATTENDEE' USING ERRCODE = '42501';
  END IF;
  IF NOT (
    v_ev.creator_id = v_uid
    OR EXISTS (
      SELECT 1 FROM public.event_participants ep
      WHERE ep.event_id = _event_id AND ep.user_id = v_uid AND ep.status = 'joined'
    )
  ) THEN
    RAISE EXCEPTION 'NOT_AN_ATTENDEE' USING ERRCODE = '42501';
  END IF;

  IF v_ev.starts_at > now() THEN
    RAISE EXCEPTION 'EVENT_NOT_STARTED' USING ERRCODE = 'P0001';
  END IF;

  SELECT g.id INTO v_group
  FROM public.groups g
  WHERE g.source_event_id = _event_id AND g.created_by = v_uid
  ORDER BY g.created_at
  LIMIT 1;
  IF v_group IS NOT NULL THEN
    RETURN v_group;
  END IF;

  v_name := left(btrim(COALESCE(_name, '')), 60);
  IF v_name = '' THEN
    v_name := left(v_ev.title, 60);
  END IF;
  -- Los DM son grupos '__dm_...': un nombre asi se colaria como DM.
  IF v_name LIKE '\_\_dm\_%' THEN
    RAISE EXCEPTION 'INVALID_NAME' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.groups (name, created_by, source_event_id)
  VALUES (v_name, v_uid, _event_id)
  RETURNING id INTO v_group;

  SELECT COALESCE(NULLIF(p.name, ''), 'Alguien') INTO v_who
  FROM public.profiles p WHERE p.id = v_uid;

  FOR r IN
    SELECT DISTINCT g.uid
    FROM (
      SELECT v_ev.creator_id AS uid
      UNION
      SELECT ep.user_id FROM public.event_participants ep
      WHERE ep.event_id = _event_id AND ep.status = 'joined'
    ) g
    WHERE g.uid <> v_uid
      AND NOT public.is_blocked(v_uid, g.uid)
    LIMIT 100
  LOOP
    INSERT INTO public.group_invites (group_id, inviter_id, invitee_id, source_event_id)
    VALUES (v_group, v_uid, r.uid, _event_id)
    ON CONFLICT (group_id, invitee_id) DO NOTHING;

    PERFORM public.push_send(
      r.uid,
      'Te invitaron a un grupo',
      COALESCE(v_who, 'Alguien') || U&' te invit\00F3 a \00AB' || v_name || U&'\00BB',
      jsonb_build_object('type', 'group_invite', 'group_id', v_group)
    );
  END LOOP;

  RETURN v_group;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_group_from_event(uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_group_from_event(uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- 4b. my_group_invites: las pendientes, sin las de gente bloqueada.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_group_invites()
RETURNS TABLE (
  invite_id      uuid,
  group_id       uuid,
  group_name     text,
  inviter_id     uuid,
  inviter_name   text,
  inviter_avatar text,
  event_title    text,
  created_at     timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT gi.id, gi.group_id, g.name, gi.inviter_id, p.name, p.avatar_url, e.title, gi.created_at
  FROM public.group_invites gi
  JOIN public.groups g ON g.id = gi.group_id
  JOIN public.profiles p ON p.id = gi.inviter_id
  LEFT JOIN public.events e ON e.id = gi.source_event_id
  WHERE gi.invitee_id = auth.uid()
    AND gi.status = 'pending'
    AND NOT public.is_blocked(auth.uid(), gi.inviter_id)
  ORDER BY gi.created_at DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.my_group_invites() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.my_group_invites() TO authenticated;

-- ------------------------------------------------------------
-- 4c. respond_group_invite: aceptar mete en el grupo; rechazar no avisa.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.respond_group_invite(_invite_id uuid, _accept boolean)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_inv record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT gi.id, gi.group_id, gi.inviter_id, gi.status INTO v_inv
  FROM public.group_invites gi
  WHERE gi.id = _invite_id AND gi.invitee_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF public.is_blocked(v_uid, v_inv.inviter_id) THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_inv.status <> 'pending' THEN
    IF v_inv.status = 'accepted' AND _accept THEN
      RETURN v_inv.group_id;
    END IF;
    RAISE EXCEPTION 'INVITE_ALREADY_ANSWERED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.group_invites
  SET status = CASE WHEN _accept THEN 'accepted' ELSE 'declined' END,
      responded_at = now()
  WHERE id = v_inv.id;

  IF _accept THEN
    INSERT INTO public.group_members (group_id, user_id)
    VALUES (v_inv.group_id, v_uid)
    ON CONFLICT (group_id, user_id) DO NOTHING;
    RETURN v_inv.group_id;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.respond_group_invite(uuid, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.respond_group_invite(uuid, boolean) TO authenticated;

-- ------------------------------------------------------------
-- 5. notification_counts con group_invites
--
-- Cambia la forma del resultado, asi que hay que borrarla y crearla. Las
-- cuatro columnas de antes quedan igual y en el mismo orden: la version de
-- la App Store ignora la nueva.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.notification_counts();

CREATE FUNCTION public.notification_counts()
RETURNS TABLE (
  join_requests   bigint,
  friend_requests bigint,
  unread_messages bigint,
  approvals       bigint,
  group_invites   bigint
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
        AND NOT public.is_blocked(auth.uid(), gi.inviter_id));
$$;

REVOKE EXECUTE ON FUNCTION public.notification_counts() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.notification_counts() TO authenticated;

COMMIT;
