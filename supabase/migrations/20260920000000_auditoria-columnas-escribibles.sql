-- ============================================================
-- Auditoria 2026-09-18: columnas escribibles que nadie protegia
--
-- Causa raiz unica de los tres huecos (SEC-01, SEC-02, SEC-04) y de los
-- dos derivados (SEC-05, SEC-08):
--
--   En Supabase, el rol `authenticated` puede escribir TODA columna de una
--   tabla que tenga politica de escritura, salvo que un disparador o un
--   WITH CHECK lo impida explicitamente.
--
-- El proyecto protegia valores concretos con disparadores dirigidos
-- (prevent_status_tampering, prevent_score_tampering, guard_message_update)
-- y esos funcionan. Lo que faltaba era el invariante general: las rutas
-- LATERALES quedaron abiertas.
--
-- Lo que cierra, por hallazgo:
--   1. SEC-01 (P0) event_participants UPDATE sin WITH CHECK: se podia mover
--      la propia fila a CUALQUIER event_id, saltandose aprobacion, aforo y
--      aislamiento por institucion.
--   2. SEC-02 (P1) friendships INSERT con status='accepted': amistad
--      autoconcedida, que es la llave de create_dm, add_group_member y los
--      eventos privacy='friends'.
--   3. SEC-04 (P1) events.created_at escribible: anulaba el limite de
--      creacion de 20260903000000 (200/200 eventos en la prueba).
--   4. Bonus del mismo invariante: events.institution_id y events.creator_id
--      tampoco estaban protegidos en UPDATE (trg_set_event_institution es
--      BEFORE INSERT). Un evento podia mudarse de campus despues de creado.
--   5. SEC-08 (P2) messages.created_at futuro: contador de no leidos que no
--      se apaga nunca (mark_group_read fija last_read_at = now()).
--   6. SEC-05 (P2) sin limites de longitud en servidor, y el titulo sin
--      truncar en la push de plan repetido (APNs corta en 4 KB).
--   7. PERF-01 (P2) los dos indices que faltan.
--
-- Por que SECURITY INVOKER en los guardianes nuevos: necesitan ver
-- current_user = 'authenticated' para distinguir al cliente del
-- service_role. Dentro de SECURITY DEFINER, current_user es el DUENO de la
-- funcion (postgres) y la condicion no se cumple NUNCA. Es exactamente la
-- trampa que documenta 20260820000000.
--
-- No borra ni reescribe datos de usuario. ASCII puro. Idempotente.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. SEC-01 (P0): la participacion no se muda de evento
--
-- La politica declaraba USING sin WITH CHECK. En PostgreSQL eso reutiliza
-- USING como comprobacion de la fila NUEVA, y USING solo mira user_id: la
-- fila resultante pasaba siempre que el atacante siguiera siendo su dueno.
-- event_id no lo miraba nadie.
--
-- Los tres disparadores que ya habia no cubrian el hueco:
--   * set_participant_initial_status  BEFORE INSERT  (no corre en UPDATE)
--   * prevent_status_tampering        BEFORE UPDATE  (solo compara status)
--   * recalc_event_spots              AFTER UPDATE OF status
--     WHEN (OLD.status IS DISTINCT FROM NEW.status) -> un cambio de
--     event_id ni siquiera recalculaba current_spots.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Users can update own participation" ON public.event_participants;

CREATE POLICY "Users can update own participation"
  ON public.event_participants FOR UPDATE TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Cinturon ademas del tirante: event_id, user_id y joined_at son inmutables
-- desde el cliente. El WITH CHECK de arriba ya cierra el ataque; esto deja
-- el invariante escrito donde se ve, y da un codigo estable que el cliente
-- traduce en vez del error generico de RLS.
CREATE OR REPLACE FUNCTION public.guard_participation_update()
RETURNS trigger
LANGUAGE plpgsql
-- INVOKER a proposito, ver cabecera.
SET search_path = public
AS $$
BEGIN
  IF current_user = 'authenticated'
     AND (NEW.event_id  IS DISTINCT FROM OLD.event_id
       OR NEW.user_id   IS DISTINCT FROM OLD.user_id
       OR NEW.joined_at IS DISTINCT FROM OLD.joined_at) THEN
    RAISE EXCEPTION 'PARTICIPATION_FIELD_LOCKED'
      USING ERRCODE = '42501',
            HINT    = 'event_id, user_id y joined_at no se cambian desde el cliente.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_participation_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_participation_update ON public.event_participants;
