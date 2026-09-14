-- ============================================================
-- Chat: editar y borrar mensajes propios, y ordenar por actividad.
--
-- Tres cosas, en este orden:
--   1. messages.edited_at / messages.deleted_at, un disparador que
--      protege los campos que no se pueden tocar, la politica de
--      UPDATE para el autor y la retirada del DELETE directo.
--   2. Los contadores de no leidos dejan de contar mensajes borrados.
--   3. friends_page y chat_summaries devuelven el ultimo mensaje de
--      cada chat para poder ordenar por actividad.
--
-- Comentarios en ASCII a proposito: este archivo se pega en el SQL
-- Editor y con acentos ya salio con mojibake alguna vez.
--
-- Idempotente: se puede pegar dos veces.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Columnas
--
-- Nulas por defecto: los mensajes que ya existen quedan como "ni
-- editados ni borrados", que es la verdad.
-- ------------------------------------------------------------
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS edited_at  timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;


-- ------------------------------------------------------------
-- 2. Que se puede cambiar de un mensaje, y como.
--
-- La politica de abajo decide QUIEN puede actualizar (el autor). Esto
-- decide QUE: RLS no sabe de columnas, asi que sin el disparador el
-- autor podria mover su mensaje a otro chat, cambiarse el remitente o
-- reescribir la fecha.
--
-- Las fechas las pone el servidor, nunca el cliente:
--   * editar  -> edited_at = now()
--   * borrar  -> deleted_at = now() y el texto se VACIA. Decidido asi
--     (2026-09-14): la politica de SELECT y el tiempo real mandan la
--     fila entera a cada participante, asi que un texto "oculto" que
--     siguiera en la columna seguiria siendo legible por la API.
--
-- Un mensaje borrado ya no se puede editar ni "desborrar".
--
-- Sin auth.uid() (service_role, cron, panel) no se aplica: la purga de
-- 90 dias y la moderacion desde el panel siguen funcionando igual.
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

  IF NEW.id         IS DISTINCT FROM OLD.id
  OR NEW.sender_id  IS DISTINCT FROM OLD.sender_id
  OR NEW.group_id   IS DISTINCT FROM OLD.group_id
  OR NEW.event_id   IS DISTINCT FROM OLD.event_id
  OR NEW.created_at IS DISTINCT FROM OLD.created_at
  OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'MESSAGE_FIELD_LOCKED' USING ERRCODE = '42501';
  END IF;

  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'MESSAGE_DELETED' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.deleted_at IS NOT NULL THEN
    NEW.deleted_at := now();
    NEW.content    := '';
    NEW.edited_at  := OLD.edited_at;
    RETURN NEW;
  END IF;

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

DROP TRIGGER IF EXISTS trg_guard_message_update ON public.messages;
CREATE TRIGGER trg_guard_message_update
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_message_update();


-- ------------------------------------------------------------
-- 3. Politicas
--
-- UPDATE: solo el autor, solo mientras no este borrado y solo si sigue
-- dentro del chat (mismas condiciones que para enviar). Quien salio de
-- un grupo no reescribe lo que dijo alli.
--
-- DELETE: se retira. Borrar la fila de verdad se llevaba por delante los
-- reportes que apuntan a ella (reports.reported_message_id es ON DELETE
-- CASCADE) y se saltaba el "Mensaje eliminado". Ahora todo borrado es
-- logico; la purga de 90 dias corre como service_role y no la necesita.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Senders can delete own messages" ON public.messages;
DROP POLICY IF EXISTS "Senders can edit own messages" ON public.messages;

CREATE POLICY "Senders can edit own messages"
  ON public.messages FOR UPDATE TO authenticated
  USING (
    sender_id = auth.uid()
    AND deleted_at IS NULL
    AND (
      (event_id IS NOT NULL AND public.is_event_participant(event_id, auth.uid()))
      OR (group_id IS NOT NULL AND public.is_group_member(group_id, auth.uid()))
    )
  )
  WITH CHECK (sender_id = auth.uid());


-- ------------------------------------------------------------
-- 4. No leidos: los borrados no cuentan.
--
-- Mismo cuerpo que en 20260822000000_approval-notice.sql (la ultima
-- version) mas "m.deleted_at IS NULL". La firma no cambia, asi que
-- basta con CREATE OR REPLACE.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notification_counts()
RETURNS TABLE (
  join_requests   bigint,
  friend_requests bigint,
  unread_messages bigint,
  approvals       bigint
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
        AND e.is_active);
$$;

REVOKE EXECUTE ON FUNCTION public.notification_counts() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.notification_counts() TO authenticated;


