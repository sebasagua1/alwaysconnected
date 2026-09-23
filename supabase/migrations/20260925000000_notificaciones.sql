-- ============================================================
-- Notificaciones: bandeja, preferencias, cola de envio y avisos nuevos
--
-- Hasta aqui cada disparador llamaba a push_send() y la Edge Function
-- send-push mandaba el aviso al instante: sin bandeja dentro de la app, sin
-- preferencias, sin agrupar, sin saber si llego, con el texto fijo en
-- espanol dentro del SQL. Esto lo cambia por una tuberia con tres piezas:
--
--   notify()                    TODO aviso pasa por aqui: comprueba tipo,
--                               preferencias, silencio de la actividad,
--                               bloqueos, "no a quien lo hizo", limite
--                               diario social y caducidad; deduplica o
--                               agrupa, y deja una fila en la bandeja.
--   notification_deliveries     la cola (outbox) de push: cuando se manda
--                               (horario silencioso, franja de dia,
--                               agrupacion), intentos, estado, caducidad.
--   notify-dispatch (Edge)      recoge lo que toca, resuelve el texto en el
--                               idioma de cada persona, manda a APNs a todos
--                               sus dispositivos, apunta el resultado y
--                               borra los tokens muertos.
--
-- La base avisa a notify-dispatch con pg_net nada mas encolar algo que
-- tiene que salir ya, y pg_cron repasa cada minuto lo programado y lo que
-- se quedo a medias (20260925010000).
--
-- Lo que se guarda de cada aviso son IDs y banderas, nunca texto: el
-- titulo del evento, el nombre de quien escribe o la vista previa del
-- mensaje se resuelven al enviar (y en la app, al abrir), con los permisos
-- de ese momento.
--
-- Los avisos que ya existian se conservan todos (solicitud, aprobacion,
-- mensaje, amistad, invitacion a grupo, plan repetido, cambio y
-- cancelacion, "ya empezo") y mantienen el mismo `type` en la carga, asi
-- que la version publicada de la app los sigue abriendo igual.
--
-- ASCII puro (textos con U&'...'). Idempotente.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Tipos de aviso
--
-- Tabla y no CASE en el codigo: la categoria, la prioridad y las reglas de
-- cada tipo estan en un solo sitio, y la app puede leerla.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_types (
  type         text PRIMARY KEY,
  category     text NOT NULL CHECK (category IN (
                 'activity_messages', 'mentions', 'event_updates', 'event_requests', 'reminders',
                 'direct_messages', 'friend_requests', 'friend_activity', 'people_suggestions',
                 'activity_recommendations', 'digests', 'account', 'security', 'promotional')),
  priority     smallint NOT NULL CHECK (priority BETWEEN 0 AND 2),
  -- Cuenta para el limite diario de avisos sociales (daily_social_limit).
  social       boolean NOT NULL DEFAULT false,
  -- Solo de 9:00 a 21:00 hora local de quien lo recibe.
  daytime_only boolean NOT NULL DEFAULT false,
  -- Llega aunque la actividad este silenciada.
  bypass_mute  boolean NOT NULL DEFAULT true,
  -- Pasado este tiempo, la push ya no merece salir (sigue en la bandeja).
  push_ttl     interval NOT NULL DEFAULT interval '24 hours'
);

ALTER TABLE public.notification_types ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_types FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.notification_types TO authenticated;
DROP POLICY IF EXISTS "Anyone signed in reads notification types" ON public.notification_types;
CREATE POLICY "Anyone signed in reads notification types"
  ON public.notification_types FOR SELECT TO authenticated USING (true);

INSERT INTO public.notification_types (type, category, priority, social, daytime_only, bypass_mute, push_ttl) VALUES
  -- Chat
  ('event_message',          'activity_messages',        1, false, false, false, interval '12 hours'),
  ('chat_mention',           'mentions',                 2, false, false, true,  interval '24 hours'),
  ('organizer_announcement', 'event_updates',            2, false, false, true,  interval '24 hours'),
  ('message',                'direct_messages',          1, false, false, true,  interval '12 hours'),
  -- Tus actividades
  ('join_request',           'event_requests',           1, false, false, true,  interval '48 hours'),
  ('approval',               'event_requests',           2, false, false, true,  interval '48 hours'),
  ('join_rejected',          'event_requests',           1, false, false, true,  interval '48 hours'),
  ('participant_joined',     'event_requests',           0, false, false, false, interval '12 hours'),
  ('event_reminder',         'reminders',                1, false, false, true,  interval '24 hours'),
  ('event_started',          'reminders',                1, false, false, true,  interval '2 hours'),
  ('event_changed',          'event_updates',            2, false, false, true,  interval '48 hours'),
  ('event_cancelled',        'event_updates',            2, false, false, true,  interval '48 hours'),
  -- Amigos y descubrir
  ('event_repeat',           'friend_activity',          1, false, false, true,  interval '72 hours'),
  ('event_invite',           'friend_activity',          1, false, false, true,  interval '72 hours'),
  ('friend_created_event',   'friend_activity',          1, true,  true,  true,  interval '72 hours'),
  ('friend_joined_event',    'friend_activity',          0, true,  true,  true,  interval '24 hours'),
  ('new_campus_event',       'activity_recommendations', 0, true,  true,  true,  interval '72 hours'),
  ('spots_low',              'activity_recommendations', 1, true,  true,  true,  interval '24 hours'),
  ('digest',                 'digests',                  0, false, true,  true,  interval '12 hours'),
  ('friend_request',         'friend_requests',          1, false, false, true,  interval '7 days'),
  ('friend_accepted',        'friend_requests',          1, false, false, true,  interval '7 days'),
  ('group_invite',           'friend_requests',          1, false, false, true,  interval '7 days'),
  ('contact_joined',         'friend_activity',          1, true,  true,  true,  interval '7 days'),
  ('invite_accepted',        'friend_activity',          1, false, false, true,  interval '7 days'),
  ('person_suggestion',      'people_suggestions',       0, true,  true,  true,  interval '7 days'),
  -- Cuenta
  ('profile_incomplete',     'account',                  0, false, true,  true,  interval '3 days'),
  ('verification_pending',   'account',                  0, false, true,  true,  interval '3 days'),
  ('verification_reminder',  'account',                  0, false, true,  true,  interval '3 days'),
  ('verification_approved',  'account',                  1, false, false, true,  interval '7 days'),
  ('verification_rejected',  'account',                  1, false, false, true,  interval '7 days'),
  ('security_alert',         'security',                 2, false, false, true,  interval '7 days'),
  ('promotional',            'promotional',              0, false, true,  true,  interval '3 days')
ON CONFLICT (type) DO UPDATE SET
  category = EXCLUDED.category, priority = EXCLUDED.priority, social = EXCLUDED.social,
  daytime_only = EXCLUDED.daytime_only, bypass_mute = EXCLUDED.bypass_mute, push_ttl = EXCLUDED.push_ttl;


-- ------------------------------------------------------------
-- 2. Preferencias
--
-- Una fila por persona, que lee y escribe ella misma (RLS). Lo que no se
-- puede tocar a mano lo pone el disparador: el consentimiento promocional
-- lleva fecha, y la zona horaria tiene que existir.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_preferences (
  user_id                  uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  activity_messages        boolean NOT NULL DEFAULT true,
  mentions                 boolean NOT NULL DEFAULT true,
  event_updates            boolean NOT NULL DEFAULT true,
  event_requests           boolean NOT NULL DEFAULT true,
  reminders                boolean NOT NULL DEFAULT true,
  reminder_minutes         integer NOT NULL DEFAULT 60,
  direct_messages          boolean NOT NULL DEFAULT true,
  friend_requests          boolean NOT NULL DEFAULT true,
  friend_activity          boolean NOT NULL DEFAULT true,
  people_suggestions       boolean NOT NULL DEFAULT true,
  activity_recommendations boolean NOT NULL DEFAULT true,
  digests                  boolean NOT NULL DEFAULT true,
  account_tips             boolean NOT NULL DEFAULT true,
  -- Apagado hasta que la persona lo active: eso ES el consentimiento.
  promotional              boolean NOT NULL DEFAULT false,
  promotional_consent_at   timestamptz,
  show_previews            boolean NOT NULL DEFAULT true,
  quiet_hours_enabled      boolean NOT NULL DEFAULT false,
  quiet_start              time NOT NULL DEFAULT '23:00',
  quiet_end                time NOT NULL DEFAULT '08:00',
  timezone                 text NOT NULL DEFAULT 'America/Mexico_City',
  locale                   text NOT NULL DEFAULT 'es',
  daily_social_limit       integer NOT NULL DEFAULT 3,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_preferences_reminder CHECK (reminder_minutes IN (15, 30, 60, 120, 1440)),
  CONSTRAINT notification_preferences_locale CHECK (locale IN ('es', 'en')),
  CONSTRAINT notification_preferences_social_limit CHECK (daily_social_limit BETWEEN 0 AND 10),
  CONSTRAINT notification_preferences_tz_len CHECK (length(timezone) BETWEEN 1 AND 64)
);

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_preferences FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.notification_preferences TO authenticated;

DROP POLICY IF EXISTS "Users read own notification preferences" ON public.notification_preferences;
CREATE POLICY "Users read own notification preferences"
  ON public.notification_preferences FOR SELECT TO authenticated
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Users create own notification preferences" ON public.notification_preferences;
CREATE POLICY "Users create own notification preferences"
  ON public.notification_preferences FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "Users update own notification preferences" ON public.notification_preferences;
