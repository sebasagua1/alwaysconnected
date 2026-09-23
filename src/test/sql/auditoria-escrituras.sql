-- Estado ANTERIOR a 20260920000000, copiado literalmente de las migraciones.
--
-- Existe para que las pruebas de auditoriaEscrituras.sql.test.ts demuestren
-- dos cosas en la misma corrida: que el hueco era real (los tests de la
-- seccion "antes" lo explotan sobre este fixture) y que la migracion lo
-- cierra (los de la seccion "despues" lo intentan con la migracion aplicada).
--
-- Si alguna vez se borra la migracion, la mitad "despues" falla. Ese es el
-- punto: las 39 pruebas de RLS de verdad siguen omitidas por falta de un
-- proyecto Supabase dedicado, asi que esto es lo unico que corre en CI.

CREATE ROLE authenticated NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;

CREATE TABLE public.institutions (id uuid PRIMARY KEY, name text);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name text,
  campus_id uuid
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own" ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid());

CREATE TABLE public.blocks (blocker_id uuid NOT NULL, blocked_id uuid NOT NULL, PRIMARY KEY (blocker_id, blocked_id));
ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.is_blocked(a uuid, b uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.blocks WHERE (blocker_id = a AND blocked_id = b) OR (blocker_id = b AND blocked_id = a));
$$;

-- ------------------------------------------------------------
-- friendships (20260325002039 + 20260518070740 + 20260817010000)
-- ------------------------------------------------------------
CREATE TABLE public.friendships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  addressee_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requester_id, addressee_id)
);
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.are_friends(a uuid, b uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.friendships WHERE status = 'accepted'
    AND ((requester_id = a AND addressee_id = b) OR (requester_id = b AND addressee_id = a)));
$$;

CREATE POLICY "Users can view own friendships" ON public.friendships FOR SELECT TO authenticated
  USING (auth.uid() = requester_id OR auth.uid() = addressee_id);
-- SEC-02: no restringe status, y no hay ningun BEFORE INSERT.
CREATE POLICY "Users can send friend requests" ON public.friendships FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = requester_id AND NOT public.is_blocked(requester_id, addressee_id));
CREATE POLICY "Addressee can update friendship" ON public.friendships FOR UPDATE TO authenticated
  USING (auth.uid() = addressee_id) WITH CHECK (auth.uid() = addressee_id);

CREATE FUNCTION public.same_institution(_a uuid, _b uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles pa JOIN public.profiles pb ON pb.id = _b
    WHERE pa.id = _a AND pa.campus_id IS NOT NULL AND pa.campus_id = pb.campus_id);
$$;

-- ------------------------------------------------------------
-- events (20260325002039 + 20260829000000 + 20260903000000)
-- ------------------------------------------------------------
CREATE TABLE public.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  address text,
  privacy text NOT NULL DEFAULT 'open' CHECK (privacy IN ('open', 'friends', 'private')),
  max_spots int,
  current_spots int NOT NULL DEFAULT 0,
  institution_id uuid REFERENCES public.institutions(id),
  lat double precision,
  lng double precision,
  starts_at timestamptz NOT NULL DEFAULT now() + interval '1 day',
  ends_at timestamptz NOT NULL DEFAULT now() + interval '1 day 1 hour',
  created_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  repeated_from uuid REFERENCES public.events(id)
);
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Events visibility policy" ON public.events FOR SELECT TO authenticated
  USING (
    creator_id = auth.uid()
    OR (
      NOT public.is_blocked(auth.uid(), creator_id)
      AND public.same_institution(auth.uid(), creator_id)
      AND (privacy IN ('open', 'private')
           OR (privacy = 'friends' AND public.are_friends(creator_id, auth.uid())))
    )
  );
CREATE POLICY "Authenticated users can create events" ON public.events FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = creator_id);
-- SEC-04 / aislamiento: sin WITH CHECK y sin guardian de columnas.
CREATE POLICY "Creators can update their events" ON public.events FOR UPDATE TO authenticated
  USING (auth.uid() = creator_id);

CREATE FUNCTION public.set_event_institution() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  SELECT campus_id INTO NEW.institution_id FROM public.profiles WHERE id = NEW.creator_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_set_event_institution BEFORE INSERT ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.set_event_institution();

-- 20260903000000, literal: cuenta filas filtrando por su propio created_at.
CREATE FUNCTION public.enforce_event_rate_limit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_ultima int;
  v_dia    int;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;

  SELECT
    count(*) FILTER (WHERE created_at > now() - interval '1 hour'),
    count(*) FILTER (WHERE created_at > now() - interval '1 day')
  INTO v_ultima, v_dia
  FROM public.events
  WHERE creator_id = v_uid AND created_at > now() - interval '1 day';

  IF v_ultima >= 5 OR v_dia >= 20 THEN
    RAISE EXCEPTION 'EVENT_RATE_LIMIT' USING HINT = 'Demasiados eventos creados en poco tiempo.';
  END IF;

  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_event_rate_limit BEFORE INSERT ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_event_rate_limit();

