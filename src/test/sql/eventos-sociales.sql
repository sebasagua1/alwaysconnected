CREATE ROLE authenticated NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id),
  name text,
  avatar_url text,
  campus_id uuid,
  student_id text
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own" ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid());

CREATE TABLE public.friendships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL, addressee_id uuid NOT NULL, status text NOT NULL
);
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.blocks (blocker_id uuid NOT NULL, blocked_id uuid NOT NULL, PRIMARY KEY (blocker_id, blocked_id));
ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.is_blocked(a uuid, b uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.blocks WHERE (blocker_id = a AND blocked_id = b) OR (blocker_id = b AND blocked_id = a));
$$;
CREATE FUNCTION public.are_friends(a uuid, b uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.friendships WHERE status = 'accepted'
    AND ((requester_id = a AND addressee_id = b) OR (requester_id = b AND addressee_id = a)));
$$;
CREATE FUNCTION public.same_institution(_a uuid, _b uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles pa JOIN public.profiles pb ON pb.id = _b
    WHERE pa.id = _a AND pa.campus_id IS NOT NULL AND pa.campus_id = pb.campus_id);
$$;

CREATE TABLE public.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES auth.users(id),
  title text NOT NULL,
  privacy text NOT NULL DEFAULT 'open' CHECK (privacy IN ('open', 'friends', 'private')),
  category text NOT NULL DEFAULT 'social',
  starts_at timestamptz NOT NULL DEFAULT now() - interval '2 hours',
  ends_at timestamptz NOT NULL DEFAULT now() - interval '1 hour',
  created_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true
);
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Events visibility policy"
  ON public.events FOR SELECT TO authenticated
  USING (
    creator_id = auth.uid()
    OR (
      NOT public.is_blocked(auth.uid(), creator_id)
      AND public.same_institution(auth.uid(), creator_id)
      AND (
        privacy IN ('open', 'private')
        OR (privacy = 'friends' AND public.are_friends(creator_id, auth.uid()))
      )
    )
  );

CREATE POLICY "Authenticated users can create events" ON public.events FOR INSERT TO authenticated WITH CHECK (auth.uid() = creator_id);
CREATE POLICY "Creators can update their events" ON public.events FOR UPDATE TO authenticated USING (auth.uid() = creator_id);

CREATE TABLE public.event_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  status text NOT NULL DEFAULT 'joined' CHECK (status IN ('joined', 'pending', 'declined')),
  checked_in boolean NOT NULL DEFAULT false,
  rating int,
  joined_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  approval_seen boolean NOT NULL DEFAULT true,
  UNIQUE (event_id, user_id)
);
ALTER TABLE public.event_participants ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.is_event_creator(_event_id uuid, _user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.events WHERE id = _event_id AND creator_id = _user_id);
$$;
CREATE FUNCTION public.is_event_participant(_event_id uuid, _user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.event_participants WHERE event_id = _event_id AND user_id = _user_id AND status = 'joined');
$$;
CREATE POLICY "Participants and creators can view event participants"
  ON public.event_participants FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_event_creator(event_id, auth.uid()) OR public.is_event_participant(event_id, auth.uid()));


-- Grupos, mensajes y push (20260818, 20260827, 20260914)
CREATE TABLE public.groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Group members can view groups" ON public.groups FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can create groups" ON public.groups FOR INSERT TO authenticated WITH CHECK (auth.uid() = created_by);

CREATE TABLE public.group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, user_id)
);
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.is_group_member(_group_id uuid, _user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.group_members WHERE group_id = _group_id AND user_id = _user_id);
$$;
CREATE POLICY "Members can view fellow group members" ON public.group_members FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_group_member(group_id, auth.uid()));

CREATE FUNCTION public.on_group_created_add_creator() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.group_members (group_id, user_id) VALUES (NEW.id, NEW.created_by) ON CONFLICT (group_id, user_id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_group_created_add_creator AFTER INSERT ON public.groups FOR EACH ROW EXECUTE FUNCTION public.on_group_created_add_creator();

CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid REFERENCES public.groups(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL,
  content text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- push_send de verdad llama a pg_net; aqui se apunta en una tabla.
CREATE TABLE public.push_log (user_id uuid, title text, body text, data jsonb, at timestamptz DEFAULT clock_timestamp());
CREATE FUNCTION public.push_send(_user_id uuid, _title text, _body text, _data jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.push_log (user_id, title, body, data) VALUES (_user_id, _title, _body, _data);
$$;
REVOKE EXECUTE ON FUNCTION public.push_send(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.notification_counts()
RETURNS TABLE (join_requests bigint, friend_requests bigint, unread_messages bigint, approvals bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 0::bigint, 0::bigint, 0::bigint, 0::bigint;
$$;
GRANT EXECUTE ON FUNCTION public.notification_counts() TO authenticated;

GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT INSERT, UPDATE ON public.events, public.event_participants, public.groups TO authenticated;
