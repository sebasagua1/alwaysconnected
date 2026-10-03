-- ============================================================
-- Auditoria de UI 1.3.1 (hallazgos 5 y 9): archivar avisos y paginar la
-- bandeja sin perder ninguno
--
-- 9. my_notifications ordena por (updated_at DESC, id DESC) pero paginaba
--    solo con updated_at < _before. Varios avisos creados en la misma
--    transaccion comparten updated_at (now() es la hora de inicio de la
--    transaccion: pasa con los lotes de recordatorios, recomendaciones y
--    resumenes). Si una pagina terminaba en medio de ese empate, el resto
--    no salia nunca. El cursor pasa a ser el par (updated_at, id).
--
-- 5. Un aviso leido se quedaba en la bandeja hasta la purga de los 60 dias
--    y no habia forma de quitarlo. Ahora se puede archivar, y deshacerlo.
--
-- Lo que hace esta migracion:
--   1. notifications.archived_at.
--   2. my_notifications gana _before_id y deja fuera lo archivado.
--   3. archive_notifications / unarchive_notifications.
--
-- Compatible con la app ya publicada (1.3 y 1.3.1): siguen llamando a
-- my_notifications con _before y _limit, por nombre, y esa llamada resuelve
-- contra la funcion nueva porque _before_id tiene valor por defecto. Por eso
-- el parametro va AL FINAL y la funcion vieja se borra en vez de convivir:
-- con las dos, una llamada con solo _limit seria ambigua para PostgREST.
--
-- Archivar marca el aviso como leido. No es un capricho: el indice
-- notifications_open_group_idx deja un solo aviso SIN LEER por conversacion,
-- y notify() suma al que encuentra abierto. Un aviso archivado pero sin leer
-- se tragaria todos los siguientes de esa conversacion sin ensenar ninguno.
--
-- La purga no cambia: lo archivado esta leido y se va a los 60 dias.
--
-- ASCII puro. Idempotente.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. La marca de archivado
-- ------------------------------------------------------------
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS archived_at timestamptz;


-- ------------------------------------------------------------
-- 2. La bandeja: cursor compuesto y sin lo archivado
--
-- Sigue siendo INVOKER: el contenido se resuelve con los permisos de quien
-- lee (ver 20260925000000).
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.my_notifications(timestamptz, integer);

CREATE OR REPLACE FUNCTION public.my_notifications(
  _before    timestamptz DEFAULT NULL,
  _limit     integer     DEFAULT 30,
  _before_id uuid        DEFAULT NULL
)
RETURNS TABLE (
  id              uuid,
  type            text,
  category        text,
  count           integer,
  created_at      timestamptz,
  updated_at      timestamptz,
  read_at         timestamptz,
  data            jsonb,
  actor_id        uuid,
  actor_name      text,
  actor_avatar    text,
  event_id        uuid,
  event_title     text,
  event_starts_at timestamptz,
  group_id        uuid,
  group_name      text,
  is_dm           boolean
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT n.id, n.type, n.category, n.count, n.created_at, n.updated_at, n.read_at, n.data,
         n.actor_id, pp.name, pp.avatar_url,
         n.event_id, e.title, e.starts_at,
         n.group_id,
         CASE WHEN g.name LIKE '\_\_dm\_%' THEN NULL ELSE g.name END,
         COALESCE(g.name LIKE '\_\_dm\_%', false)
  FROM public.notifications n
  LEFT JOIN public.public_profiles pp ON pp.id = n.actor_id
  LEFT JOIN public.events e ON e.id = n.event_id
  LEFT JOIN public.groups g ON g.id = n.group_id
  WHERE n.user_id = auth.uid()
    AND n.archived_at IS NULL
    AND (n.actor_id IS NULL OR NOT public.is_blocked(auth.uid(), n.actor_id))
    -- Lo que va DESPUES del cursor en el orden de abajo. Sin _before_id (la
    -- app publicada) se queda en la comparacion de antes.
    AND (_before IS NULL
         OR n.updated_at < _before
         OR (_before_id IS NOT NULL AND n.updated_at = _before AND n.id < _before_id))
  ORDER BY n.updated_at DESC, n.id DESC
  LIMIT least(greatest(COALESCE(_limit, 30), 1), 50);
$$;
REVOKE EXECUTE ON FUNCTION public.my_notifications(timestamptz, integer, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.my_notifications(timestamptz, integer, uuid) TO authenticated;


-- ------------------------------------------------------------
-- 3. Archivar y deshacer
-- ------------------------------------------------------------

-- Archivar: fuera de la bandeja, leido, y sin push pendiente.
CREATE OR REPLACE FUNCTION public.archive_notifications(_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  IF _ids IS NULL OR cardinality(_ids) = 0 THEN
    RETURN 0;
  END IF;
  WITH r AS (
    UPDATE public.notifications
    SET archived_at = now(), read_at = COALESCE(read_at, now())
    WHERE user_id = auth.uid() AND archived_at IS NULL AND id = ANY (_ids)
    RETURNING id
  ), c AS (
    UPDATE public.notification_deliveries d
    SET status = 'cancelled', updated_at = now()
    FROM r WHERE d.notification_id = r.id AND d.status = 'pending'
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM r;
  RETURN v_n;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.archive_notifications(uuid[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.archive_notifications(uuid[]) TO authenticated;

-- Deshacer. El aviso vuelve a la bandeja, y vuelve SIN LEER si lo estaba al
-- archivarlo: archive_notifications pone read_at y archived_at con el mismo
-- now(), asi que read_at = archived_at quiere decir "lo leyo el archivado".
--
-- Con una salvedad: si mientras tanto llego otro aviso de la misma
-- conversacion, ese es ahora el abierto y este se queda leido (el indice
-- notifications_open_group_idx no admite dos). Por si dos de la misma
-- conversacion se restauran en la misma llamada, el indice salta y se
-- repite sin tocar read_at: mejor de vuelta y leido que no volver.
CREATE OR REPLACE FUNCTION public.unarchive_notifications(_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  IF _ids IS NULL OR cardinality(_ids) = 0 THEN
    RETURN 0;
  END IF;
  BEGIN
    UPDATE public.notifications n
    SET archived_at = NULL,
        read_at = CASE
          WHEN n.read_at = n.archived_at
           AND (n.group_key IS NULL OR NOT EXISTS (
                 SELECT 1 FROM public.notifications o
                 WHERE o.user_id = n.user_id AND o.group_key = n.group_key AND o.read_at IS NULL))
          THEN NULL
          ELSE n.read_at
        END
    WHERE n.user_id = auth.uid() AND n.archived_at IS NOT NULL AND n.id = ANY (_ids);
    GET DIAGNOSTICS v_n = ROW_COUNT;
  EXCEPTION WHEN unique_violation THEN
    UPDATE public.notifications n
    SET archived_at = NULL
    WHERE n.user_id = auth.uid() AND n.archived_at IS NOT NULL AND n.id = ANY (_ids);
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END;
  RETURN v_n;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.unarchive_notifications(uuid[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.unarchive_notifications(uuid[]) TO authenticated;

COMMIT;
