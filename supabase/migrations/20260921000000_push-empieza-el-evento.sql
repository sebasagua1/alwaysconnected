-- ============================================================
-- Avisar por push cuando el evento empieza
--
-- Por que: el boton de "Registrar asistencia" solo existe dentro de la
-- hoja del evento y solo mientras el evento esta en curso. Nada avisaba
-- de que habia llegado ese momento, asi que habia que acordarse de abrir
-- la app, buscar el evento y tocar. Medido el 2026-09-19: 43 eventos, 24
-- ocasiones reales de hacer check-in, y CERO check-ins en toda la vida
-- del proyecto. No fallaba nada: es que no se podia pulsar.
--
-- Por que un trabajo programado y no un disparador: "el evento empieza"
-- no es un cambio en la base. Nadie escribe nada a las 19:00; sencillamente
-- llega la hora. Los cuatro push de 20260827 cuelgan de un INSERT o un
-- UPDATE, y aqui no hay ninguno al que engancharse. De ahi pg_cron, como
-- el purgado de mensajes.
--
-- Lo que NO hace, a proposito:
--   * No avisa a quien organiza: no puede hacer check-in (la interfaz se
--     lo oculta con !isCreator y no tiene fila en event_participants).
--   * No avisa a quien ya hizo check-in en esos primeros minutos.
--   * No filtra por is_blocked: no es un aviso de otra persona, es el
--     recordatorio de un plan al que te apuntaste tu.
--
-- ASCII puro (textos con U&'...'). Idempotente: se puede pegar dos veces.
-- La programacion va aparte, en 20260921010000.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. La marca de "ya avisado"
--
-- En events y no en event_participants: el aviso se decide por evento
-- (una pasada, una marca) aunque se mande a varias personas. Quien se
-- una despues de que salga el aviso no lo recibe, y esta bien: se apunto
-- con el evento ya empezado.
-- ------------------------------------------------------------
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS start_push_sent_at timestamptz;

COMMENT ON COLUMN public.events.start_push_sent_at IS
  'Cuando salio el aviso de "ya empezo". NULL = todavia no. Lo escribe notify_started_events().';

-- Los eventos que YA empezaron cuando se aplica esto quedan marcados sin
-- mandar nada. Sin esto, la primera pasada del cron avisaria de golpe de
-- 34 eventos viejos, la mayoria terminados hace semanas. Los futuros se
-- quedan en NULL y avisaran cuando les toque, que es lo que se quiere.
UPDATE public.events
SET start_push_sent_at = now()
WHERE start_push_sent_at IS NULL
  AND starts_at <= now();

-- La consulta del cron solo mira los no avisados: un indice parcial la
-- deja en nada por muchos eventos que se acumulen con el tiempo.
CREATE INDEX IF NOT EXISTS events_start_push_pendiente_idx
  ON public.events (starts_at)
  WHERE start_push_sent_at IS NULL;


-- ------------------------------------------------------------
-- 2. El aviso
--
-- El UPDATE ... RETURNING de la CTE es lo que hace esto seguro: marca y
-- reclama los eventos en la misma sentencia, asi que si dos pasadas del
-- cron llegaran a solaparse, la segunda no ve ninguno y nadie recibe el
-- aviso dos veces. Marcar antes de mandar y no despues es deliberado:
-- push_send() ya se traga sus propios errores (se queda en WARNING), asi
-- que "marcado pero no enviado" es el fallo bueno y "enviado dos veces"
-- el malo.
--
-- Las dos ventanas:
--   * ends_at > now()  -- si ya termino, no hay nada que registrar.
--   * starts_at > now() - 1 hora  -- si el cron estuvo caido medio dia,
--     que no llegue "ya empezo" de algo que empezo esta manana.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_started_events()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_n integer := 0;
BEGIN
  FOR r IN
    WITH reclamados AS (
      UPDATE public.events e
      SET start_push_sent_at = now()
      WHERE e.start_push_sent_at IS NULL
        AND e.is_active
        AND e.starts_at <= now()
        AND e.starts_at > now() - interval '1 hour'
        AND e.ends_at   > now()
      RETURNING e.id, e.title, e.creator_id
    )
    SELECT rc.id AS event_id, rc.title, ep.user_id
    FROM reclamados rc
    JOIN public.event_participants ep ON ep.event_id = rc.id
    WHERE ep.status = 'joined'
      AND ep.user_id <> rc.creator_id
      AND NOT ep.checked_in
  LOOP
    PERFORM public.push_send(
      r.user_id,
      U&'Ya empez\00F3',
      U&'\00AB' || COALESCE(r.title, 'Tu plan') || U&'\00BB ya empez\00F3. Registra tu asistencia para sumar puntos.',
      jsonb_build_object('type', 'event_started', 'event_id', r.event_id)
    );
    v_n := v_n + 1;
  END LOOP;

  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION public.notify_started_events() IS
  'Avisa por push a quien se unio a un evento que acaba de empezar, para que registre su asistencia. Idempotente por events.start_push_sent_at. La llama el trabajo programado avisar-inicio-evento.';

REVOKE EXECUTE ON FUNCTION public.notify_started_events() FROM PUBLIC, anon, authenticated;

COMMIT;


-- ============================================================
-- Comprobacion (se ejecuta y devuelve filas): debe salir UNA fila,
-- la columna start_push_sent_at, nullable.
-- ============================================================
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'events'
  AND column_name  = 'start_push_sent_at';
