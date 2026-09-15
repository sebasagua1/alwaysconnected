-- ============================================================
-- Ver quien va a un evento antes de unirse
--
-- Hasta aqui la lista de asistentes solo la veian quien organiza y quien
-- ya estaba dentro: la RLS de event_participants no deja leer mas.
--
-- Decision de Sebastian (2026-09-15): la ve cualquiera que pueda ver el
-- evento. Por eso no se abre la tabla, sino una funcion que devuelve lo
-- justo:
--   * solo nombre y foto (lo mismo que ya ensena public_profiles), sin
--     valoraciones, check-in ni fecha de union;
--   * solo quien esta dentro (status = 'joined'): las solicitudes
--     pendientes y rechazadas no salen;
--   * nunca personas bloqueadas con quien pregunta, en ningun sentido;
--   * si el evento no se puede ver, no devuelve nada (ni un error que
--     confirme que existe).
--
-- La condicion de "puede ver el evento" copia la politica
-- "Events visibility policy" (20260829000000_institution-isolation.sql).
-- Si esa politica cambia, esta funcion tiene que cambiar con ella; la
-- prueba src/test/eventAttendees.sql.test.ts las compara fila a fila.
--
-- No toca ninguna tabla ni politica existente. ASCII puro e idempotente.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.event_attendees(_event_id uuid)
RETURNS TABLE (
  user_id     uuid,
  name        text,
  avatar_url  text,
  is_creator  boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ev AS (
    SELECT e.id, e.creator_id
    FROM public.events e
    WHERE e.id = _event_id
      AND auth.uid() IS NOT NULL
      AND (
        e.creator_id = auth.uid()
        OR (
          NOT public.is_blocked(auth.uid(), e.creator_id)
          AND public.same_institution(auth.uid(), e.creator_id)
          AND (
            e.privacy IN ('open', 'private')
            OR (e.privacy = 'friends' AND public.are_friends(e.creator_id, auth.uid()))
          )
        )
      )
  ), gente AS (
    -- Quien organiza no tiene fila en event_participants: va aparte y primero.
    SELECT ev.creator_id AS uid, true AS organiza, NULL::timestamptz AS desde
    FROM ev
    UNION ALL
    SELECT ep.user_id, false, ep.joined_at
    FROM public.event_participants ep
    JOIN ev ON ev.id = ep.event_id
    WHERE ep.status = 'joined'
      AND ep.user_id <> ev.creator_id
  )
  SELECT p.id, p.name, p.avatar_url, g.organiza
  FROM gente g
  JOIN public.profiles p ON p.id = g.uid
  WHERE p.id = auth.uid()
     OR NOT public.is_blocked(auth.uid(), p.id)
  ORDER BY g.organiza DESC, g.desde ASC NULLS FIRST, p.id;
$$;

REVOKE EXECUTE ON FUNCTION public.event_attendees(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.event_attendees(uuid) TO authenticated;

COMMIT;