CREATE OR REPLACE FUNCTION public.unread_by_group()
RETURNS TABLE (group_id uuid, group_name text, unread bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.group_id, g.name, count(*)
    FROM public.group_members gm
    JOIN public.groups   g ON g.id = gm.group_id
    JOIN public.messages m ON m.group_id = gm.group_id
   WHERE gm.user_id   = auth.uid()
     AND m.sender_id <> auth.uid()
     AND m.created_at > gm.last_read_at
     AND m.deleted_at IS NULL
     AND NOT public.is_blocked(auth.uid(), m.sender_id)
   GROUP BY m.group_id, g.name;
$$;

REVOKE EXECUTE ON FUNCTION public.unread_by_group() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.unread_by_group() TO authenticated;


-- ------------------------------------------------------------
-- 5. Resumen de mis chats: el ultimo mensaje VISIBLE de cada uno.
--
-- SECURITY INVOKER a proposito: la RLS de messages sigue filtrando, asi
-- que un mensaje de alguien bloqueado nunca sale como vista previa.
-- Se salta los borrados: si el ultimo se borra, la vista previa pasa al
-- anterior y el chat baja en la lista a donde le toca.
--
-- El LATERAL con ORDER BY created_at DESC LIMIT 1 lo sirve el indice
-- messages_group_created_idx (group_id, created_at DESC).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.chat_summaries()
RETURNS TABLE (
  group_id        uuid,
  group_name      text,
  last_message_at timestamptz,
  last_content    text,
  last_sender_id  uuid
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT g.id, g.name, lm.created_at, lm.content, lm.sender_id
    FROM public.group_members gm
    JOIN public.groups g ON g.id = gm.group_id
    LEFT JOIN LATERAL (
      SELECT m.created_at, m.content, m.sender_id
        FROM public.messages m
       WHERE m.group_id = g.id
         AND m.deleted_at IS NULL
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 1
    ) lm ON true
   WHERE gm.user_id = auth.uid()
   -- Desempate total: dos chats con la misma fecha (o los dos sin
   -- mensajes) no se intercambian entre recargas.
   ORDER BY lm.created_at DESC NULLS LAST, g.name, g.id;
$$;

REVOKE EXECUTE ON FUNCTION public.chat_summaries() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.chat_summaries() TO authenticated;


-- ------------------------------------------------------------
-- 6. friends_page ordenada por la conversacion mas reciente.
--
-- Hay que borrarla: anadir columnas al RETURNS TABLE cambia el tipo de
-- retorno y CREATE OR REPLACE no puede (42P13). Las columnas viejas
-- siguen igual y en su sitio, asi que los builds de la App Store que la
-- llaman siguen funcionando (PostgREST solo manda campos de mas).
--
-- El DM se busca por su nombre (el mismo que arma create_dm) y entre los
-- grupos de los que soy miembro: un bug antiguo pudo dejar dos grupos con
-- el mismo nombre, y el bueno es el que tiene a las dos partes dentro.
--
-- Amigos sin chat van al final, por nombre, como antes.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.friends_page(integer, integer);

CREATE OR REPLACE FUNCTION public.friends_page(
  _limit  integer DEFAULT 15,
  _offset integer DEFAULT 0
)
RETURNS TABLE (
  id              uuid,
  name            text,
  avatar_url      text,
  major           text,
  total           bigint,
  dm_group_id     uuid,
  last_message_at timestamptz,
  last_content    text,
  last_sender_id  uuid
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    p.id,
    p.name,
    p.avatar_url,
    p.major,
    count(*) OVER () AS total,
    dm.id,
    lm.created_at,
    lm.content,
    lm.sender_id
  FROM public.friendships f
  JOIN public.public_profiles p
    ON p.id = CASE
                WHEN f.requester_id = auth.uid() THEN f.addressee_id
                ELSE f.requester_id
              END
  LEFT JOIN LATERAL (
    SELECT g.id
      FROM public.groups g
      JOIN public.group_members gm
        ON gm.group_id = g.id AND gm.user_id = auth.uid()
     WHERE g.name = '__dm_' || least(auth.uid(), p.id)::text
                   || '_' || greatest(auth.uid(), p.id)::text
     ORDER BY g.created_at
     LIMIT 1
  ) dm ON true
  LEFT JOIN LATERAL (
    SELECT m.created_at, m.content, m.sender_id
      FROM public.messages m
     WHERE m.group_id = dm.id
       AND m.deleted_at IS NULL
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT 1
  ) lm ON true
  WHERE f.status = 'accepted'
    AND (f.requester_id = auth.uid() OR f.addressee_id = auth.uid())
  ORDER BY lm.created_at DESC NULLS LAST, p.name NULLS LAST, p.id
  LIMIT  least(greatest(_limit, 1), 100)
  OFFSET greatest(_offset, 0);
$$;

REVOKE EXECUTE ON FUNCTION public.friends_page(integer, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.friends_page(integer, integer) TO authenticated;

COMMIT;


-- ============================================================
-- Comprobacion: columnas, disparador, politicas y funciones.
-- ============================================================
SELECT 'columna' AS que, column_name::text AS detalle
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'messages'
   AND column_name IN ('edited_at', 'deleted_at')
UNION ALL
SELECT 'disparador', tgname::text FROM pg_trigger
 WHERE tgname = 'trg_guard_message_update'
UNION ALL
SELECT 'politica ' || cmd, policyname::text FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'messages'
UNION ALL
SELECT 'funcion', p.proname::text FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('chat_summaries', 'friends_page', 'unread_by_group', 'notification_counts')
ORDER BY 1, 2;