CREATE POLICY "Users update own notification preferences"
  ON public.notification_preferences FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.guard_notification_preferences()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'PREFERENCES_FIELD_LOCKED' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'INVALID_TIMEZONE' USING ERRCODE = 'P0001';
  END IF;

  -- La fecha del consentimiento la pone el servidor, y solo al activarlo.
  IF NEW.promotional THEN
    IF TG_OP = 'INSERT' OR NOT OLD.promotional THEN
      NEW.promotional_consent_at := now();
    ELSE
      NEW.promotional_consent_at := OLD.promotional_consent_at;
    END IF;
  ELSE
    NEW.promotional_consent_at := NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSE
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.guard_notification_preferences() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_notification_preferences ON public.notification_preferences;
CREATE TRIGGER trg_guard_notification_preferences
  BEFORE INSERT OR UPDATE ON public.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION public.guard_notification_preferences();

-- Cada cuenta, con sus valores por defecto.
INSERT INTO public.notification_preferences (user_id)
SELECT u.id FROM auth.users u
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.on_new_user_notification_prefs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.notification_preferences (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.on_new_user_notification_prefs() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_new_user_notification_prefs ON auth.users;
CREATE TRIGGER trg_new_user_notification_prefs
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.on_new_user_notification_prefs();

-- Las de una persona, o las de por defecto si todavia no tiene fila.
CREATE OR REPLACE FUNCTION public.notification_prefs(_user_id uuid)
RETURNS public.notification_preferences
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.notification_preferences%ROWTYPE;
BEGIN
  SELECT * INTO p FROM public.notification_preferences WHERE user_id = _user_id;
  IF NOT FOUND THEN
    p.user_id := _user_id;
    p.activity_messages := true; p.mentions := true; p.event_updates := true; p.event_requests := true;
    p.reminders := true; p.reminder_minutes := 60; p.direct_messages := true; p.friend_requests := true;
    p.friend_activity := true; p.people_suggestions := true; p.activity_recommendations := true;
    p.digests := true; p.account_tips := true; p.promotional := false; p.show_previews := true;
    p.quiet_hours_enabled := false; p.quiet_start := '23:00'; p.quiet_end := '08:00';
    p.timezone := 'America/Mexico_City'; p.locale := 'es'; p.daily_social_limit := 3;
  END IF;
  RETURN p;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.notification_prefs(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.notification_category_enabled(p public.notification_preferences, _category text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE _category
    WHEN 'activity_messages'        THEN p.activity_messages
    WHEN 'mentions'                 THEN p.mentions
    WHEN 'event_updates'            THEN p.event_updates
    WHEN 'event_requests'           THEN p.event_requests
    WHEN 'reminders'                THEN p.reminders
    WHEN 'direct_messages'          THEN p.direct_messages
    WHEN 'friend_requests'          THEN p.friend_requests
    WHEN 'friend_activity'          THEN p.friend_activity
    WHEN 'people_suggestions'       THEN p.people_suggestions
    WHEN 'activity_recommendations' THEN p.activity_recommendations
    WHEN 'digests'                  THEN p.digests
    WHEN 'account'                  THEN p.account_tips
    -- Los avisos de seguridad no se pueden apagar.
    WHEN 'security'                 THEN true
    WHEN 'promotional'              THEN p.promotional AND p.promotional_consent_at IS NOT NULL
    ELSE false
  END;
$$;
REVOKE EXECUTE ON FUNCTION public.notification_category_enabled(public.notification_preferences, text) FROM PUBLIC, anon, authenticated;

-- Fin del horario silencioso (si _at cae dentro), en la zona de la persona.
CREATE OR REPLACE FUNCTION public.after_quiet_hours(p public.notification_preferences, _at timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_local timestamp := _at AT TIME ZONE p.timezone;
  v_t     time := v_local::time;
  v_end   timestamp;
BEGIN
  IF NOT p.quiet_hours_enabled OR p.quiet_start = p.quiet_end THEN
    RETURN _at;
  END IF;
  IF p.quiet_start < p.quiet_end THEN
    IF v_t >= p.quiet_start AND v_t < p.quiet_end THEN
      v_end := v_local::date + p.quiet_end;
    ELSE
      RETURN _at;
    END IF;
  ELSE
    -- Cruza la medianoche (23:00 -> 08:00).
    IF v_t >= p.quiet_start THEN
      v_end := (v_local::date + 1) + p.quiet_end;
    ELSIF v_t < p.quiet_end THEN
      v_end := v_local::date + p.quiet_end;
    ELSE
      RETURN _at;
    END IF;
  END IF;
  RETURN v_end AT TIME ZONE p.timezone;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.after_quiet_hours(public.notification_preferences, timestamptz) FROM PUBLIC, anon, authenticated;

-- Recomendaciones y recordatorios de cuenta: solo de 9:00 a 21:00 local.
CREATE OR REPLACE FUNCTION public.within_daytime(p public.notification_preferences, _at timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_local timestamp := _at AT TIME ZONE p.timezone;
BEGIN
  IF v_local::time < time '09:00' THEN
    RETURN (v_local::date + time '09:00') AT TIME ZONE p.timezone;
  ELSIF v_local::time >= time '21:00' THEN
    RETURN ((v_local::date + 1) + time '09:00') AT TIME ZONE p.timezone;
  END IF;
  RETURN _at;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.within_daytime(public.notification_preferences, timestamptz) FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 3. La bandeja
--
-- Solo IDs y banderas en `data`: el texto se resuelve al leer. La app lee
-- sus filas (RLS) y las marca por RPC; nadie las inserta desde el cliente.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type         text NOT NULL REFERENCES public.notification_types(type),
  category     text NOT NULL,
  priority     smallint NOT NULL DEFAULT 1,
  actor_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_id     uuid REFERENCES public.events(id) ON DELETE CASCADE,
  group_id     uuid REFERENCES public.groups(id) ON DELETE CASCADE,
  message_id   uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key   text,
  group_key    text,
  count        integer NOT NULL DEFAULT 1 CHECK (count >= 1),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz,
  opened_at    timestamptz,
  converted_at timestamptz,
  expires_at   timestamptz,
  CONSTRAINT notifications_data_small CHECK (jsonb_typeof(data) = 'object' AND length(data::text) <= 1000),
  CONSTRAINT notifications_keys_len CHECK (
    (dedupe_key IS NULL OR length(dedupe_key) <= 200) AND (group_key IS NULL OR length(group_key) <= 200))
);

-- La misma notificacion no se crea dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx
  ON public.notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
-- Un solo aviso abierto (sin leer) por conversacion u otra agrupacion.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_open_group_idx
  ON public.notifications (user_id, group_key) WHERE group_key IS NOT NULL AND read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_user_recent_idx
  ON public.notifications (user_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON public.notifications (user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_event_idx
  ON public.notifications (event_id) WHERE event_id IS NOT NULL;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notifications FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.notifications TO authenticated;

DROP POLICY IF EXISTS "Users read own notifications" ON public.notifications;
CREATE POLICY "Users read own notifications"
  ON public.notifications FOR SELECT TO authenticated
  USING (user_id = auth.uid());


-- ------------------------------------------------------------
-- 4. La cola de push (outbox)
--
-- Una entrega por intento de aviso. Como mucho una viva (pendiente o
-- enviandose) por notificacion: los mensajes que llegan mientras tanto
-- suben el recuento de la notificacion y salen en ESA entrega.
-- Solo la toca el servidor.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  priority        smallint NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'expired', 'cancelled')),
  scheduled_for   timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  attempts        smallint NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  sent_at         timestamptz,
  devices_sent    smallint,
  devices_failed  smallint,
  last_error      text CHECK (last_error IS NULL OR length(last_error) <= 300),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_one_live
  ON public.notification_deliveries (notification_id) WHERE status IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS notification_deliveries_due_idx
  ON public.notification_deliveries (priority DESC, scheduled_for) WHERE status IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS notification_deliveries_notification_idx
  ON public.notification_deliveries (notification_id);

ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_deliveries FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 5. Presencia en chats de grupo (para no mandar push a quien lo mira)
-- ------------------------------------------------------------
ALTER TABLE public.group_members
  ADD COLUMN IF NOT EXISTS active_until timestamptz;

CREATE OR REPLACE FUNCTION public.set_group_chat_presence(_group_id uuid, _active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.group_members
  SET active_until = CASE WHEN _active THEN now() + interval '45 seconds' END,
      last_read_at = now()
  WHERE group_id = _group_id AND user_id = auth.uid();
  IF FOUND THEN
    UPDATE public.notifications SET read_at = now()
    WHERE user_id = auth.uid() AND group_key = 'chat:group:' || _group_id AND read_at IS NULL;
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.set_group_chat_presence(uuid, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_group_chat_presence(uuid, boolean) TO authenticated;


-- ------------------------------------------------------------
-- 6. Despertar a notify-dispatch
--
-- Una llamada por transaccion como mucho: un evento con 50 personas que
-- encola 50 avisos no hace 50 peticiones. pg_net las manda al confirmar,
-- asi que la funcion nunca lee una fila que todavia no existe.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kick_notification_dispatch()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, net, public
AS $$
DECLARE
  v_key text;
BEGIN
  IF current_setting('app.notification_kicked', true) = 'on' THEN
    RETURN;
  END IF;
  PERFORM set_config('app.notification_kicked', 'on', true);

  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  IF v_key IS NULL THEN
    RAISE WARNING 'kick_notification_dispatch: falta el secreto service_role_key en Vault';
    RETURN;
  END IF;

  PERFORM http_post(
    url     := 'https://myarlozvkbebygwszgkf.supabase.co/functions/v1/notify-dispatch',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body    := '{"kick":true}'::jsonb
  );
EXCEPTION WHEN OTHERS THEN
  -- Nunca tumba la escritura que provoco el aviso: el cron lo recoge.
  RAISE WARNING 'kick_notification_dispatch fallo (%): %', SQLSTATE, SQLERRM;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.kick_notification_dispatch() FROM PUBLIC, anon, authenticated;

-- Para el cron: solo despierta a la funcion si hay algo que hacer.
CREATE OR REPLACE FUNCTION public.kick_notification_dispatch_if_due()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.notification_deliveries d
    WHERE (d.status = 'pending' AND d.scheduled_for <= now())
       OR (d.status = 'sending' AND d.locked_until < now())
  ) THEN
    PERFORM public.kick_notification_dispatch();
    RETURN true;
  END IF;
  RETURN false;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.kick_notification_dispatch_if_due() FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 7. notify(): la unica puerta
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.schedule_notification_delivery(
  _notification_id uuid,
  _user_id         uuid,
  p                public.notification_preferences,
  t                public.notification_types,
  _window          interval,
  _expires         timestamptz,
  _urgent          boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_at   timestamptz := now();
  v_last timestamptz;
  v_exp  timestamptz;
BEGIN
  -- Sin dispositivos no hay push: el aviso se queda en la bandeja.
  IF NOT EXISTS (SELECT 1 FROM public.device_tokens WHERE user_id = _user_id) THEN
    RETURN;
  END IF;

  -- Ya hay una entrega en camino: saldra con el recuento al dia.
  IF EXISTS (
    SELECT 1 FROM public.notification_deliveries
    WHERE notification_id = _notification_id AND status IN ('pending', 'sending')
  ) THEN
    RETURN;
  END IF;

  -- Agrupar: tras una push de esta conversacion, la siguiente espera a que
  -- pase la ventana y resume lo que llego mientras tanto.
  IF _window IS NOT NULL THEN
    SELECT max(sent_at) INTO v_last
    FROM public.notification_deliveries
    WHERE notification_id = _notification_id AND status = 'sent';
    IF v_last IS NOT NULL AND v_last > now() - _window THEN
      v_at := v_last + _window;
    END IF;
  END IF;

  -- Lo urgente (un cambio o cancelacion de algo que empieza pronto) no
  -- espera al horario silencioso. Nada usa niveles criticos de Apple.
  IF NOT COALESCE(_urgent, false) THEN
    v_at := public.after_quiet_hours(p, v_at);
    IF t.daytime_only THEN
      v_at := public.within_daytime(p, v_at);
    END IF;
  END IF;

  v_exp := LEAST(COALESCE(_expires, 'infinity'::timestamptz), v_at + t.push_ttl);
  IF v_at >= v_exp THEN
    RETURN;
  END IF;

  INSERT INTO public.notification_deliveries (notification_id, user_id, priority, scheduled_for, expires_at)
  VALUES (_notification_id, _user_id, t.priority, v_at, v_exp)
  ON CONFLICT DO NOTHING;

  IF v_at <= now() THEN
    PERFORM public.kick_notification_dispatch();
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.schedule_notification_delivery(uuid, uuid, public.notification_preferences, public.notification_types, interval, timestamptz, boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.notify(
  _user_id   uuid,
  _type      text,
  _actor_id  uuid        DEFAULT NULL,
  _event_id  uuid        DEFAULT NULL,
  _group_id  uuid        DEFAULT NULL,
  _message_id uuid       DEFAULT NULL,
  _data      jsonb       DEFAULT '{}'::jsonb,
  _dedupe    text        DEFAULT NULL,
  _group_key text        DEFAULT NULL,
  _expires   timestamptz DEFAULT NULL,
  _window    interval    DEFAULT NULL,
  _urgent    boolean     DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t     public.notification_types%ROWTYPE;
  p     public.notification_preferences%ROWTYPE;
  v_id  uuid;
  v_day timestamptz;
  v_n   integer;
BEGIN
  IF _user_id IS NULL OR _type IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO t FROM public.notification_types WHERE type = _type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNKNOWN_NOTIFICATION_TYPE' USING ERRCODE = 'P0001', DETAIL = _type;
  END IF;

  -- Nunca a quien hizo la accion, ni entre bloqueados.
  IF _actor_id IS NOT NULL AND _actor_id = _user_id THEN RETURN NULL; END IF;
  IF _actor_id IS NOT NULL AND public.is_blocked(_user_id, _actor_id) THEN RETURN NULL; END IF;
  -- Nada que ya no sirve (una recomendacion de algo que ya empezo).
  IF _expires IS NOT NULL AND _expires <= now() THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = _user_id) THEN RETURN NULL; END IF;

  p := public.notification_prefs(_user_id);
  IF NOT public.notification_category_enabled(p, t.category) THEN
    RETURN NULL;
  END IF;

  -- Actividad silenciada: solo pasa lo que no respeta el silencio
  -- (menciones, avisos del organizador, cambios, recordatorios).
  IF _event_id IS NOT NULL AND NOT t.bypass_mute AND EXISTS (
    SELECT 1 FROM public.event_chat_state s
    WHERE s.event_id = _event_id AND s.user_id = _user_id AND s.muted
  ) THEN
    RETURN NULL;
  END IF;

  -- Tope diario (en el dia de la persona) de avisos sociales.
  IF t.social THEN
    v_day := date_trunc('day', now() AT TIME ZONE p.timezone) AT TIME ZONE p.timezone;
    SELECT count(*) INTO v_n
    FROM public.notifications n
    JOIN public.notification_types nt ON nt.type = n.type AND nt.social
    WHERE n.user_id = _user_id AND n.created_at >= v_day;
    IF v_n >= p.daily_social_limit THEN
      RETURN NULL;
    END IF;
  END IF;

  INSERT INTO public.notifications (
    user_id, type, category, priority, actor_id, event_id, group_id, message_id, data,
    dedupe_key, group_key, expires_at
  )
  VALUES (
    _user_id, _type, t.category, t.priority, _actor_id, _event_id, _group_id, _message_id,
    COALESCE(_data, '{}'::jsonb), _dedupe, _group_key, _expires
  )
  ON CONFLICT (user_id, group_key) WHERE group_key IS NOT NULL AND read_at IS NULL
  DO UPDATE SET
    count      = public.notifications.count + 1,
    actor_id   = COALESCE(EXCLUDED.actor_id, public.notifications.actor_id),
    message_id = COALESCE(EXCLUDED.message_id, public.notifications.message_id),
    data       = public.notifications.data || EXCLUDED.data,
    updated_at = now(),
    expires_at = CASE WHEN public.notifications.expires_at IS NULL OR EXCLUDED.expires_at IS NULL THEN NULL
                      ELSE greatest(public.notifications.expires_at, EXCLUDED.expires_at) END
  RETURNING id INTO v_id;

  PERFORM public.schedule_notification_delivery(v_id, _user_id, p, t, _window, _expires, _urgent);
  RETURN v_id;
EXCEPTION
  -- La misma dedupe_key: ya se aviso, no se duplica ni se vuelve a mandar.
  WHEN unique_violation THEN
    RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.notify(uuid, text, uuid, uuid, uuid, uuid, jsonb, text, text, timestamptz, interval, boolean) FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 8. Lo que usa notify-dispatch (solo service_role)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_notification_deliveries(_limit integer DEFAULT 50)
RETURNS TABLE (
  delivery_id     uuid,
  notification_id uuid,
  user_id         uuid,
  type            text,
  priority        smallint,
  count           integer,
  locale          text,
  actor_id        uuid,
  actor_name      text,
  event_id        uuid,
  event_title     text,
  group_id        uuid,
  group_name      text,
  is_dm           boolean,
  preview         text,
  data            jsonb,
  thread_id       text,
  expires_at      timestamptz,
  tokens          text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  -- Lo que ya no merece salir se descarta antes de reclamar, con el motivo.
  UPDATE public.notification_deliveries d
  SET status = 'expired', updated_at = now(), locked_until = NULL
  WHERE d.status IN ('pending', 'sending') AND d.expires_at <= now();

  UPDATE public.notification_deliveries d
  SET status = 'failed', last_error = 'max_attempts', updated_at = now(), locked_until = NULL
  WHERE d.status = 'sending' AND d.locked_until < now() AND d.attempts >= 5;

  UPDATE public.notification_deliveries d
  SET status = 'skipped', last_error = 'read', updated_at = now()
  FROM public.notifications n
  WHERE d.status = 'pending' AND d.scheduled_for <= now() AND n.id = d.notification_id AND n.read_at IS NOT NULL;

  UPDATE public.notification_deliveries d
  SET status = 'skipped', last_error = 'no_devices', updated_at = now()
  WHERE d.status = 'pending' AND d.scheduled_for <= now()
    AND NOT EXISTS (SELECT 1 FROM public.device_tokens dt WHERE dt.user_id = d.user_id);

  -- Ya no esta en el chat (salio, le expulsaron, bloqueo) o lo esta mirando.
  UPDATE public.notification_deliveries d
  SET status = 'skipped', last_error = 'no_access', updated_at = now()
  FROM public.notifications n
  WHERE d.status = 'pending' AND d.scheduled_for <= now() AND n.id = d.notification_id
    AND n.type IN ('event_message', 'chat_mention', 'organizer_announcement')
    AND NOT public.event_chat_member(n.event_id, n.user_id);

  UPDATE public.notification_deliveries d
  SET status = 'skipped', last_error = 'no_access', updated_at = now()
  FROM public.notifications n
  WHERE d.status = 'pending' AND d.scheduled_for <= now() AND n.id = d.notification_id
    AND n.type = 'message' AND NOT public.is_group_member(n.group_id, n.user_id);

  UPDATE public.notification_deliveries d
  SET status = 'skipped', last_error = 'viewing', updated_at = now()
  FROM public.notifications n, public.event_chat_state s
  WHERE d.status = 'pending' AND d.scheduled_for <= now() AND n.id = d.notification_id
    AND n.type = 'event_message' AND s.event_id = n.event_id AND s.user_id = n.user_id
    AND s.active_until > now();

  -- Recordatorios y recomendaciones de algo cancelado o ya empezado.
  UPDATE public.notification_deliveries d
  SET status = 'skipped', last_error = 'event_gone', updated_at = now()
  FROM public.notifications n
  JOIN public.events e ON e.id = n.event_id
  WHERE d.status = 'pending' AND d.scheduled_for <= now() AND n.id = d.notification_id
    AND n.type IN ('event_reminder', 'new_campus_event', 'friend_created_event', 'friend_joined_event',
                   'spots_low', 'event_invite', 'event_repeat')
    AND (NOT e.is_active OR e.starts_at <= now());

  RETURN QUERY
  WITH picked AS (
    SELECT d.id
    FROM public.notification_deliveries d
    WHERE (d.status = 'pending' AND d.scheduled_for <= now())
       OR (d.status = 'sending' AND d.locked_until < now())
    ORDER BY d.priority DESC, d.scheduled_for
    LIMIT least(greatest(COALESCE(_limit, 50), 1), 200)
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.notification_deliveries d
    SET status = 'sending', attempts = d.attempts + 1,
        locked_until = now() + interval '2 minutes', updated_at = now()
    FROM picked
    WHERE d.id = picked.id
    RETURNING d.id, d.notification_id, d.expires_at
  )
  SELECT
    c.id,
    n.id,
    n.user_id,
    n.type,
    n.priority,
    n.count,
    pr.locale,
    n.actor_id,
    CASE WHEN n.actor_id IS NOT NULL AND NOT public.is_blocked(n.user_id, n.actor_id) THEN ap.name END,
    n.event_id,
    left(e.title, 80),
    n.group_id,
    CASE WHEN g.name LIKE '\_\_dm\_%' THEN NULL ELSE left(g.name, 60) END,
    COALESCE(g.name LIKE '\_\_dm\_%', false),
    -- La vista previa solo si la persona la quiere y el mensaje sigue ahi.
    CASE
      WHEN pr.show_previews AND n.type IN ('event_message', 'chat_mention', 'organizer_announcement', 'message')
           AND m.id IS NOT NULL AND m.deleted_at IS NULL
      THEN left(m.content, 120) || CASE WHEN length(m.content) > 120 THEN U&'\2026' ELSE '' END
    END,
    n.data,
    COALESCE(n.group_key, n.type || ':' || COALESCE(n.event_id::text, n.group_id::text, n.user_id::text)),
    c.expires_at,
    (SELECT array_agg(dt.token) FROM public.device_tokens dt WHERE dt.user_id = n.user_id)
  FROM claimed c
  JOIN public.notifications n ON n.id = c.notification_id
  CROSS JOIN LATERAL public.notification_prefs(n.user_id) pr
  LEFT JOIN public.profiles ap ON ap.id = n.actor_id
  LEFT JOIN public.events   e  ON e.id = n.event_id
  LEFT JOIN public.groups   g  ON g.id = n.group_id
  LEFT JOIN public.messages m  ON m.id = n.message_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.claim_notification_deliveries(integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_notification_deliveries(integer) TO service_role;

-- Resultado de un envio. Idempotente: si ya no estaba "enviandose" (otro
-- despachador la cerro), no toca nada.
CREATE OR REPLACE FUNCTION public.complete_notification_delivery(
  _delivery_id    uuid,
  _ok             boolean,
  _devices_sent   integer DEFAULT 0,
  _devices_failed integer DEFAULT 0,
  _error          text    DEFAULT NULL,
  _retry          boolean DEFAULT false,
  _dead_tokens    text[]  DEFAULT '{}'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user     uuid;
  v_attempts smallint;
BEGIN
  SELECT d.user_id, d.attempts INTO v_user, v_attempts
  FROM public.notification_deliveries d
  WHERE d.id = _delivery_id AND d.status = 'sending'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF _ok THEN
    UPDATE public.notification_deliveries
    SET status = 'sent', sent_at = now(), locked_until = NULL, updated_at = now(),
        devices_sent = _devices_sent, devices_failed = _devices_failed, last_error = left(_error, 300)
    WHERE id = _delivery_id;
  ELSIF _retry AND v_attempts < 5 THEN
    -- 2, 4, 8, 16 minutos.
    UPDATE public.notification_deliveries
    SET status = 'pending', locked_until = NULL, updated_at = now(),
        scheduled_for = now() + make_interval(mins => (2 ^ v_attempts)::int),
        devices_failed = _devices_failed, last_error = left(_error, 300)
    WHERE id = _delivery_id;
  ELSE
    UPDATE public.notification_deliveries
    SET status = 'failed', locked_until = NULL, updated_at = now(),
        devices_sent = _devices_sent, devices_failed = _devices_failed, last_error = left(_error, 300)
    WHERE id = _delivery_id;
  END IF;

  IF _dead_tokens IS NOT NULL AND cardinality(_dead_tokens) > 0 THEN
    DELETE FROM public.device_tokens WHERE user_id = v_user AND token = ANY (_dead_tokens);
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.complete_notification_delivery(uuid, boolean, integer, integer, text, boolean, text[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.complete_notification_delivery(uuid, boolean, integer, integer, text, boolean, text[]) TO service_role;


-- ------------------------------------------------------------
-- 9. Lo que usa la app
-- ------------------------------------------------------------

-- La bandeja, con el contenido resuelto CON LOS PERMISOS DE QUIEN LEE:
-- INVOKER, asi el titulo sale solo si todavia puede ver el evento, el
-- nombre solo si la persona es visible, y el grupo solo si sigue dentro.
CREATE OR REPLACE FUNCTION public.my_notifications(_before timestamptz DEFAULT NULL, _limit integer DEFAULT 30)
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
    AND (n.actor_id IS NULL OR NOT public.is_blocked(auth.uid(), n.actor_id))
    AND (_before IS NULL OR n.updated_at < _before)
  ORDER BY n.updated_at DESC, n.id DESC
  LIMIT least(greatest(COALESCE(_limit, 30), 1), 50);
$$;
REVOKE EXECUTE ON FUNCTION public.my_notifications(timestamptz, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.my_notifications(timestamptz, integer) TO authenticated;

-- Marcar leidas (todas si no se pasan ids). Leer cancela las push que
-- quedaban por salir de esos avisos.
CREATE OR REPLACE FUNCTION public.mark_notifications_read(_ids uuid[] DEFAULT NULL)
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
  WITH r AS (
    UPDATE public.notifications
    SET read_at = now()
    WHERE user_id = auth.uid() AND read_at IS NULL AND (_ids IS NULL OR id = ANY (_ids))
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
REVOKE EXECUTE ON FUNCTION public.mark_notifications_read(uuid[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.mark_notifications_read(uuid[]) TO authenticated;

-- Tocada (desde la push o desde la bandeja): para la metrica de apertura.
CREATE OR REPLACE FUNCTION public.mark_notification_opened(_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.notifications
  SET opened_at = COALESCE(opened_at, now()), read_at = COALESCE(read_at, now())
  WHERE id = _id AND user_id = auth.uid();
  UPDATE public.notification_deliveries
  SET status = 'cancelled', updated_at = now()
  WHERE notification_id = _id AND status = 'pending' AND user_id = auth.uid();
END;
$$;
REVOKE EXECUTE ON FUNCTION public.mark_notification_opened(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.mark_notification_opened(uuid) TO authenticated;

-- Actividades silenciadas, para la pantalla de preferencias.
CREATE OR REPLACE FUNCTION public.muted_event_chats()
RETURNS TABLE (event_id uuid, title text, starts_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.id, e.title, e.starts_at
  FROM public.event_chat_state s
  JOIN public.events e ON e.id = s.event_id
  WHERE s.user_id = auth.uid() AND s.muted AND e.is_active
  ORDER BY e.starts_at DESC
  LIMIT 100;
$$;
REVOKE EXECUTE ON FUNCTION public.muted_event_chats() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.muted_event_chats() TO authenticated;

-- Invitar amigos a una actividad. Quien invita tiene que estar dentro; cada
-- invitado tiene que ser amigo, poder ver el evento y no estar ya dentro.
-- Un aviso por actividad y persona, como mucho 20 por llamada y 50 al dia.
CREATE OR REPLACE FUNCTION public.invite_friends_to_event(_event_id uuid, _friend_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ev  record;
  v_n   integer := 0;
  v_hoy integer;
  f     uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  IF _friend_ids IS NULL OR cardinality(_friend_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(_friend_ids) > 20 THEN
    RAISE EXCEPTION 'TOO_MANY_INVITES' USING ERRCODE = 'P0001';
  END IF;

  SELECT e.id, e.creator_id, e.privacy, e.starts_at, e.is_active INTO v_ev
  FROM public.events e WHERE e.id = _event_id;
  IF NOT FOUND OR NOT public.event_chat_member(_event_id, v_uid) THEN
    RAISE EXCEPTION 'NOT_AN_ATTENDEE' USING ERRCODE = '42501';
  END IF;
  IF NOT v_ev.is_active OR v_ev.starts_at <= now() THEN
    RAISE EXCEPTION 'EVENT_NOT_OPEN' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_hoy FROM public.notifications n
  WHERE n.type = 'event_invite' AND n.actor_id = v_uid AND n.created_at > now() - interval '1 day';
  IF v_hoy >= 50 THEN
    RAISE EXCEPTION 'INVITE_RATE_LIMIT' USING ERRCODE = 'P0001';
  END IF;

  FOREACH f IN ARRAY _friend_ids LOOP
    CONTINUE WHEN f IS NULL OR f = v_uid OR f = v_ev.creator_id;
    CONTINUE WHEN NOT public.are_friends(v_uid, f);
    CONTINUE WHEN public.is_blocked(f, v_ev.creator_id);
    CONTINUE WHEN NOT public.same_institution(f, v_ev.creator_id);
    CONTINUE WHEN v_ev.privacy = 'friends' AND NOT public.are_friends(v_ev.creator_id, f);
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.event_participants ep WHERE ep.event_id = _event_id AND ep.user_id = f);
    IF public.notify(f, 'event_invite', v_uid, _event_id, NULL, NULL, '{}'::jsonb,
                     'event_invite:' || _event_id, NULL, v_ev.starts_at) IS NOT NULL THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.invite_friends_to_event(uuid, uuid[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.invite_friends_to_event(uuid, uuid[]) TO authenticated;


-- ------------------------------------------------------------
-- 10. Leer el chat apaga sus avisos
--
-- Mismo cuerpo que 20260923000000 mas marcar leidas las notificaciones de
-- ese chat (y sus menciones). Asi un aviso agrupado que aun no salio ya
-- no sale.
-- ------------------------------------------------------------
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
  UPDATE public.notifications SET read_at = now()
  WHERE user_id = v_uid AND read_at IS NULL
    AND group_key IN ('chat:event:' || _event_id, 'mention:event:' || _event_id);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.mark_event_chat_read(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.mark_event_chat_read(uuid) TO authenticated;

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
  UPDATE public.notifications SET read_at = now()
  WHERE user_id = v_uid AND read_at IS NULL
    AND group_key IN ('chat:event:' || _event_id, 'mention:event:' || _event_id);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.set_event_chat_presence(uuid, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_event_chat_presence(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_group_read(_group_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.group_members
  SET    last_read_at = now()
  WHERE  group_id = _group_id
    AND  user_id  = auth.uid();
  UPDATE public.notifications SET read_at = now()
  WHERE user_id = auth.uid() AND read_at IS NULL AND group_key = 'chat:group:' || _group_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.mark_group_read(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.mark_group_read(uuid) TO authenticated;


-- ------------------------------------------------------------
-- 11. Los avisos de siempre, ahora por notify()
--
-- Mismas condiciones que antes; cambia a donde van. La carga conserva el
-- `type` y los ids que ya leia la app publicada.
-- ------------------------------------------------------------

-- Chat de actividad (sustituye a la version de 20260923000000).
CREATE OR REPLACE FUNCTION public.notify_event_chat_message(_msg public.messages)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_revived boolean;
  r         record;
BEGIN
  -- "Vuelve a haber movimiento": nadie habia escrito en 12 horas.
  v_revived := NOT EXISTS (
    SELECT 1 FROM public.messages m
    WHERE m.event_id = _msg.event_id AND m.id <> _msg.id AND m.deleted_at IS NULL
      AND m.created_at > now() - interval '12 hours'
  );

  FOR r IN
    SELECT s.user_id, s.active_until, (s.user_id = ANY (_msg.mentions)) AS mencionado
    FROM public.event_chat_state s
    WHERE s.event_id = _msg.event_id
      AND s.user_id <> _msg.sender_id
      AND public.event_chat_member(s.event_id, s.user_id)
      AND NOT public.is_blocked(s.user_id, _msg.sender_id)
  LOOP
    -- Con el chat abierto el mensaje ya llega por tiempo real.
    CONTINUE WHEN r.active_until IS NOT NULL AND r.active_until > now();

    IF _msg.is_announcement THEN
      PERFORM public.notify(r.user_id, 'organizer_announcement', _msg.sender_id, _msg.event_id, NULL, _msg.id,
        '{}'::jsonb, 'announcement:' || _msg.id);
    ELSIF r.mencionado THEN
      PERFORM public.notify(r.user_id, 'chat_mention', _msg.sender_id, _msg.event_id, NULL, _msg.id,
        '{}'::jsonb, NULL, 'mention:event:' || _msg.event_id, NULL, interval '1 minute');
    ELSE
      PERFORM public.notify(r.user_id, 'event_message', _msg.sender_id, _msg.event_id, NULL, _msg.id,
        jsonb_build_object('revived', v_revived), NULL, 'chat:event:' || _msg.event_id, NULL, interval '5 minutes');
    END IF;
  END LOOP;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.notify_event_chat_message(public.messages) FROM PUBLIC, anon, authenticated;

-- Grupos y DM: agrupados, sin push a quien lo mira.
CREATE OR REPLACE FUNCTION public.on_message_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  IF NEW.event_id IS NOT NULL THEN
    PERFORM public.notify_event_chat_message(NEW);
    RETURN NEW;
  END IF;
  IF NEW.group_id IS NULL THEN RETURN NEW; END IF;

  FOR r IN
    SELECT gm.user_id
    FROM public.group_members gm
    WHERE gm.group_id = NEW.group_id
      AND gm.user_id <> NEW.sender_id
      AND NOT public.is_blocked(gm.user_id, NEW.sender_id)
      AND (gm.active_until IS NULL OR gm.active_until <= now())
  LOOP
    PERFORM public.notify(r.user_id, 'message', NEW.sender_id, NULL, NEW.group_id, NEW.id,
      '{}'::jsonb, NULL, 'chat:group:' || NEW.group_id, NULL, interval '3 minutes');
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.on_message_push() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.on_join_request_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ev record;
BEGIN
  SELECT e.creator_id, e.ends_at INTO v_ev FROM public.events e WHERE e.id = NEW.event_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  -- Pedir, cancelar y volver a pedir no avisa dos veces.
  PERFORM public.notify(v_ev.creator_id, 'join_request', NEW.user_id, NEW.event_id, NULL, NULL,
    '{}'::jsonb, 'join_request:' || NEW.event_id || ':' || NEW.user_id, NULL, v_ev.ends_at);
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.on_join_request_push() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.on_approval_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ev record;
BEGIN
  SELECT e.creator_id, e.ends_at INTO v_ev FROM public.events e WHERE e.id = NEW.event_id;
  PERFORM public.notify(NEW.user_id, 'approval', v_ev.creator_id, NEW.event_id, NULL, NULL,
    '{}'::jsonb, 'approval:' || NEW.event_id, NULL, v_ev.ends_at);
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.on_approval_push() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.on_friend_request_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.addressee_id = NEW.requester_id THEN RETURN NEW; END IF;
  -- Pedir, cancelar y volver a pedir no avisa otra vez.
  PERFORM public.notify(NEW.addressee_id, 'friend_request', NEW.requester_id, NULL, NULL, NULL,
    '{}'::jsonb, 'friend_request:' || NEW.requester_id);
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.on_friend_request_push() FROM PUBLIC, anon, authenticated;

-- Nuevo: aceptaron tu solicitud.
CREATE OR REPLACE FUNCTION public.on_friend_accepted_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.notify(NEW.requester_id, 'friend_accepted', NEW.addressee_id, NULL, NULL, NULL,
    '{}'::jsonb, 'friend_accepted:' || NEW.addressee_id);
  -- Si venia de una sugerencia o de contactos, cuenta como conversion.
  UPDATE public.notifications SET converted_at = now()
  WHERE converted_at IS NULL AND type IN ('person_suggestion', 'contact_joined', 'invite_accepted')
    AND ((user_id = NEW.requester_id AND actor_id = NEW.addressee_id)
      OR (user_id = NEW.addressee_id AND actor_id = NEW.requester_id));
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.on_friend_accepted_push() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_friend_accepted_push ON public.friendships;
CREATE TRIGGER trg_friend_accepted_push
  AFTER UPDATE OF status ON public.friendships
  FOR EACH ROW
  WHEN (OLD.status = 'pending' AND NEW.status = 'accepted')
  EXECUTE FUNCTION public.on_friend_accepted_push();

-- Plan repetido (mismo cuerpo que 20260920000000 de la PR #17, con notify).
CREATE OR REPLACE FUNCTION public.on_event_repeat_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.events e
    WHERE e.repeated_from = NEW.repeated_from
      AND e.creator_id = NEW.creator_id
      AND e.id <> NEW.id
      AND e.created_at > now() - interval '12 hours'
  ) THEN
    RETURN NEW;
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
    PERFORM public.notify(r.uid, 'event_repeat', NEW.creator_id, NEW.id, NULL, NULL,
      '{}'::jsonb, 'event_repeat:' || NEW.id, NULL, NEW.starts_at);
  END LOOP;

  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.on_event_repeat_push() FROM PUBLIC, anon, authenticated;

-- Cambio o cancelacion (sustituye a la de 20260921000000 de la PR #17,
-- ya aplicada en produccion; aqui se crea si no existia). Suma el cambio
-- de direccion y de hora de fin. Es URGENTE si empieza en menos de 24 h:
-- entonces no espera al horario silencioso.
CREATE OR REPLACE FUNCTION public.on_event_change_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tipo   text;
  v_cambio text;
  v_dedupe text;
  v_urgent boolean;
  r        record;
BEGIN
  IF OLD.is_active AND NOT NEW.is_active THEN
    v_tipo := 'event_cancelled'; v_cambio := 'cancelled';
  ELSIF NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.ends_at IS DISTINCT FROM OLD.ends_at THEN
    v_tipo := 'event_changed'; v_cambio := 'time';
  ELSIF NEW.lat IS DISTINCT FROM OLD.lat OR NEW.lng IS DISTINCT FROM OLD.lng
     OR NEW.address IS DISTINCT FROM OLD.address THEN
    v_tipo := 'event_changed'; v_cambio := 'place';
  ELSIF NEW.privacy = 'friends' AND OLD.privacy <> 'friends' THEN
    v_tipo := 'event_changed'; v_cambio := 'privacy';
  ELSE
    RETURN NEW;
  END IF;

  -- El mismo estado final no avisa dos veces (guardar dos veces igual).
  v_dedupe := CASE WHEN v_tipo = 'event_cancelled' THEN 'cancelled:' || NEW.id
    ELSE 'changed:' || NEW.id || ':' || md5(concat_ws('|', NEW.starts_at, NEW.ends_at, NEW.lat, NEW.lng, NEW.address, NEW.privacy)) END;
  v_urgent := NEW.starts_at < now() + interval '24 hours';

  FOR r IN
    SELECT ep.user_id
    FROM public.event_participants ep
    WHERE ep.event_id = NEW.id
      AND ep.status = 'joined'
      AND ep.user_id <> NEW.creator_id
      AND NOT public.is_blocked(ep.user_id, NEW.creator_id)
    LIMIT 500
  LOOP
    PERFORM public.notify(r.user_id, v_tipo, NEW.creator_id, NEW.id, NULL, NULL,
      jsonb_build_object('change', v_cambio), v_dedupe, NULL, NULL, NULL, v_urgent);
  END LOOP;

  -- Cancelado: lo que quedaba por salir de esta actividad ya no sirve.
  IF v_tipo = 'event_cancelled' THEN
    UPDATE public.notification_deliveries d
    SET status = 'cancelled', updated_at = now()
    FROM public.notifications n
    WHERE d.notification_id = n.id AND d.status = 'pending' AND n.event_id = NEW.id
      AND n.type NOT IN ('event_cancelled');
  END IF;

  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.on_event_change_push() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_event_change_push ON public.events;
CREATE TRIGGER trg_event_change_push
  AFTER UPDATE OF starts_at, ends_at, lat, lng, address, is_active, privacy ON public.events
  FOR EACH ROW
  WHEN (OLD.is_active  IS DISTINCT FROM NEW.is_active
     OR OLD.starts_at  IS DISTINCT FROM NEW.starts_at
     OR OLD.ends_at    IS DISTINCT FROM NEW.ends_at
     OR OLD.lat        IS DISTINCT FROM NEW.lat
     OR OLD.lng        IS DISTINCT FROM NEW.lng
     OR OLD.address    IS DISTINCT FROM NEW.address
     OR OLD.privacy    IS DISTINCT FROM NEW.privacy)
  EXECUTE FUNCTION public.on_event_change_push();

-- "Ya empezo" (mismo cuerpo que 20260921000000, con notify).
CREATE OR REPLACE FUNCTION public.notify_started_events()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r   record;
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
      RETURNING e.id, e.creator_id, e.ends_at
    )
    SELECT rc.id AS event_id, rc.ends_at, ep.user_id
    FROM reclamados rc
    JOIN public.event_participants ep ON ep.event_id = rc.id
    WHERE ep.status = 'joined'
      AND ep.user_id <> rc.creator_id
      AND NOT ep.checked_in
  LOOP
    IF public.notify(r.user_id, 'event_started', NULL, r.event_id, NULL, NULL, '{}'::jsonb,
                     'started:' || r.event_id, NULL, r.ends_at) IS NOT NULL THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.notify_started_events() FROM PUBLIC, anon, authenticated;

-- Rechazar una solicitud avisa (mismo cuerpo que 20260822000000).
CREATE OR REPLACE FUNCTION public.respond_to_join_request(
    _event_id uuid,
    _user_id  uuid,
    _approve  boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_event  RECORD;
  v_status text;
  v_count  integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT id, creator_id, max_spots, ends_at INTO v_event
  FROM public.events WHERE id = _event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EVENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_event.creator_id <> v_uid THEN
    RAISE EXCEPTION 'NOT_THE_ORGANIZER' USING ERRCODE = '42501';
  END IF;

  SELECT status INTO v_status
  FROM public.event_participants
  WHERE event_id = _event_id AND user_id = _user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REQUEST_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'REQUEST_ALREADY_HANDLED' USING ERRCODE = 'P0001';
  END IF;

  IF NOT _approve THEN
    DELETE FROM public.event_participants
    WHERE event_id = _event_id AND user_id = _user_id;
    PERFORM public.notify(_user_id, 'join_rejected', v_uid, _event_id, NULL, NULL, '{}'::jsonb,
      'join_rejected:' || _event_id, NULL, v_event.ends_at);
    RETURN;
  END IF;

  PERFORM 1 FROM public.events WHERE id = _event_id FOR UPDATE;

  SELECT COUNT(*) INTO v_count
  FROM public.event_participants
  WHERE event_id = _event_id AND status = 'joined';

  IF v_count >= v_event.max_spots THEN
    RAISE EXCEPTION 'EVENT_FULL' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.event_participants
  SET    status        = 'joined',
         approved_at   = now(),
         approval_seen = false
  WHERE  event_id = _event_id AND user_id = _user_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.respond_to_join_request(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.respond_to_join_request(uuid, uuid, boolean) TO authenticated;

-- Invitaciones a grupo (mismo cuerpo que 20260919000000, con notify).
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
  r       record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT e.id, e.title, e.creator_id, e.starts_at INTO v_ev
  FROM public.events e WHERE e.id = _event_id;

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
  IF v_name LIKE '\_\_dm\_%' THEN
    RAISE EXCEPTION 'INVALID_NAME' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.groups (name, created_by, source_event_id)
  VALUES (v_name, v_uid, _event_id)
  RETURNING id INTO v_group;

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

    PERFORM public.notify(r.uid, 'group_invite', v_uid, NULL, v_group, NULL, '{}'::jsonb,
      'group_invite:' || v_group);
  END LOOP;

  RETURN v_group;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.create_group_from_event(uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_group_from_event(uuid, text) TO authenticated;

-- Contacto que se une (sustituye a la version de 20260924000000).
CREATE OR REPLACE FUNCTION public.notify_contact_joined(_owner uuid, _joined uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.notify(_owner, 'contact_joined', _joined, NULL, NULL, NULL, '{}'::jsonb,
    'contact_joined:' || _joined);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.notify_contact_joined(uuid, uuid) FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 12. Avisos nuevos por disparador
-- ------------------------------------------------------------

-- Alguien se une: aviso agrupado a quien organiza, a sus amigos (si la
-- actividad es publica y relevante) y conversion de las recomendaciones.
CREATE OR REPLACE FUNCTION public.on_participant_joined_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ev record;
  r    record;
BEGIN
  SELECT e.id, e.creator_id, e.privacy, e.starts_at, e.ends_at, e.is_active INTO v_ev
  FROM public.events e WHERE e.id = NEW.event_id;
  IF NOT FOUND OR NEW.user_id = v_ev.creator_id THEN RETURN NEW; END IF;

  UPDATE public.notifications SET converted_at = now()
  WHERE user_id = NEW.user_id AND event_id = NEW.event_id AND converted_at IS NULL
    AND type IN ('new_campus_event', 'friend_created_event', 'friend_joined_event', 'spots_low',
                 'event_invite', 'event_repeat');

  -- Solo quien entra directo. Si lo aprobo el organizador, ya lo sabe.
  IF TG_OP = 'INSERT' THEN
    PERFORM public.notify(v_ev.creator_id, 'participant_joined', NEW.user_id, NEW.event_id, NULL, NULL,
      '{}'::jsonb, NULL, 'joins:' || NEW.event_id, v_ev.ends_at, interval '30 minutes');
  END IF;

  -- Amigos de quien se une, si la actividad es publica, futura y la pueden ver.
  IF v_ev.is_active AND v_ev.privacy IN ('open', 'private') AND v_ev.starts_at > now() + interval '30 minutes' THEN
    FOR r IN
      SELECT CASE WHEN f.requester_id = NEW.user_id THEN f.addressee_id ELSE f.requester_id END AS uid
      FROM public.friendships f
      WHERE f.status = 'accepted' AND (f.requester_id = NEW.user_id OR f.addressee_id = NEW.user_id)
      LIMIT 50
    LOOP
      CONTINUE WHEN r.uid = v_ev.creator_id;
      CONTINUE WHEN NOT public.same_institution(r.uid, v_ev.creator_id);
      CONTINUE WHEN public.is_blocked(r.uid, v_ev.creator_id);
      CONTINUE WHEN EXISTS (SELECT 1 FROM public.event_participants ep WHERE ep.event_id = NEW.event_id AND ep.user_id = r.uid);
      PERFORM public.notify(r.uid, 'friend_joined_event', NEW.user_id, NEW.event_id, NULL, NULL,
        '{}'::jsonb, NULL, 'friendjoins:' || NEW.event_id, v_ev.starts_at, interval '60 minutes');
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.on_participant_joined_notify() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_participant_joined_notify ON public.event_participants;
CREATE TRIGGER trg_participant_joined_notify
  AFTER INSERT ON public.event_participants
  FOR EACH ROW
  WHEN (NEW.status = 'joined')
  EXECUTE FUNCTION public.on_participant_joined_notify();

DROP TRIGGER IF EXISTS trg_participant_approved_notify ON public.event_participants;
CREATE TRIGGER trg_participant_approved_notify
  AFTER UPDATE OF status ON public.event_participants
  FOR EACH ROW
  WHEN (OLD.status = 'pending' AND NEW.status = 'joined')
  EXECUTE FUNCTION public.on_participant_joined_notify();

-- Quedan pocos lugares: SOLO a quien ya recibio una recomendacion o
-- invitacion de esta actividad y no se ha unido. Una vez por actividad.
CREATE OR REPLACE FUNCTION public.on_spots_low_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT n.user_id
    FROM public.notifications n
    WHERE n.event_id = NEW.id
      AND n.type IN ('new_campus_event', 'friend_created_event', 'friend_joined_event', 'event_invite')
      AND NOT EXISTS (SELECT 1 FROM public.event_participants ep WHERE ep.event_id = NEW.id AND ep.user_id = n.user_id)
    LIMIT 200
  LOOP
    PERFORM public.notify(r.user_id, 'spots_low', NULL, NEW.id, NULL, NULL,
      jsonb_build_object('left', NEW.max_spots - NEW.current_spots), 'spots_low:' || NEW.id, NULL, NEW.starts_at);
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.on_spots_low_notify() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_spots_low_notify ON public.events;
CREATE TRIGGER trg_spots_low_notify
  AFTER UPDATE OF current_spots ON public.events
  FOR EACH ROW
  WHEN (NEW.is_active AND NEW.max_spots >= 6
        AND NEW.current_spots < NEW.max_spots
        AND NEW.current_spots >= NEW.max_spots - 2
        AND OLD.current_spots < NEW.max_spots - 2)
  EXECUTE FUNCTION public.on_spots_low_notify();

-- Verificacion universitaria resuelta por el sistema o a mano (no cuando
-- la propia persona confirma su codigo: eso ya lo ve en la pantalla).
CREATE OR REPLACE FUNCTION public.on_affiliation_status_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT DISTINCT FROM NEW.user_id THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'verified' AND OLD.status <> 'verified' THEN
    PERFORM public.notify(NEW.user_id, 'verification_approved', NULL, NULL, NULL, NULL, '{}'::jsonb,
      'verified:' || COALESCE(NEW.verified_at::text, now()::text));
  ELSIF (OLD.status IN ('pending_email', 'manual_review') AND NEW.status IN ('unverified', 'revoked', 'expired'))
     OR (OLD.status = 'verified' AND NEW.status IN ('revoked', 'expired')) THEN
    PERFORM public.notify(NEW.user_id, 'verification_rejected', NULL, NULL, NULL, NULL,
      jsonb_build_object('status', NEW.status), 'verification_rejected:' || now()::date || ':' || NEW.status);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.on_affiliation_status_notify() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_affiliation_status_notify ON public.profile_affiliations;
CREATE TRIGGER trg_affiliation_status_notify
  AFTER UPDATE OF status ON public.profile_affiliations
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.on_affiliation_status_notify();

-- Seguridad: cambio de correo o de contrasena. No se pueden desactivar.
CREATE OR REPLACE FUNCTION public.on_auth_security_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.email IS NOT NULL AND NEW.email IS DISTINCT FROM OLD.email THEN
    PERFORM public.notify(NEW.id, 'security_alert', NULL, NULL, NULL, NULL,
      jsonb_build_object('kind', 'email_changed'), 'security:email:' || (extract(epoch FROM now())::bigint / 60),
      NULL, NULL, NULL, true);
  END IF;
  IF OLD.encrypted_password IS NOT NULL AND NEW.encrypted_password IS DISTINCT FROM OLD.encrypted_password THEN
    PERFORM public.notify(NEW.id, 'security_alert', NULL, NULL, NULL, NULL,
      jsonb_build_object('kind', 'password_changed'), 'security:password:' || (extract(epoch FROM now())::bigint / 60),
      NULL, NULL, NULL, true);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Un aviso no puede impedir cambiar el correo o la contrasena.
  RAISE WARNING 'on_auth_security_notify (%): %', SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.on_auth_security_notify() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_auth_security_notify ON auth.users;
CREATE TRIGGER trg_auth_security_notify
  AFTER UPDATE OF email, encrypted_password ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.on_auth_security_notify();

-- Alguien se unio con tu invitacion.
CREATE OR REPLACE FUNCTION public.on_invite_accepted_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.inviter_id IS NOT NULL AND NEW.invitee_id IS NOT NULL
     AND public.same_institution(NEW.inviter_id, NEW.invitee_id) THEN
    PERFORM public.notify(NEW.inviter_id, 'invite_accepted', NEW.invitee_id, NULL, NULL, NULL, '{}'::jsonb,
      'invite_accepted:' || NEW.invitee_id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.on_invite_accepted_notify() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_invite_accepted_notify ON public.invite_events;
CREATE TRIGGER trg_invite_accepted_notify
  AFTER INSERT ON public.invite_events
  FOR EACH ROW
  WHEN (NEW.kind = 'accepted')
  EXECUTE FUNCTION public.on_invite_accepted_notify();


-- ------------------------------------------------------------
-- 13. Avisos programados (los lanza pg_cron, ver 20260925010000)
-- ------------------------------------------------------------

-- Recomendar actividades solo una vez por actividad. Las que ya existen se
-- dan por recomendadas: la migracion no puede mandar un aviso por cada
-- actividad vieja (misma leccion que 20260921000000).
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS recommended_at timestamptz;
UPDATE public.events SET recommended_at = now() WHERE recommended_at IS NULL;

-- Intereses del perfil que hacen relevante cada categoria.
CREATE OR REPLACE FUNCTION public.category_interests(_category text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE _category
    WHEN 'study'        THEN ARRAY['StudyGroups', 'Languages', 'Science', 'Debate', 'Reading', 'History', 'Coding', 'AI']
    WHEN 'sports'       THEN ARRAY['Sports', 'Soccer', 'Basketball', 'Fitness', 'Running', 'Swimming', 'Tennis',
                               'Volleyball', 'Yoga', 'Climbing', 'Cycling', 'MartialArts', 'Hiking', 'Skating']
    WHEN 'social'       THEN ARRAY['Parties', 'BoardGames', 'Karaoke', 'Coffee', 'Food', 'Movies', 'Music', 'Dance',
                               'Gaming', 'Series', 'Anime']
    WHEN 'shopping'     THEN ARRAY['Food', 'Coffee', 'Travel', 'Design']
    WHEN 'volunteering' THEN ARRAY['Volunteering', 'Sustainability', 'Pets']
    ELSE ARRAY[]::text[]
  END;
$$;

-- Actividades nuevas: a los amigos de quien la crea y a quien del campus le
-- pega (intereses o haber ido a algo de la misma categoria). Mismo
-- dedupe_key para las dos: nadie recibe dos avisos de la misma actividad.
CREATE OR REPLACE FUNCTION public.notify_new_events()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ev  record;
  r   record;
  v_n integer := 0;
BEGIN
  FOR ev IN
    UPDATE public.events e
    SET recommended_at = now()
    WHERE e.recommended_at IS NULL
      -- Un par de minutos de gracia por si la persona corrige algo al crearla.
      AND e.created_at <= now() - interval '2 minutes'
    RETURNING e.id, e.creator_id, e.privacy, e.category, e.starts_at, e.is_active, e.institution_id
  LOOP
    CONTINUE WHEN NOT ev.is_active OR ev.starts_at < now() + interval '1 hour';

    FOR r IN
      SELECT CASE WHEN f.requester_id = ev.creator_id THEN f.addressee_id ELSE f.requester_id END AS uid
      FROM public.friendships f
      WHERE f.status = 'accepted' AND (f.requester_id = ev.creator_id OR f.addressee_id = ev.creator_id)
      LIMIT 200
    LOOP
      CONTINUE WHEN NOT public.same_institution(r.uid, ev.creator_id);
      IF public.notify(r.uid, 'friend_created_event', ev.creator_id, ev.id, NULL, NULL, '{}'::jsonb,
                       'event_new:' || ev.id, NULL, ev.starts_at) IS NOT NULL THEN
        v_n := v_n + 1;
      END IF;
    END LOOP;

    CONTINUE WHEN ev.privacy NOT IN ('open', 'private');

    FOR r IN
      SELECT p.id AS uid
      FROM public.profiles p
      WHERE p.campus_id = ev.institution_id
        AND p.id <> ev.creator_id
        AND p.onboarding_completed
        AND (
          p.interests && public.category_interests(ev.category)
          OR EXISTS (
            SELECT 1 FROM public.event_participants ep
            JOIN public.events e2 ON e2.id = ep.event_id
            WHERE ep.user_id = p.id AND ep.status = 'joined' AND e2.category = ev.category
              AND e2.starts_at > now() - interval '90 days'
          )
        )
      LIMIT 300
    LOOP
      IF public.notify(r.uid, 'new_campus_event', ev.creator_id, ev.id, NULL, NULL, '{}'::jsonb,
                       'event_new:' || ev.id, NULL, ev.starts_at) IS NOT NULL THEN
        v_n := v_n + 1;
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.notify_new_events() FROM PUBLIC, anon, authenticated;

-- Recordatorio antes de empezar, con los minutos que eligio cada persona.
-- A quien organiza y a quien se unio antes de ese momento.
CREATE OR REPLACE FUNCTION public.notify_upcoming_events()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r   record;
  v_n integer := 0;
BEGIN
  FOR r IN
    SELECT e.id, e.starts_at, x.uid, COALESCE(np.reminder_minutes, 60) AS mins
    FROM public.events e
    CROSS JOIN LATERAL (
      SELECT e.creator_id AS uid, e.created_at AS since
      UNION ALL
      SELECT ep.user_id, COALESCE(ep.approved_at, ep.joined_at)
      FROM public.event_participants ep
      WHERE ep.event_id = e.id AND ep.status = 'joined'
    ) x
    LEFT JOIN public.notification_preferences np ON np.user_id = x.uid
    WHERE e.is_active
      AND e.starts_at > now() + interval '5 minutes'
      AND e.starts_at <= now() + interval '1 day 1 minute'
      AND e.starts_at <= now() + make_interval(mins => COALESCE(np.reminder_minutes, 60))
      AND x.since < e.starts_at - make_interval(mins => COALESCE(np.reminder_minutes, 60))
  LOOP
    IF public.notify(r.uid, 'event_reminder', NULL, r.id, NULL, NULL, jsonb_build_object('minutes', r.mins),
                     'reminder:' || r.id, NULL, r.starts_at) IS NOT NULL THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.notify_upcoming_events() FROM PUBLIC, anon, authenticated;

-- Resumen de planes a las 10:00 locales, como mucho cada 3 dias y solo si
-- hay al menos 3 planes proximos que la persona podria ver y no tiene.
CREATE OR REPLACE FUNCTION public.notify_daily_digests()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r   record;
  v_n integer := 0;
BEGIN
  FOR r IN
    SELECT p.id AS uid, p.campus_id, np.timezone,
           (now() AT TIME ZONE np.timezone)::date AS hoy
    FROM public.profiles p
    JOIN public.notification_preferences np ON np.user_id = p.id AND np.digests
    WHERE p.onboarding_completed AND p.campus_id IS NOT NULL
      AND extract(hour FROM now() AT TIME ZONE np.timezone) = 10
      AND NOT EXISTS (
        SELECT 1 FROM public.notifications n
        WHERE n.user_id = p.id AND n.type = 'digest' AND n.created_at > now() - interval '3 days'
      )
    LIMIT 2000
  LOOP
    DECLARE
      v_count integer;
    BEGIN
      SELECT count(*) INTO v_count
      FROM public.events e
      WHERE e.institution_id = r.campus_id
        AND e.is_active AND e.privacy IN ('open', 'private')
        AND e.starts_at > now() + interval '1 hour' AND e.starts_at < now() + interval '3 days'
        AND e.creator_id <> r.uid
        AND NOT public.is_blocked(r.uid, e.creator_id)
        AND NOT EXISTS (SELECT 1 FROM public.event_participants ep WHERE ep.event_id = e.id AND ep.user_id = r.uid);
      IF v_count >= 3 THEN
        IF public.notify(r.uid, 'digest', NULL, NULL, NULL, NULL, jsonb_build_object('count', v_count),
                         'digest:' || r.hoy) IS NOT NULL THEN
          v_n := v_n + 1;
        END IF;
      END IF;
    END;
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.notify_daily_digests() FROM PUBLIC, anon, authenticated;

-- Una persona que quiza conozcas, a las 18:00 locales y como mucho una por
-- semana: primero de tus contactos, si no alguien con 2+ amigos en comun.
CREATE OR REPLACE FUNCTION public.notify_people_suggestions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r      record;
  v_cand uuid;
  v_n    integer := 0;
BEGIN
  FOR r IN
    SELECT p.id AS uid
    FROM public.profiles p
    JOIN public.notification_preferences np ON np.user_id = p.id AND np.people_suggestions
    WHERE p.onboarding_completed
      AND extract(hour FROM now() AT TIME ZONE np.timezone) = 18
      AND NOT EXISTS (
        SELECT 1 FROM public.notifications n
        WHERE n.user_id = p.id AND n.type = 'person_suggestion' AND n.created_at > now() - interval '7 days'
      )
    LIMIT 2000
  LOOP
    v_cand := NULL;

    SELECT cm.matched_user_id INTO v_cand
    FROM public.contact_matches cm
    WHERE cm.owner_id = r.uid
      AND public.same_institution(r.uid, cm.matched_user_id)
      AND NOT public.is_blocked(r.uid, cm.matched_user_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.friendships f
        WHERE (f.requester_id = r.uid AND f.addressee_id = cm.matched_user_id)
           OR (f.requester_id = cm.matched_user_id AND f.addressee_id = r.uid))
      AND NOT EXISTS (
        SELECT 1 FROM public.notifications n
        WHERE n.user_id = r.uid AND n.dedupe_key = 'suggestion:' || cm.matched_user_id)
    ORDER BY cm.created_at DESC
    LIMIT 1;

    IF v_cand IS NULL THEN
      SELECT c.pid INTO v_cand
      FROM (
        SELECT CASE WHEN g.requester_id = m.fid THEN g.addressee_id ELSE g.requester_id END AS pid, count(*) AS n
        FROM (
          SELECT CASE WHEN f.requester_id = r.uid THEN f.addressee_id ELSE f.requester_id END AS fid
          FROM public.friendships f
          WHERE f.status = 'accepted' AND (f.requester_id = r.uid OR f.addressee_id = r.uid)
        ) m
        JOIN public.friendships g ON g.status = 'accepted' AND (g.requester_id = m.fid OR g.addressee_id = m.fid)
        GROUP BY 1
      ) c
      WHERE c.pid <> r.uid AND c.n >= 2
        AND public.same_institution(r.uid, c.pid)
        AND NOT public.is_blocked(r.uid, c.pid)
        AND NOT EXISTS (
          SELECT 1 FROM public.friendships f
          WHERE (f.requester_id = r.uid AND f.addressee_id = c.pid)
             OR (f.requester_id = c.pid AND f.addressee_id = r.uid))
        AND NOT EXISTS (
          SELECT 1 FROM public.notifications n
          WHERE n.user_id = r.uid AND n.dedupe_key = 'suggestion:' || c.pid)
      ORDER BY c.n DESC
      LIMIT 1;
    END IF;

    IF v_cand IS NOT NULL AND public.notify(r.uid, 'person_suggestion', v_cand, NULL, NULL, NULL, '{}'::jsonb,
                                            'suggestion:' || v_cand) IS NOT NULL THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.notify_people_suggestions() FROM PUBLIC, anon, authenticated;

-- Perfil y verificacion, a las 12:00 locales, sin bloquear nada de la app,
-- y como mucho un recordatorio de cuenta cada 3 dias.
CREATE OR REPLACE FUNCTION public.notify_account_nudges()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r   record;
  v_n integer := 0;
BEGIN
  FOR r IN
    SELECT p.id AS uid, p.avatar_url, p.interests, p.created_at, a.status AS verif, a.updated_at AS verif_at
    FROM public.profiles p
    JOIN public.notification_preferences np ON np.user_id = p.id AND np.account_tips
    LEFT JOIN public.profile_affiliations a ON a.user_id = p.id
    WHERE p.onboarding_completed
      AND extract(hour FROM now() AT TIME ZONE np.timezone) = 12
      AND NOT EXISTS (
        SELECT 1 FROM public.notifications n
        WHERE n.user_id = p.id AND n.category = 'account' AND n.created_at > now() - interval '3 days'
      )
    LIMIT 2000
  LOOP
    IF r.verif = 'pending_email' AND r.verif_at < now() - interval '1 day' THEN
      IF public.notify(r.uid, 'verification_pending', NULL, NULL, NULL, NULL, '{}'::jsonb,
                       'verification_pending:' || r.verif_at::date) IS NOT NULL THEN
        v_n := v_n + 1; CONTINUE;
      END IF;
    END IF;
    IF r.created_at < now() - interval '2 days' AND (r.avatar_url IS NULL OR COALESCE(cardinality(r.interests), 0) = 0) THEN
      IF public.notify(r.uid, 'profile_incomplete', NULL, NULL, NULL, NULL, '{}'::jsonb,
                       'profile_incomplete') IS NOT NULL THEN
        v_n := v_n + 1; CONTINUE;
      END IF;
    END IF;
    IF COALESCE(r.verif, 'unverified') = 'unverified' AND r.created_at < now() - interval '7 days' THEN
      IF public.notify(r.uid, 'verification_reminder', NULL, NULL, NULL, NULL, '{}'::jsonb,
                       'verify_reminder') IS NOT NULL THEN
        v_n := v_n + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.notify_account_nudges() FROM PUBLIC, anon, authenticated;

-- Retencion: la bandeja no crece sin limite y las entregas son metrica.
CREATE OR REPLACE FUNCTION public.purge_old_notifications()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v integer;
BEGIN
  DELETE FROM public.notification_deliveries WHERE created_at < now() - interval '30 days';
  DELETE FROM public.notifications
  WHERE (read_at IS NOT NULL AND updated_at < now() - interval '60 days')
     OR updated_at < now() - interval '120 days';
  GET DIAGNOSTICS v = ROW_COUNT;
  PERFORM public.purge_expired_contact_hashes();
  RETURN v;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.purge_old_notifications() FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 14. Metricas (solo para el panel: sin GRANT a la app)
--
-- Recuentos por dia y tipo. Ni texto ni destinatarios.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.notification_metrics_daily AS
SELECT
  date_trunc('day', n.created_at)::date AS day,
  n.type,
  count(*)                                                        AS created,
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM public.notification_deliveries d WHERE d.notification_id = n.id AND d.status = 'sent')) AS pushed,
  count(n.read_at)                                                AS read,
  count(n.opened_at)                                              AS opened,
  count(n.converted_at)                                           AS converted
FROM public.notifications n
GROUP BY 1, 2;

REVOKE ALL ON public.notification_metrics_daily FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 15. notification_counts gana notifications_unread
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.notification_counts();

CREATE FUNCTION public.notification_counts()
RETURNS TABLE (
  join_requests        bigint,
  friend_requests      bigint,
  unread_messages      bigint,
  approvals            bigint,
  group_invites        bigint,
  event_chat_unread    bigint,
  notifications_unread bigint
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

    (SELECT count(*)
       FROM public.event_chat_state s
       JOIN public.events e   ON e.id = s.event_id AND e.is_active
       JOIN public.messages m ON m.event_id = s.event_id
      WHERE s.user_id = auth.uid()
        AND m.created_at > s.last_read_at
        AND m.sender_id <> s.user_id
        AND m.deleted_at IS NULL
        AND public.event_chat_member(s.event_id, s.user_id)
        AND NOT public.is_blocked(s.user_id, m.sender_id)),

    (SELECT count(*)
       FROM public.notifications n
      WHERE n.user_id = auth.uid()
        AND n.read_at IS NULL
        AND (n.actor_id IS NULL OR NOT public.is_blocked(auth.uid(), n.actor_id)));
$$;

REVOKE EXECUTE ON FUNCTION public.notification_counts() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.notification_counts() TO authenticated;


-- ------------------------------------------------------------
-- 16. Tiempo real de la bandeja (la RLS decide que llega a quien)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;
END $$;

COMMIT;