CREATE TRIGGER trg_guard_participation_update
  BEFORE UPDATE ON public.event_participants
  FOR EACH ROW EXECUTE FUNCTION public.guard_participation_update();


-- ------------------------------------------------------------
-- 2. SEC-02 (P1): el estado de una amistad lo decide el servidor
--
-- La politica de INSERT comprueba requester_id y bloqueo, pero no status,
-- y la columna acepta 'accepted' directamente. No habia ningun BEFORE
-- INSERT sobre friendships: el unico disparador es trg_friend_request_push,
-- AFTER INSERT y ademas WHEN (NEW.status = 'pending'), asi que la via de
-- ataque ni siquiera generaba la notificacion que alertaria a la victima.
--
-- Mismo patron que set_participant_initial_status, que ya hacia esto bien
-- en event_participants. La leccion se habia aplicado en una tabla y no en
-- la otra.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_friendship_initial_status()
RETURNS trigger
LANGUAGE plpgsql
-- INVOKER a proposito, ver cabecera.
SET search_path = public
AS $$
BEGIN
  -- Las escrituras de service_role y las migraciones pasan tal cual.
  IF current_user = 'authenticated' THEN
    NEW.status     := 'pending';
    NEW.created_at := now();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_friendship_initial_status() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_set_friendship_initial_status ON public.friendships;
CREATE TRIGGER trg_set_friendship_initial_status
  BEFORE INSERT ON public.friendships
  FOR EACH ROW EXECUTE FUNCTION public.set_friendship_initial_status();


-- ------------------------------------------------------------
-- 3. SEC-04 (P1) + aislamiento: lo que el cliente no pone en events
--
-- created_at tenia DEFAULT now() pero ningun disparador la fijaba, y el
-- limite de 20260903000000 cuenta filas filtrando por esa misma columna:
-- mandando created_at en el pasado, el recuento siempre daba cero.
--
-- institution_id y creator_id son el mismo descuido en UPDATE:
-- trg_set_event_institution es BEFORE INSERT, asi que un evento ya creado
-- podia mudarse a otro campus con un solo PATCH.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_event_created_at()
RETURNS trigger
LANGUAGE plpgsql
-- INVOKER a proposito, ver cabecera.
SET search_path = public
AS $$
BEGIN
  IF current_user = 'authenticated' THEN
    NEW.created_at := now();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_event_created_at() FROM PUBLIC, anon, authenticated;

-- Prefijo 'a_' A PROPOSITO: los BEFORE de la misma tabla y evento se
-- ejecutan en orden ALFABETICO, y este tiene que correr ANTES de
-- trg_event_rate_limit o el limite seguiria contando con el created_at que
-- mando el cliente. Mismo razonamiento que documenta 20260915000000 para
-- trg_set_profile_campus.
DROP TRIGGER IF EXISTS a_trg_set_event_created_at ON public.events;
CREATE TRIGGER a_trg_set_event_created_at
  BEFORE INSERT ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.set_event_created_at();