-- ------------------------------------------------------------
-- event_participants (20260325002039 + 20260819000000 + 20260820000000)
-- ------------------------------------------------------------
CREATE TABLE public.event_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'joined' CHECK (status IN ('joined', 'pending', 'declined')),
  checked_in boolean NOT NULL DEFAULT false,
  rating int,
  joined_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  approval_seen boolean NOT NULL DEFAULT true,
  UNIQUE (event_id, user_id)
);
ALTER TABLE public.event_participants ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.is_event_creator(_event_id uuid, _user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.events WHERE id = _event_id AND creator_id = _user_id);
$$;
CREATE FUNCTION public.is_event_participant(_event_id uuid, _user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.event_participants
                 WHERE event_id = _event_id AND user_id = _user_id AND status = 'joined');
$$;

CREATE POLICY "Participants and creators can view event participants"
  ON public.event_participants FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_event_creator(event_id, auth.uid())
         OR public.is_event_participant(event_id, auth.uid()));
CREATE POLICY "Users can join events" ON public.event_participants FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
-- SEC-01: USING sin WITH CHECK. USING solo mira user_id, asi que event_id
-- puede cambiar a cualquier cosa.
CREATE POLICY "Users can update own participation" ON public.event_participants FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users can leave events" ON public.event_participants FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

CREATE FUNCTION public.set_participant_initial_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_privacy    text;
  v_creator_id uuid;
BEGIN
  SELECT privacy, creator_id INTO v_privacy, v_creator_id
  FROM public.events WHERE id = NEW.event_id;

  IF NOT FOUND THEN RAISE EXCEPTION 'EVENT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;

  IF v_privacy = 'private' AND NEW.user_id <> v_creator_id THEN
    NEW.status := 'pending';
  ELSE
    NEW.status := 'joined';
  END IF;

  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_set_participant_initial_status BEFORE INSERT ON public.event_participants
  FOR EACH ROW EXECUTE FUNCTION public.set_participant_initial_status();

-- INVOKER a proposito (20260820000000): necesita ver current_user.
CREATE FUNCTION public.prevent_status_tampering() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'permission denied: solo el organizador puede aprobar o rechazar'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_prevent_status_tampering BEFORE UPDATE ON public.event_participants
  FOR EACH ROW EXECUTE FUNCTION public.prevent_status_tampering();

-- 20260918000000, simplificado: quien ve el evento ve a quien va.
CREATE FUNCTION public.event_attendees(_event_id uuid)
RETURNS TABLE (user_id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.user_id, pr.name
  FROM public.event_participants p
  JOIN public.profiles pr ON pr.id = p.user_id
  WHERE p.event_id = _event_id AND p.status = 'joined';
$$;

-- ------------------------------------------------------------
-- groups y messages (20260325002039 + 20260825000000 + 20260914000000)
-- ------------------------------------------------------------
CREATE TABLE public.groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Group members can view groups" ON public.groups FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can create groups" ON public.groups FOR INSERT TO authenticated WITH CHECK (auth.uid() = created_by);
CREATE POLICY "Creators can update groups" ON public.groups FOR UPDATE TO authenticated USING (auth.uid() = created_by);

CREATE TABLE public.group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, user_id)
);
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.is_group_member(_group_id uuid, _user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.group_members WHERE group_id = _group_id AND user_id = _user_id);
$$;
CREATE POLICY "Members can view fellow group members" ON public.group_members FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_group_member(group_id, auth.uid()));

CREATE FUNCTION public.on_group_created_add_creator() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.group_members (group_id, user_id) VALUES (NEW.id, NEW.created_by)
  ON CONFLICT (group_id, user_id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_group_created_add_creator AFTER INSERT ON public.groups
  FOR EACH ROW EXECUTE FUNCTION public.on_group_created_add_creator();

CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid REFERENCES public.groups(id) ON DELETE CASCADE,
  event_id uuid REFERENCES public.events(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  deleted_at timestamptz
);
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view messages in their events or groups" ON public.messages FOR SELECT TO authenticated
  USING (
    NOT public.is_blocked(auth.uid(), sender_id)
    AND (sender_id = auth.uid()
         OR (event_id IS NOT NULL AND public.is_event_participant(event_id, auth.uid()))
         OR (group_id IS NOT NULL AND public.is_group_member(group_id, auth.uid())))
  );
CREATE POLICY "Members can send messages" ON public.messages FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND ((event_id IS NOT NULL AND public.is_event_participant(event_id, auth.uid()))
         OR (group_id IS NOT NULL AND public.is_group_member(group_id, auth.uid())))
  );