CREATE OR REPLACE FUNCTION public.guard_event_update()
RETURNS trigger
LANGUAGE plpgsql
-- INVOKER a proposito, ver cabecera.
SET search_path = public
AS $$
BEGIN
  IF current_user = 'authenticated'
     AND (NEW.creator_id     IS DISTINCT FROM OLD.creator_id
       OR NEW.institution_id IS DISTINCT FROM OLD.institution_id
       OR NEW.created_at     IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'EVENT_FIELD_LOCKED'
      USING ERRCODE = '42501',
            HINT    = 'creator_id, institution_id y created_at los pone el servidor.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_event_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_event_update ON public.events;
CREATE TRIGGER trg_guard_event_update
  BEFORE UPDATE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_update();

-- La politica de UPDATE tampoco declaraba WITH CHECK. Explicito, por lo
-- mismo que en event_participants.
DROP POLICY IF EXISTS "Creators can update their events" ON public.events;

CREATE POLICY "Creators can update their events"
  ON public.events FOR UPDATE TO authenticated
  USING      (auth.uid() = creator_id)
  WITH CHECK (auth.uid() = creator_id);

DROP POLICY IF EXISTS "Creators can update groups" ON public.groups;

CREATE POLICY "Creators can update groups"
  ON public.groups FOR UPDATE TO authenticated
  USING      (auth.uid() = created_by)
  WITH CHECK (auth.uid() = created_by);


-- ------------------------------------------------------------
-- 4. SEC-08 (P2): la fecha de envio de un mensaje la pone el servidor
--
-- mark_group_read() fija last_read_at = now(). Un mensaje con created_at en
-- 2099 satisface `m.created_at > gm.last_read_at` para siempre: globo rojo
-- permanente para todo el grupo, mensaje anclado al final del chat, y el
-- chat fijado en lo alto de la lista por chat_summaries()/friends_page().
--
-- set_message_expiry ya hacia bien lo que a created_at le faltaba, asi que
-- se le anade ahi mismo. OJO: pierde SECURITY DEFINER. Dentro de DEFINER,
-- current_user es postgres y la condicion no se cumpliria nunca. La funcion
-- no necesita privilegios: solo escribe en NEW.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_message_expiry()
RETURNS trigger
LANGUAGE plpgsql
-- INVOKER a proposito, ver cabecera. Antes era DEFINER sin necesitarlo.
SET search_path = public
AS $$
BEGIN
  -- Lo decide el servidor, no el cliente: si no, cualquiera podria mandar
  -- mensajes que no caducan nunca (o que caducan al instante en la
  -- conversacion de otro).
  NEW.expires_at := now() + interval '90 days';

  -- Y la fecha de envio, por la misma razon.
  IF current_user = 'authenticated' THEN
    NEW.created_at := now();
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_message_expiry() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_set_message_expiry ON public.messages;
CREATE TRIGGER trg_set_message_expiry
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.set_message_expiry();


-- ------------------------------------------------------------
-- 5. SEC-05 (P2): limites de longitud en el servidor
--
-- El cliente valida con zod (title 3-80, description <=500, address <=120)
-- y EditEventSheet solo comprueba !title.trim(), pero eso es una
-- comprobacion de navegador. Un title de 1 MB entraba sin problema, y el
-- mapa descarga hasta 500 eventos de una vez.
--
-- NOT VALID a proposito: solo se aplica a filas NUEVAS, asi que la
-- migracion no falla si ya existe alguna fila fuera de rango. El VALIDATE
-- va justo despues y, si alguna fila historica lo impidiera, se puede
-- quitar sin tocar la proteccion de lo nuevo.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_title_len') THEN
    ALTER TABLE public.events
      ADD CONSTRAINT events_title_len
      CHECK (length(title) BETWEEN 3 AND 80) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_description_len') THEN
    ALTER TABLE public.events
      ADD CONSTRAINT events_description_len
      CHECK (description IS NULL OR length(description) <= 500) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_address_len') THEN
    ALTER TABLE public.events
      ADD CONSTRAINT events_address_len
      CHECK (address IS NULL OR length(address) <= 120) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'groups_name_len') THEN
    ALTER TABLE public.groups
      ADD CONSTRAINT groups_name_len
      CHECK (length(name) BETWEEN 1 AND 120) NOT VALID;
  END IF;

  -- deleted_at IS NOT NULL: borrar un mensaje lo deja con content vacio
  -- (20260914000000 vacia el texto en vez de borrar la fila), y esa fila
  -- tiene que seguir siendo valida.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_content_len') THEN
    ALTER TABLE public.messages
      ADD CONSTRAINT messages_content_len
      CHECK (length(content) <= 2000
             AND (deleted_at IS NOT NULL OR length(btrim(content)) > 0)) NOT VALID;
  END IF;
END;
$$;

-- Validar lo que ya hay. Si alguna fila historica lo impidiera, el CHECK
-- seguiria protegiendo lo nuevo: se quita este bloque y ya.
ALTER TABLE public.events   VALIDATE CONSTRAINT events_title_len;
ALTER TABLE public.events   VALIDATE CONSTRAINT events_description_len;
ALTER TABLE public.events   VALIDATE CONSTRAINT events_address_len;
ALTER TABLE public.groups   VALIDATE CONSTRAINT groups_name_len;
ALTER TABLE public.messages VALIDATE CONSTRAINT messages_content_len;


-- ------------------------------------------------------------
-- 6. SEC-05 (P2): truncar el titulo en la push de plan repetido
--
-- APNs rechaza cargas de mas de 4 KB, asi que un titulo largo rompia la
-- notificacion EN SILENCIO. on_message_push ya trunca a 120; esto aplica el
-- mismo patron. Con el CHECK de arriba el titulo ya no pasa de 80, pero la
-- push no deberia depender de eso.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.on_event_repeat_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_who   text;
  v_title text;
  r       record;
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

  v_title := left(NEW.title, 80);
  IF length(NEW.title) > 80 THEN
    v_title := v_title || U&'\2026';
  END IF;

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
      COALESCE(v_who, 'Alguien') || U&' organiz\00F3 otra vez \00AB' || v_title || U&'\00BB. \00BFTe apuntas?',
      jsonb_build_object('type', 'event_repeat', 'event_id', NEW.id)
    );
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.on_event_repeat_push() FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 7. PERF-01 (P2): los dos indices que faltaban
--
-- profiles.campus_id: search_institutions cuenta perfiles por campus, y se
-- llama en CADA pulsacion del selector del alta (hasta 50 campus por
-- respuesta) -> recorrido secuencial de profiles por cada uno.
--
-- groups.name: friends_page busca el grupo de DM por nombre construido
-- ('__dm_' || least || '_' || greatest) en un LATERAL, una vez por amigo de
-- la pagina (hasta 100).
--
-- Sin CONCURRENTLY, por lo mismo que documentan 20260824000000 y
-- 20260901000000: el SQL Editor ejecuta dentro de una transaccion.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS profiles_campus_id_idx
  ON public.profiles (campus_id) WHERE campus_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS groups_name_idx
  ON public.groups (name);


-- ------------------------------------------------------------
-- 8. DEBT-01 (P3): la rama muerta de messages.event_id
--
-- El chat de evento nunca llego a usarse: messages.event_id es NULL en
-- todas las filas y el propio 20260827000000 lo reconoce por escrito. Pero
-- las tres politicas de messages seguian evaluando esa rama en CADA lectura
-- de mensaje, llamando a is_event_participant() para nada.
--
-- La COLUMNA se queda (borrarla es irreversible) con un COMMENT que lo
-- explique. Lo que se va es la rama de las politicas.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view messages in their events or groups" ON public.messages;
CREATE POLICY "Users can view messages in their events or groups"
  ON public.messages FOR SELECT TO authenticated
  USING (
    NOT public.is_blocked(auth.uid(), sender_id)
    AND (
      sender_id = auth.uid()
      OR (group_id IS NOT NULL AND public.is_group_member(group_id, auth.uid()))
    )
  );

DROP POLICY IF EXISTS "Members can send messages" ON public.messages;
CREATE POLICY "Members can send messages"
  ON public.messages FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND group_id IS NOT NULL
    AND public.is_group_member(group_id, auth.uid())
  );

DROP POLICY IF EXISTS "Senders can edit own messages" ON public.messages;
CREATE POLICY "Senders can edit own messages"
  ON public.messages FOR UPDATE TO authenticated
  USING (
    sender_id = auth.uid()
    AND deleted_at IS NULL
    AND group_id IS NOT NULL
    AND public.is_group_member(group_id, auth.uid())
  )
  WITH CHECK (sender_id = auth.uid());

COMMENT ON COLUMN public.messages.event_id IS
  'MUERTA. El chat de evento nunca se implemento: NULL en todas las filas. '
  'Se conserva la columna porque borrarla es irreversible, pero ninguna '
  'politica ni consulta la mira desde 20260920000000.';

COMMIT;