CREATE POLICY "Senders can edit own messages" ON public.messages FOR UPDATE TO authenticated
  USING (
    sender_id = auth.uid() AND deleted_at IS NULL
    AND ((event_id IS NOT NULL AND public.is_event_participant(event_id, auth.uid()))
         OR (group_id IS NOT NULL AND public.is_group_member(group_id, auth.uid())))
  )
  WITH CHECK (sender_id = auth.uid());

-- SEC-08: solo toca expires_at. created_at se queda como la mande el cliente.
-- DEFINER, que es justo lo que impediria ver current_user.
CREATE FUNCTION public.set_message_expiry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.expires_at := now() + interval '90 days';
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_set_message_expiry BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.set_message_expiry();

-- 20260919000000, la parte que cuenta no leidos de un grupo.
CREATE FUNCTION public.mark_group_read(_group_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.group_members SET last_read_at = now()
  WHERE group_id = _group_id AND user_id = auth.uid();
END;
$$;
GRANT EXECUTE ON FUNCTION public.mark_group_read(uuid) TO authenticated;

CREATE FUNCTION public.no_leidos(_group_id uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)
  FROM public.group_members gm
  JOIN public.messages m ON m.group_id = gm.group_id
  WHERE gm.group_id = _group_id
    AND gm.user_id = auth.uid()
    AND m.sender_id <> auth.uid()
    AND m.created_at > gm.last_read_at
    AND m.deleted_at IS NULL;
$$;
GRANT EXECUTE ON FUNCTION public.no_leidos(uuid) TO authenticated;

-- push_send de verdad llama a pg_net; aqui se apunta en una tabla.
CREATE TABLE public.push_log (user_id uuid, title text, body text, data jsonb, at timestamptz DEFAULT clock_timestamp());
CREATE FUNCTION public.push_send(_user_id uuid, _title text, _body text, _data jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.push_log (user_id, title, body, data) VALUES (_user_id, _title, _body, _data);
$$;
REVOKE EXECUTE ON FUNCTION public.push_send(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- 20260827000000: solo avisa de las solicitudes 'pending'. Por eso una
-- amistad autoconcedida (SEC-02) ni siquiera generaba notificacion.
CREATE FUNCTION public.on_friend_request_push() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.push_send(NEW.addressee_id, 'Nueva solicitud', 'Alguien quiere ser tu amigo',
                           jsonb_build_object('type', 'friend_request'));
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_friend_request_push AFTER INSERT ON public.friendships
  FOR EACH ROW WHEN (NEW.status = 'pending') EXECUTE FUNCTION public.on_friend_request_push();

-- 20260919000000, literal: concatena NEW.title SIN truncar. APNs rechaza
-- cargas de mas de 4 KB, asi que un titulo largo rompe la push en silencio.
CREATE FUNCTION public.on_event_repeat_push() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_who text;
  r     record;
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
CREATE TRIGGER trg_event_repeat_push AFTER INSERT ON public.events
  FOR EACH ROW WHEN (NEW.repeated_from IS NOT NULL)
  EXECUTE FUNCTION public.on_event_repeat_push();

-- ------------------------------------------------------------
-- reports (20260325002039 + 20260817010000)
-- ------------------------------------------------------------
CREATE TABLE public.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reported_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,  -- SEC-09
  reported_event_id uuid REFERENCES public.events(id) ON DELETE CASCADE,
  reported_message_id uuid REFERENCES public.messages(id) ON DELETE CASCADE,
  reason text NOT NULL,
  details text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reports_one_target CHECK (
    (reported_user_id    IS NOT NULL)::int
  + (reported_event_id   IS NOT NULL)::int
  + (reported_message_id IS NOT NULL)::int = 1
  )
);
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX reports_unique_user_target
  ON public.reports (reporter_id, reported_user_id) WHERE reported_user_id IS NOT NULL;
CREATE POLICY "Reporters can view their own reports" ON public.reports FOR SELECT TO authenticated
  USING (auth.uid() = reporter_id);
CREATE POLICY "Users can create reports" ON public.reports FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = reporter_id
    AND (reported_user_id IS NULL OR reported_user_id <> auth.uid())
  );

GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT INSERT, UPDATE, DELETE ON
  public.events, public.event_participants, public.friendships,
  public.groups, public.messages, public.reports TO authenticated;
