-- ============================================================
-- Always Connected — esquema completo (consolidado de migrations/)
-- Pegar en el SQL Editor de un proyecto Supabase NUEVO y ejecutar.
--
-- NO EDITAR A MANO: lo genera scripts/gen-full-schema.mjs.
-- Migraciones incluidas: 44 (hasta 20260919000000_despues-del-evento.sql).
--
-- NOTA: se omite el bloque de RLS sobre realtime.messages (tabla
-- interna de Supabase) porque el SQL Editor no es su dueño. El
-- realtime por postgres_changes funciona igual vía la RLS de las
-- tablas public.* y la publicación supabase_realtime. Ver README.
--
-- Los SELECT de comprobación que cierran cada migración se omiten
-- aquí: son para ejecutarlas sueltas, no para el arranque.
-- ============================================================

-- >>> 20260325002039_580a4570-80e2-489b-a6c5-bff44bc6f240.sql <<<

-- Enable PostGIS for location points
CREATE EXTENSION IF NOT EXISTS postgis;

-- ============================================================
-- PROFILES TABLE (linked to auth.users)
-- ============================================================
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  major TEXT,
  semester INTEGER,
  residence_type TEXT CHECK (residence_type IN ('local', 'foraneo', 'international')),
  interests TEXT[] DEFAULT '{}',
  languages TEXT[] DEFAULT '{}',
  availability JSONB DEFAULT '{}',
  points INTEGER NOT NULL DEFAULT 0,
  reputation FLOAT NOT NULL DEFAULT 0,
  onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view all profiles" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- EVENTS TABLE
-- ============================================================
CREATE TABLE public.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('study', 'sports', 'social', 'shopping', 'volunteering', 'other')),
  lng DOUBLE PRECISION,
  lat DOUBLE PRECISION,
  address TEXT,
  description TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  max_spots INTEGER NOT NULL DEFAULT 10,
  current_spots INTEGER NOT NULL DEFAULT 0,
  privacy TEXT NOT NULL DEFAULT 'open' CHECK (privacy IN ('open', 'friends', 'private')),
  is_recurring BOOLEAN NOT NULL DEFAULT FALSE,
  recurrence_rule TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view open active events" ON public.events FOR SELECT TO authenticated
  USING (privacy = 'open' OR creator_id = auth.uid());
CREATE POLICY "Authenticated users can create events" ON public.events FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = creator_id);
CREATE POLICY "Creators can update their events" ON public.events FOR UPDATE TO authenticated
  USING (auth.uid() = creator_id);
CREATE POLICY "Creators can delete their events" ON public.events FOR DELETE TO authenticated
  USING (auth.uid() = creator_id);

-- ============================================================
-- EVENT PARTICIPANTS
-- ============================================================
CREATE TABLE public.event_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'joined' CHECK (status IN ('joined', 'pending', 'declined')),
  checked_in BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id)
);

ALTER TABLE public.event_participants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view event participants" ON public.event_participants FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can join events" ON public.event_participants FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own participation" ON public.event_participants FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users can leave events" ON public.event_participants FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- ============================================================
-- FRIENDSHIPS
-- ============================================================
CREATE TABLE public.friendships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  addressee_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (requester_id, addressee_id)
);

ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own friendships" ON public.friendships FOR SELECT TO authenticated
  USING (auth.uid() = requester_id OR auth.uid() = addressee_id);
CREATE POLICY "Users can send friend requests" ON public.friendships FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = requester_id);
CREATE POLICY "Users can update own friendships" ON public.friendships FOR UPDATE TO authenticated
  USING (auth.uid() = requester_id OR auth.uid() = addressee_id);
CREATE POLICY "Users can delete own friendships" ON public.friendships FOR DELETE TO authenticated
  USING (auth.uid() = requester_id OR auth.uid() = addressee_id);

-- ============================================================
-- GROUPS
-- ============================================================
CREATE TABLE public.groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  photo_url TEXT,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Group members can view groups" ON public.groups FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can create groups" ON public.groups FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = created_by);
CREATE POLICY "Creators can update groups" ON public.groups FOR UPDATE TO authenticated
  USING (auth.uid() = created_by);

-- ============================================================
-- GROUP MEMBERS
-- ============================================================
CREATE TABLE public.group_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, user_id)
);

ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view group members" ON public.group_members FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can join groups" ON public.group_members FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can leave groups" ON public.group_members FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- ============================================================
-- MESSAGES (ephemeral)
-- ============================================================
CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID REFERENCES public.events(id) ON DELETE CASCADE,
  group_id UUID REFERENCES public.groups(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view messages for their events/groups" ON public.messages FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can send messages" ON public.messages FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = sender_id);

-- ============================================================
-- BADGES
-- ============================================================
CREATE TABLE public.badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  badge_type TEXT NOT NULL,
  earned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, badge_type)
);

ALTER TABLE public.badges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view badges" ON public.badges FOR SELECT TO authenticated USING (true);
CREATE POLICY "System can insert badges" ON public.badges FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- REPORTS
-- ============================================================
CREATE TABLE public.reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reported_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  reported_event_id UUID REFERENCES public.events(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can create reports" ON public.reports FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = reporter_id);

-- ============================================================
-- Updated_at trigger function
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- Enable Realtime
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.events;
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.event_participants;

-- ============================================================
-- Storage bucket for avatars
-- ============================================================
INSERT INTO storage.buckets (id, name, public) VALUES ('avatars', 'avatars', true);

CREATE POLICY "Avatar images are publicly accessible" ON storage.objects FOR SELECT USING (bucket_id = 'avatars');
CREATE POLICY "Users can upload their own avatar" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users can update their own avatar" ON storage.objects FOR UPDATE USING (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);

-- >>> 20260325002054_ff739100-9da0-4f4b-8e55-e0122e1ecf77.sql <<<

-- Fix: Move PostGIS to a dedicated schema
DROP EXTENSION IF EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis SCHEMA extensions;

-- Fix: Set search_path on update_updated_at_column
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- >>> 20260326151750_6a998335-d3f9-4f6a-8fae-3467a3e7cc34.sql <<<
-- Create campuses table
CREATE TABLE public.campuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  email_domain text UNIQUE,
  lat double precision,
  lng double precision,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.campuses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view campuses" ON public.campuses
  FOR SELECT TO authenticated USING (true);

-- Seed Tec de Monterrey
INSERT INTO public.campuses (name, email_domain, lat, lng)
VALUES ('Tec de Monterrey', 'tec.mx', 25.6514, -100.2899);

-- Add campus_id to profiles
ALTER TABLE public.profiles ADD COLUMN campus_id uuid REFERENCES public.campuses(id);

-- >>> 20260505192643_d89fe78d-0572-4638-b087-70edd10d261b.sql <<<

-- 1. Profiles: restrict email visibility — users see their own full profile, others see public fields only
DROP POLICY IF EXISTS "Users can view all profiles" ON public.profiles;

CREATE POLICY "Users can view own full profile"
ON public.profiles FOR SELECT TO authenticated
USING (auth.uid() = id);

CREATE POLICY "Users can view others' public profile fields"
ON public.profiles FOR SELECT TO authenticated
USING (auth.uid() <> id);
-- Note: column-level restriction not enforced by RLS; recommend a public_profiles view in app code.
-- To fully prevent email enumeration, app code should query a view excluding email for other users.

-- 2. Messages: scope SELECT to event participants or group members
DROP POLICY IF EXISTS "Users can view messages for their events/groups" ON public.messages;

CREATE POLICY "Users can view messages in their events or groups"
ON public.messages FOR SELECT TO authenticated
USING (
  sender_id = auth.uid()
  OR (event_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.event_participants ep
    WHERE ep.event_id = messages.event_id AND ep.user_id = auth.uid()
  ))
  OR (group_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = messages.group_id AND gm.user_id = auth.uid()
  ))
);

-- 3. Reports: reporter can read their own
CREATE POLICY "Reporters can view their own reports"
ON public.reports FOR SELECT TO authenticated
USING (auth.uid() = reporter_id);

-- 4. Avatars storage: allow owner delete + update
CREATE POLICY "Users can delete own avatar"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'avatars' AND (auth.uid())::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can update own avatar"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'avatars' AND (auth.uid())::text = (storage.foldername(name))[1]);

-- 5. Lock down SECURITY DEFINER functions — revoke from public/anon
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;


-- >>> 20260505193910_b982ac79-3405-4150-bc9f-28be011089a3.sql <<<
-- Remove SELECT-others policy that exposed email column, replace with safe view
DROP POLICY IF EXISTS "Users can view others' public profile fields" ON public.profiles;

-- Public view excludes email and other sensitive fields
CREATE OR REPLACE VIEW public.public_profiles
WITH (security_invoker = true) AS
SELECT
  id,
  name,
  avatar_url,
  major,
  semester,
  residence_type,
  interests,
  languages,
  campus_id,
  points,
  reputation,
  created_at
FROM public.profiles;

GRANT SELECT ON public.public_profiles TO authenticated;

-- Allow authenticated users to read rows of OTHER users via the view
CREATE POLICY "Authenticated can view non-sensitive profile fields via view"
ON public.profiles
FOR SELECT
TO authenticated
USING (auth.uid() <> id);

-- Note: client must select only safe columns. The view enforces this contractually.
-- Column-level lockdown of `email` is achieved by switching client queries to public_profiles.

-- >>> 20260518070740_29093684-8658-4d88-9810-236752b340ea.sql <<<

-- =========================
-- Profiles: drop overly broad read
-- =========================
DROP POLICY IF EXISTS "Authenticated can view non-sensitive profile fields via view" ON public.profiles;

-- =========================
-- Friendships: only addressee can update status
-- =========================
DROP POLICY IF EXISTS "Users can update own friendships" ON public.friendships;

CREATE POLICY "Addressee can update friendship"
ON public.friendships
FOR UPDATE
TO authenticated
USING (auth.uid() = addressee_id)
WITH CHECK (auth.uid() = addressee_id);

-- =========================
-- Security definer helpers (avoid recursive RLS)
-- =========================
CREATE OR REPLACE FUNCTION public.is_event_participant(_event_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.event_participants
    WHERE event_id = _event_id AND user_id = _user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.is_event_creator(_event_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.events
    WHERE id = _event_id AND creator_id = _user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.is_group_member(_group_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _group_id AND user_id = _user_id
  );
$$;

-- =========================
-- Event participants: restrict SELECT
-- =========================
DROP POLICY IF EXISTS "Users can view event participants" ON public.event_participants;

CREATE POLICY "Participants and creators can view event participants"
ON public.event_participants
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid()
  OR public.is_event_creator(event_id, auth.uid())
  OR public.is_event_participant(event_id, auth.uid())
);

-- =========================
-- Group members: restrict SELECT to fellow members
-- =========================
DROP POLICY IF EXISTS "Members can view group members" ON public.group_members;

CREATE POLICY "Members can view fellow group members"
ON public.group_members
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid()
  OR public.is_group_member(group_id, auth.uid())
);

-- =========================
-- Groups: restrict SELECT to members/creators
-- =========================
DROP POLICY IF EXISTS "Group members can view groups" ON public.groups;

CREATE POLICY "Members and creators can view groups"
ON public.groups
FOR SELECT
TO authenticated
USING (
  created_by = auth.uid()
  OR public.is_group_member(id, auth.uid())
);

-- =========================
-- Storage: avatars — remove duplicate public-role policies, no listing
-- =========================
DROP POLICY IF EXISTS "Users can update their own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload their own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Avatar images are publicly accessible" ON storage.objects;

-- Authenticated upload to own folder
CREATE POLICY "Authenticated can upload own avatar"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'avatars'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Public read of individual objects (no listing — list requires broader access)
CREATE POLICY "Public can read avatar objects"
ON storage.objects
FOR SELECT
TO anon, authenticated
USING (bucket_id = 'avatars');
-- =========================
-- [bloque realtime.messages omitido en el consolidado — aplicar aparte si se requiere]


-- >>> 20260518070800_04b55336-8271-468a-aad9-e3fdb320f4e9.sql <<<

REVOKE EXECUTE ON FUNCTION public.is_event_participant(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_event_creator(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_group_member(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_event_participant(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_event_creator(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_group_member(uuid, uuid) TO authenticated;

-- >>> 20260519005344_8a7032f0-d3c0-4b3a-b755-d2f23f909e64.sql <<<

REVOKE ALL ON FUNCTION public.is_event_participant(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_event_creator(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_group_member(uuid, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.is_event_participant(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_event_creator(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_group_member(uuid, uuid) TO authenticated;

-- >>> 20260519045254_82d0885d-faab-4db0-9e3c-904c01d32fad.sql <<<
CREATE OR REPLACE FUNCTION public.recalc_event_spots()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_id uuid;
  v_count integer;
  v_max integer;
BEGIN
  v_event_id := COALESCE(NEW.event_id, OLD.event_id);

  SELECT COUNT(*) INTO v_count
  FROM public.event_participants
  WHERE event_id = v_event_id AND status = 'joined';

  SELECT max_spots INTO v_max
  FROM public.events
  WHERE id = v_event_id;

  IF TG_OP = 'INSERT' AND v_count > v_max THEN
    RAISE EXCEPTION 'EVENT_FULL' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.events
  SET current_spots = v_count
  WHERE id = v_event_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_recalc_spots_insert ON public.event_participants;
DROP TRIGGER IF EXISTS trg_recalc_spots_delete ON public.event_participants;

CREATE TRIGGER trg_recalc_spots_insert
AFTER INSERT ON public.event_participants
FOR EACH ROW EXECUTE FUNCTION public.recalc_event_spots();

CREATE TRIGGER trg_recalc_spots_delete
AFTER DELETE ON public.event_participants
FOR EACH ROW EXECUTE FUNCTION public.recalc_event_spots();

REVOKE EXECUTE ON FUNCTION public.recalc_event_spots() FROM PUBLIC, anon, authenticated;

-- >>> 20260604120000_fix-three-security-bugs.sql <<<

-- ============================================================
-- FIX 1: public_profiles view — switch to security_invoker=false
--
-- With security_invoker=true the view runs as the calling user.
-- The only SELECT policy on profiles is USING(auth.uid()=id), so
-- every query via the view returns only the caller's own row.
--
-- With security_invoker=false (SECURITY DEFINER semantics) the
-- view runs as its owner (postgres, who has BYPASSRLS).  RLS on
-- the underlying profiles table is therefore checked against the
-- view owner — and bypassed — so all rows are visible.
-- Email is not in the column list, so it is never exposed.
-- ============================================================
CREATE OR REPLACE VIEW public.public_profiles
WITH (security_invoker = false) AS
SELECT
  id,
  name,
  avatar_url,
  major,
  semester,
  residence_type,
  interests,
  languages,
  campus_id,
  points,
  reputation,
  created_at
FROM public.profiles;

GRANT SELECT ON public.public_profiles TO authenticated;

-- ============================================================
-- FIX 2a: Block direct tampering with points / reputation.
--
-- The trigger is NOT SECURITY DEFINER so it executes as the
-- calling user.  When current_user='authenticated' (a regular
-- client) any change to points/reputation is rejected.
-- Server-side SECURITY DEFINER functions run as postgres —
-- current_user='postgres' — so they may still update scores.
-- ============================================================
CREATE OR REPLACE FUNCTION public.prevent_score_tampering()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.points IS DISTINCT FROM OLD.points OR NEW.reputation IS DISTINCT FROM OLD.reputation)
     AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'permission denied: score fields are read-only for regular users'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_score_tampering() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_prevent_score_tampering ON public.profiles;
CREATE TRIGGER trg_prevent_score_tampering
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_score_tampering();

-- ============================================================
-- FIX 2b: Block self-awarded badges.
--
-- The original policy allowed any authenticated user to INSERT
-- a badge for themselves.  Dropping it means no INSERT policy
-- exists for the authenticated role, so RLS blocks all client
-- inserts.  Service role / postgres (BYPASSRLS) are unaffected.
-- ============================================================
DROP POLICY IF EXISTS "System can insert badges" ON public.badges;

-- ============================================================
-- FIX 2c: Block self check-in on event_participants.
--
-- The trigger rejects flipping checked_in false→true when the
-- caller is authenticated but is NOT the event creator.
-- The event creator and SECURITY DEFINER server functions may
-- still perform check-ins.
-- ============================================================
CREATE OR REPLACE FUNCTION public.prevent_self_checkin()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.checked_in = true AND OLD.checked_in = false AND current_user = 'authenticated' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.events
      WHERE id = NEW.event_id AND creator_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'permission denied: only the event creator can check in participants'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_self_checkin() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_prevent_self_checkin ON public.event_participants;
CREATE TRIGGER trg_prevent_self_checkin
  BEFORE UPDATE ON public.event_participants
  FOR EACH ROW EXECUTE FUNCTION public.prevent_self_checkin();

-- ============================================================
-- FIX 3a: are_friends(a, b) — SECURITY DEFINER helper.
--
-- Returns true when an accepted friendship exists in either
-- direction between a and b.  SECURITY DEFINER so it can bypass
-- the friendships SELECT policy when called from the events RLS
-- expression.  Locked down to authenticated only.
-- ============================================================
CREATE OR REPLACE FUNCTION public.are_friends(a uuid, b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.friendships
    WHERE status = 'accepted'
      AND (
        (requester_id = a AND addressee_id = b)
        OR (requester_id = b AND addressee_id = a)
      )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.are_friends(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.are_friends(uuid, uuid) TO authenticated;

-- ============================================================
-- FIX 3b: Update events SELECT policy to honour 'friends' privacy.
--
-- Previous policy: open OR own event only.
-- New policy also allows: friends-only event visible to accepted
-- friends of the creator.  'private' remains creator-only.
-- ============================================================
DROP POLICY IF EXISTS "Anyone can view open active events" ON public.events;

CREATE POLICY "Events visibility policy"
  ON public.events FOR SELECT TO authenticated
  USING (
    privacy = 'open'
    OR creator_id = auth.uid()
    OR (privacy = 'friends' AND public.are_friends(creator_id, auth.uid()))
  );

-- >>> 20260604130000_checkin-and-points.sql <<<

-- ============================================================
-- GOAL A: append-only point_events ledger
--
-- Non-farmable: UNIQUE (user_id, event_id, reason) means a
-- given award can only land once.  No client write policies →
-- the authenticated role can never INSERT/UPDATE/DELETE directly.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.point_events (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    event_id   uuid        REFERENCES public.events(id) ON DELETE SET NULL,
    reason     text        NOT NULL CHECK (reason IN ('join', 'organize', 'check_in', 'rate')),
    points     int         NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, event_id, reason)
);

ALTER TABLE public.point_events ENABLE ROW LEVEL SECURITY;

-- Users may only read their own rows; no INSERT/UPDATE/DELETE policy → client can never write
CREATE POLICY "Users can read own point ledger"
    ON public.point_events FOR SELECT TO authenticated
    USING (auth.uid() = user_id);

-- ============================================================
-- GOAL A: award_points
--
-- SECURITY DEFINER (runs as postgres/BYPASSRLS) so it can:
--   1. Write to point_events (no client INSERT policy).
--   2. UPDATE profiles.points without triggering the
--      prevent_score_tampering guard (current_user = 'postgres').
-- EXECUTE revoked from all client roles; only reachable via
-- trigger functions and check_in_to_event, both also SECURITY DEFINER.
-- ============================================================

CREATE OR REPLACE FUNCTION public.award_points(
    _user_id  uuid,
    _event_id uuid,
    _reason   text,
    _points   int
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_inserted int;
BEGIN
    INSERT INTO public.point_events (user_id, event_id, reason, points)
    VALUES (_user_id, _event_id, _reason, _points)
    ON CONFLICT (user_id, event_id, reason) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    -- Only credit the profile when the ledger row is genuinely new
    IF v_inserted > 0 THEN
        UPDATE public.profiles
        SET points = points + _points
        WHERE id = _user_id;
    END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.award_points(uuid, uuid, text, int) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- GOAL A: join award trigger (10 pts)
--
-- SECURITY DEFINER so it can call award_points (EXECUTE is
-- revoked from authenticated).  current_user = 'postgres'
-- inside this function, which also lets award_points update
-- profiles without hitting prevent_score_tampering.
-- ============================================================

CREATE OR REPLACE FUNCTION public.on_participant_join_award()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.status = 'joined' THEN
        PERFORM public.award_points(NEW.user_id, NEW.event_id, 'join', 10);
    END IF;
    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.on_participant_join_award() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_on_participant_join_award ON public.event_participants;
CREATE TRIGGER trg_on_participant_join_award
    AFTER INSERT ON public.event_participants
    FOR EACH ROW EXECUTE FUNCTION public.on_participant_join_award();

-- ============================================================
-- GOAL A: organize award trigger (25 pts)
-- ============================================================

CREATE OR REPLACE FUNCTION public.on_event_create_award()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM public.award_points(NEW.creator_id, NEW.id, 'organize', 25);
    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.on_event_create_award() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_on_event_create_award ON public.events;
CREATE TRIGGER trg_on_event_create_award
    AFTER INSERT ON public.events
    FOR EACH ROW EXECUTE FUNCTION public.on_event_create_award();

-- ============================================================
-- GOAL B: check_in_to_event RPC
--
-- GPS coordinates are client-reported; this raises the bar
-- against casual fraud but cannot be considered a hard
-- guarantee against GPS spoofing.
--
-- SECURITY DEFINER means current_user = 'postgres' during
-- execution.  The trg_prevent_self_checkin trigger only blocks
-- when current_user = 'authenticated', so it does NOT fire
-- here — no change to that trigger is needed.
-- ============================================================

CREATE OR REPLACE FUNCTION public.check_in_to_event(
    _event_id uuid,
    _lat      double precision,
    _lng      double precision
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid             uuid := auth.uid();
    v_event           RECORD;
    v_dist_m          double precision := 0;
    v_already_checked boolean;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
    END IF;

    SELECT id, lat, lng, starts_at, ends_at
    INTO   v_event
    FROM   public.events
    WHERE  id = _event_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'EVENT_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;

    -- Entry allowed 15 min before start; rejected after event ends
    IF now() < v_event.starts_at - interval '15 minutes'
    OR now() > v_event.ends_at THEN
        RAISE EXCEPTION 'OUTSIDE_EVENT_WINDOW' USING ERRCODE = 'P0001';
    END IF;

    SELECT checked_in
    INTO   v_already_checked
    FROM   public.event_participants
    WHERE  event_id = _event_id
      AND  user_id  = v_uid
      AND  status   = 'joined';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'NOT_A_PARTICIPANT' USING ERRCODE = 'P0001';
    END IF;

    -- Haversine distance using plain trig (no PostGIS on search_path required)
    -- Skip the distance check if the event has no pinned coordinates
    IF v_event.lat IS NOT NULL AND v_event.lng IS NOT NULL THEN
        v_dist_m := 2.0 * 6371000.0 * asin(
            sqrt(
                power(sin(radians(v_event.lat - _lat) / 2.0), 2) +
                cos(radians(_lat)) * cos(radians(v_event.lat)) *
                power(sin(radians(v_event.lng - _lng) / 2.0), 2)
            )
        );

        IF v_dist_m > 150.0 THEN
            RAISE EXCEPTION 'TOO_FAR_FROM_EVENT' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    -- Idempotently mark the participant as checked in.
    -- trg_prevent_self_checkin does NOT block this UPDATE because
    -- current_user = 'postgres' inside a SECURITY DEFINER function,
    -- so the trigger's guard (current_user = 'authenticated') is false.
    UPDATE public.event_participants
    SET    checked_in = true
    WHERE  event_id = _event_id
      AND  user_id  = v_uid;

    -- Award points only on the first successful check-in
    IF NOT v_already_checked THEN
        PERFORM public.award_points(v_uid, _event_id, 'check_in', 15);
    END IF;

    RETURN jsonb_build_object(
        'checked_in', true,
        'distance_m', round(v_dist_m::numeric, 1)
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_in_to_event(uuid, double precision, double precision) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.check_in_to_event(uuid, double precision, double precision) TO authenticated;

-- >>> 20260608000000_badge-awards.sql <<<

-- ============================================================
-- try_award_badge: idempotent single-badge insert.
-- Used by check_and_award_badges; never called by the client.
-- ============================================================
CREATE OR REPLACE FUNCTION public.try_award_badge(
    _user_id    uuid,
    _badge_type text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.badges (user_id, badge_type)
    VALUES (_user_id, _badge_type)
    ON CONFLICT (user_id, badge_type) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.try_award_badge(uuid, text) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- check_and_award_badges: evaluate every badge condition for
-- a single user and award any newly-met ones.
-- Idempotent: safe to call multiple times.
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_and_award_badges(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count int;
BEGIN
    -- organizer: created 5+ events
    SELECT COUNT(*) INTO v_count
    FROM public.events
    WHERE creator_id = _user_id;

    IF v_count >= 5 THEN
        PERFORM public.try_award_badge(_user_id, 'organizer');
    END IF;

    -- explorer: joined 10+ events
    SELECT COUNT(*) INTO v_count
    FROM public.event_participants
    WHERE user_id = _user_id AND status = 'joined';

    IF v_count >= 10 THEN
        PERFORM public.try_award_badge(_user_id, 'explorer');
    END IF;

    -- study_buddy: checked in to 5+ study sessions
    SELECT COUNT(*) INTO v_count
    FROM public.event_participants ep
    JOIN public.events e ON ep.event_id = e.id
    WHERE ep.user_id = _user_id
      AND ep.checked_in = true
      AND e.category = 'study';

    IF v_count >= 5 THEN
        PERFORM public.try_award_badge(_user_id, 'study_buddy');
    END IF;

    -- team_player: joined 5+ sports events
    SELECT COUNT(*) INTO v_count
    FROM public.event_participants ep
    JOIN public.events e ON ep.event_id = e.id
    WHERE ep.user_id = _user_id
      AND ep.status = 'joined'
      AND e.category = 'sports';

    IF v_count >= 5 THEN
        PERFORM public.try_award_badge(_user_id, 'team_player');
    END IF;

    -- streak_7: active on 7+ distinct calendar days (any join)
    SELECT COUNT(DISTINCT date_trunc('day', ep.joined_at)) INTO v_count
    FROM public.event_participants ep
    WHERE ep.user_id = _user_id AND ep.status = 'joined';

    IF v_count >= 7 THEN
        PERFORM public.try_award_badge(_user_id, 'streak_7');
    END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_and_award_badges(uuid) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- Trigger on event_participants: fires after JOIN and after
-- a check-in (UPDATE OF checked_in).
-- ============================================================
CREATE OR REPLACE FUNCTION public.on_participant_badge_check()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM public.check_and_award_badges(NEW.user_id);
    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.on_participant_badge_check() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_badge_check_on_participant ON public.event_participants;
CREATE TRIGGER trg_badge_check_on_participant
    AFTER INSERT OR UPDATE OF checked_in ON public.event_participants
    FOR EACH ROW EXECUTE FUNCTION public.on_participant_badge_check();

-- ============================================================
-- Trigger on events: fires after a new event is created.
-- ============================================================
CREATE OR REPLACE FUNCTION public.on_event_badge_check()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM public.check_and_award_badges(NEW.creator_id);
    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.on_event_badge_check() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_badge_check_on_event ON public.events;
CREATE TRIGGER trg_badge_check_on_event
    AFTER INSERT ON public.events
    FOR EACH ROW EXECUTE FUNCTION public.on_event_badge_check();

-- >>> 20260608010000_reputation.sql <<<

-- ============================================================
-- award_reputation: adds reputation to a user, capped at 1000.
-- SECURITY DEFINER so it bypasses the prevent_score_tampering
-- trigger (current_user = 'postgres', not 'authenticated').
-- ============================================================
CREATE OR REPLACE FUNCTION public.award_reputation(
    _user_id uuid,
    _amount  float
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.profiles
    SET reputation = LEAST(reputation + _amount, 1000)
    WHERE id = _user_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.award_reputation(uuid, float) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- Trigger: award +2 reputation to the event CREATOR each time
-- a new participant joins (status = 'joined').
-- Does not award rep when the creator joins their own event.
-- ============================================================
CREATE OR REPLACE FUNCTION public.on_participant_creator_rep()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_creator_id uuid;
BEGIN
    IF NEW.status = 'joined' THEN
        SELECT creator_id INTO v_creator_id
        FROM public.events
        WHERE id = NEW.event_id;

        IF FOUND AND v_creator_id IS NOT NULL AND v_creator_id <> NEW.user_id THEN
            PERFORM public.award_reputation(v_creator_id, 2);
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.on_participant_creator_rep() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_participant_creator_rep ON public.event_participants;
CREATE TRIGGER trg_participant_creator_rep
    AFTER INSERT ON public.event_participants
    FOR EACH ROW EXECUTE FUNCTION public.on_participant_creator_rep();

-- ============================================================
-- Update check_in_to_event: add +5 reputation on first check-in.
-- Full function re-declared with CREATE OR REPLACE.
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_in_to_event(
    _event_id uuid,
    _lat      double precision,
    _lng      double precision
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
-- GPS coordinates are client-reported; this raises the bar against casual fraud
-- but cannot be considered a hard guarantee against GPS spoofing.
DECLARE
    v_uid             uuid := auth.uid();
    v_event           RECORD;
    v_dist_m          double precision := 0;
    v_already_checked boolean;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
    END IF;

    SELECT id, lat, lng, starts_at, ends_at
    INTO   v_event
    FROM   public.events
    WHERE  id = _event_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'EVENT_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;

    IF now() < v_event.starts_at - interval '15 minutes'
    OR now() > v_event.ends_at THEN
        RAISE EXCEPTION 'OUTSIDE_EVENT_WINDOW' USING ERRCODE = 'P0001';
    END IF;

    SELECT checked_in
    INTO   v_already_checked
    FROM   public.event_participants
    WHERE  event_id = _event_id
      AND  user_id  = v_uid
      AND  status   = 'joined';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'NOT_A_PARTICIPANT' USING ERRCODE = 'P0001';
    END IF;

    IF v_event.lat IS NOT NULL AND v_event.lng IS NOT NULL THEN
        v_dist_m := 2.0 * 6371000.0 * asin(
            sqrt(
                power(sin(radians(v_event.lat - _lat) / 2.0), 2) +
                cos(radians(_lat)) * cos(radians(v_event.lat)) *
                power(sin(radians(v_event.lng - _lng) / 2.0), 2)
            )
        );
        IF v_dist_m > 150.0 THEN
            RAISE EXCEPTION 'TOO_FAR_FROM_EVENT' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    UPDATE public.event_participants
    SET    checked_in = true
    WHERE  event_id = _event_id
      AND  user_id  = v_uid;

    IF NOT v_already_checked THEN
        PERFORM public.award_points(v_uid, _event_id, 'check_in', 15);
        PERFORM public.award_reputation(v_uid, 5);
    END IF;

    RETURN jsonb_build_object(
        'checked_in', true,
        'distance_m', round(v_dist_m::numeric, 1)
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_in_to_event(uuid, double precision, double precision) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.check_in_to_event(uuid, double precision, double precision) TO authenticated;

-- >>> 20260608020000_fix-messages-insert-policy.sql <<<
DROP POLICY IF EXISTS "Users can send messages" ON public.messages;

CREATE POLICY "Members can send messages"
ON public.messages FOR INSERT TO authenticated
WITH CHECK (
  sender_id = auth.uid()
  AND (
    (event_id IS NOT NULL AND public.is_event_participant(event_id, auth.uid()))
    OR (group_id IS NOT NULL AND public.is_group_member(group_id, auth.uid()))
  )
);

-- >>> 20260608040000_event-ratings.sql <<<
-- ============================================================
-- Add rating column to event_participants (1-5 stars, nullable)
-- ============================================================
ALTER TABLE public.event_participants
  ADD COLUMN IF NOT EXISTS rating smallint CHECK (rating BETWEEN 1 AND 5);

-- Drop old 2-parameter version if it exists (created before this migration was corrected)
DROP FUNCTION IF EXISTS public.rate_event(uuid, smallint);

-- ============================================================
-- rate_event: lets a participant rate an event (1-5).
-- p_user_id is accepted from the client but validated against
-- auth.uid() so callers cannot rate on behalf of another user.
-- Awards +5 points on the FIRST rating (idempotent via the
-- unique constraint in point_events).
-- ============================================================
CREATE OR REPLACE FUNCTION public.rate_event(
    p_event_id uuid,
    p_user_id  uuid,
    p_rating   smallint
)
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

    -- Prevent rating on behalf of another user
    IF v_uid <> p_user_id THEN
        RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
    END IF;

    IF p_rating < 1 OR p_rating > 5 THEN
        RAISE EXCEPTION 'INVALID_RATING' USING ERRCODE = 'P0001';
    END IF;

    -- Caller must be a joined participant (not the creator)
    IF NOT EXISTS (
        SELECT 1 FROM public.event_participants
        WHERE event_id = p_event_id
          AND user_id  = v_uid
          AND status   = 'joined'
    ) THEN
        RAISE EXCEPTION 'NOT_A_PARTICIPANT' USING ERRCODE = 'P0001';
    END IF;

    -- Event must have ended
    IF NOT EXISTS (
        SELECT 1 FROM public.events
        WHERE id = p_event_id AND ends_at < now()
    ) THEN
        RAISE EXCEPTION 'EVENT_NOT_ENDED' USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.event_participants
    SET rating = p_rating
    WHERE event_id = p_event_id
      AND user_id  = v_uid;

    -- Award points idempotently (unique constraint on point_events prevents double-award)
    PERFORM public.award_points(v_uid, p_event_id, 'rate', 5);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rate_event(uuid, uuid, smallint) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rate_event(uuid, uuid, smallint) TO authenticated;

-- >>> 20260817000000_group-membership-rpcs.sql <<<
-- ============================================================
-- Membresía de grupos vía RPC (arregla DMs, invitaciones y el
-- hueco de auto-unirse a grupos ajenos).
--
-- Problema que resuelve:
--   La política "Users can join groups" solo permitía
--   WITH CHECK (auth.uid() = user_id). El cliente intentaba
--   insertar a OTRA persona (al crear un DM y al invitar a un
--   grupo), la fila ajena violaba el WITH CHECK y la sentencia
--   entera fallaba: no se insertaba nadie. Los DMs quedaban sin
--   miembros y ningún mensaje se podía enviar.
--   Además esa misma política dejaba que cualquiera se metiera
--   en cualquier grupo con solo conocer su UUID.
--
-- Solución: la membresía deja de ser escribible desde el cliente.
--   - El creador entra automáticamente por trigger.
--   - Los DMs se crean con create_dm() (atómico, exige amistad).
--   - Las invitaciones pasan por add_group_member() (exige que
--     quien invita ya sea miembro y que el invitado sea su amigo).
--   Salir del grupo sigue siendo un DELETE directo del propio row.
-- ============================================================


-- ============================================================
-- 1. El creador de un grupo entra siempre como miembro.
--
-- Antes lo hacía el cliente con un INSERT aparte, que se queda
-- sin política. Con el trigger no hay ventana en la que un grupo
-- exista sin su creador dentro.
-- ============================================================
CREATE OR REPLACE FUNCTION public.on_group_created_add_creator()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.group_members (group_id, user_id)
  VALUES (NEW.id, NEW.created_by)
  ON CONFLICT (group_id, user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.on_group_created_add_creator() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_group_created_add_creator ON public.groups;
CREATE TRIGGER trg_group_created_add_creator
  AFTER INSERT ON public.groups
  FOR EACH ROW EXECUTE FUNCTION public.on_group_created_add_creator();


-- ============================================================
-- 2. create_dm(_other_user_id) → uuid del grupo DM
--
-- Idempotente: si el DM ya existe devuelve el mismo grupo, mire
-- quien lo mire. El nombre es determinista (__dm_<uuid menor>_<uuid mayor>)
-- para que ambas partes lleguen al mismo registro; la búsqueda va
-- por dentro de la función (SECURITY DEFINER), así que funciona
-- aunque quien llama todavía no sea miembro y no pueda verlo por RLS.
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_dm(_other_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_name     text;
  v_group_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  IF _other_user_id IS NULL OR _other_user_id = v_uid THEN
    RAISE EXCEPTION 'INVALID_TARGET' USING ERRCODE = 'P0001';
  END IF;

  IF NOT public.are_friends(v_uid, _other_user_id) THEN
    RAISE EXCEPTION 'NOT_FRIENDS' USING ERRCODE = '42501';
  END IF;

  v_name := '__dm_' || least(v_uid, _other_user_id)::text
                    || '_' || greatest(v_uid, _other_user_id)::text;

  -- ORDER BY created_at: el bug anterior pudo dejar más de un grupo con
  -- el mismo nombre __dm_ (cada parte creó el suyo, sin miembros). Quedarse
  -- siempre con el más antiguo hace que ambas partes converjan en uno solo;
  -- el INSERT de abajo lo repara metiendo a los dos.
  SELECT id INTO v_group_id
  FROM   public.groups
  WHERE  name = v_name
  ORDER  BY created_at
  LIMIT  1;

  IF v_group_id IS NULL THEN
    INSERT INTO public.groups (name, created_by)
    VALUES (v_name, v_uid)
    RETURNING id INTO v_group_id;
    -- el trigger ya metió a v_uid; falta la otra parte
  END IF;

  INSERT INTO public.group_members (group_id, user_id)
  VALUES (v_group_id, v_uid), (v_group_id, _other_user_id)
  ON CONFLICT (group_id, user_id) DO NOTHING;

  RETURN v_group_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_dm(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_dm(uuid) TO authenticated;


-- ============================================================
-- 3. add_group_member(_group_id, _user_id)
--
-- Quien invita tiene que ser ya miembro del grupo, y solo puede
-- invitar a sus amigos aceptados. Los grupos DM no admiten gente
-- nueva: son de dos y su nombre determinista dejaría de cuadrar.
-- ============================================================
CREATE OR REPLACE FUNCTION public.add_group_member(_group_id uuid, _user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_name text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT name INTO v_name FROM public.groups WHERE id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_name LIKE '\_\_dm\_%' THEN
    RAISE EXCEPTION 'CANNOT_INVITE_TO_DM' USING ERRCODE = 'P0001';
  END IF;

  IF NOT public.is_group_member(_group_id, v_uid) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER' USING ERRCODE = '42501';
  END IF;

  IF NOT public.are_friends(v_uid, _user_id) THEN
    RAISE EXCEPTION 'NOT_FRIENDS' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.group_members (group_id, user_id)
  VALUES (_group_id, _user_id)
  ON CONFLICT (group_id, user_id) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.add_group_member(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.add_group_member(uuid, uuid) TO authenticated;


-- ============================================================
-- 4. Cerrar el INSERT directo sobre group_members.
--
-- Sin política de INSERT para authenticated, la RLS bloquea toda
-- escritura del cliente: la membresía solo se crea por el trigger
-- y por las dos RPC de arriba (que corren como postgres/BYPASSRLS).
-- Esto cierra el hueco de meterse en cualquier grupo conociendo
-- su UUID. El DELETE ("Users can leave groups") se queda: salirse
-- sigue siendo cosa de cada quien.
-- ============================================================
DROP POLICY IF EXISTS "Users can join groups" ON public.group_members;


-- ============================================================
-- 5. El creador puede ver la lista de miembros aunque se haya
--    salido del grupo (la política de SELECT de groups ya le
--    dejaba ver el grupo; esto alinea las dos).
-- ============================================================
DROP POLICY IF EXISTS "Members can view fellow group members" ON public.group_members;

CREATE POLICY "Members and creators can view group members"
ON public.group_members
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid()
  OR public.is_group_member(group_id, auth.uid())
  OR EXISTS (
    SELECT 1 FROM public.groups g
    WHERE g.id = group_members.group_id AND g.created_by = auth.uid()
  )
);


-- ============================================================
-- OPCIONAL (no se ejecuta): limpieza de los grupos DM huérfanos
-- que dejó el bug — creados sin miembros y sin un solo mensaje.
-- Revísalos antes de borrar nada.
--
--   SELECT g.id, g.name, g.created_at
--   FROM   public.groups g
--   WHERE  g.name LIKE '\_\_dm\_%'
--     AND  NOT EXISTS (SELECT 1 FROM public.group_members m WHERE m.group_id = g.id)
--     AND  NOT EXISTS (SELECT 1 FROM public.messages     x WHERE x.group_id = g.id);
--
-- create_dm() no los necesita: si quedan, simplemente reutiliza el
-- más antiguo y le añade a las dos personas.
-- ============================================================


-- >>> 20260817010000_moderation-and-account-deletion.sql <<<
-- ============================================================
-- Moderación de contenido de usuario + soporte para borrar cuenta.
--
-- Cubre los requisitos de Apple para apps con UGC (guideline 1.2):
-- reportar contenido, bloquear personas abusivas, y que el
-- contenido bloqueado desaparezca de verdad.
--
-- El borrado de cuenta (guideline 5.1.1 v) se ejecuta desde la
-- Edge Function `delete-account`, que llama a auth.admin.deleteUser().
-- Aquí solo se prepara lo que el CASCADE no cubre.
-- ============================================================


-- ============================================================
-- 1. blocks — bloqueo unidireccional, efecto bidireccional.
--
-- Si A bloquea a B, ninguno de los dos ve al otro. Se guarda una
-- sola fila (quién bloqueó a quién) para poder desbloquear, pero
-- todas las consultas usan is_blocked(), que mira en los dos
-- sentidos: así B no puede deducir que A le bloqueó viendo que
-- él sí sigue apareciendo.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.blocks (
  blocker_id   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Nombre en el momento del bloqueo. Denormalizado a propósito: en cuanto
  -- alguien queda bloqueado desaparece de public_profiles, así que sin esta
  -- copia la pantalla de "bloqueados" solo podría mostrar UUIDs y el bloqueo
  -- sería imposible de deshacer con criterio.
  blocked_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT blocks_no_self CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS blocks_blocked_id_idx ON public.blocks (blocked_id);

ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;

-- Cada quien gestiona su propia lista. Nadie puede leer quién le
-- bloqueó a él: solo las filas donde es el bloqueador.
CREATE POLICY "Users can read own blocks"
  ON public.blocks FOR SELECT TO authenticated
  USING (auth.uid() = blocker_id);

CREATE POLICY "Users can block"
  ON public.blocks FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = blocker_id);

CREATE POLICY "Users can unblock"
  ON public.blocks FOR DELETE TO authenticated
  USING (auth.uid() = blocker_id);


-- ============================================================
-- 2. is_blocked(a, b) — SECURITY DEFINER, mira en ambos sentidos.
--
-- Se usa dentro de políticas RLS y de la vista public_profiles,
-- donde el rol que consulta no puede leer la tabla blocks entera.
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_blocked(a uuid, b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.blocks
    WHERE (blocker_id = a AND blocked_id = b)
       OR (blocker_id = b AND blocked_id = a)
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_blocked(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_blocked(uuid, uuid) TO authenticated;


-- ============================================================
-- 3. Bloquear implica romper la relación existente.
--
-- Al bloquear se borra la amistad (en cualquier estado, incluida
-- una solicitud pendiente) y se saca a las dos personas de sus
-- DMs comunes. Sin esto, el bloqueado seguiría en la lista de
-- amigos del otro y el DM quedaría medio visible.
-- ============================================================
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

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.on_block_cleanup() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_block_cleanup ON public.blocks;
CREATE TRIGGER trg_block_cleanup
  AFTER INSERT ON public.blocks
  FOR EACH ROW EXECUTE FUNCTION public.on_block_cleanup();


-- ============================================================
-- 4. No se pueden mandar solicitudes de amistad a quien te bloqueó.
-- ============================================================
DROP POLICY IF EXISTS "Users can send friend requests" ON public.friendships;

CREATE POLICY "Users can send friend requests"
  ON public.friendships FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = requester_id
    AND NOT public.is_blocked(requester_id, addressee_id)
  );


-- ============================================================
-- 5. La gente bloqueada desaparece de public_profiles.
--
-- La vista corre con security_invoker = false (como su dueño) para
-- poder saltarse la RLS de profiles, pero auth.uid() sigue siendo
-- el de quien consulta, así que el filtro funciona por usuario.
-- ============================================================
CREATE OR REPLACE VIEW public.public_profiles
WITH (security_invoker = false) AS
SELECT
  id,
  name,
  avatar_url,
  major,
  semester,
  residence_type,
  interests,
  languages,
  campus_id,
  points,
  reputation,
  created_at
FROM public.profiles p
WHERE auth.uid() IS NOT NULL
  AND NOT public.is_blocked(auth.uid(), p.id);

GRANT SELECT ON public.public_profiles TO authenticated;


-- ============================================================
-- 6. Los mensajes de gente bloqueada no se leen.
-- ============================================================
DROP POLICY IF EXISTS "Users can view messages in their events or groups" ON public.messages;

CREATE POLICY "Users can view messages in their events or groups"
ON public.messages FOR SELECT TO authenticated
USING (
  NOT public.is_blocked(auth.uid(), sender_id)
  AND (
    sender_id = auth.uid()
    OR (event_id IS NOT NULL AND public.is_event_participant(event_id, auth.uid()))
    OR (group_id IS NOT NULL AND public.is_group_member(group_id, auth.uid()))
  )
);


-- ============================================================
-- 7. Los eventos de gente bloqueada no se ven.
-- ============================================================
DROP POLICY IF EXISTS "Events visibility policy" ON public.events;

CREATE POLICY "Events visibility policy"
  ON public.events FOR SELECT TO authenticated
  USING (
    NOT public.is_blocked(auth.uid(), creator_id)
    AND (
      privacy = 'open'
      OR creator_id = auth.uid()
      OR (privacy = 'friends' AND public.are_friends(creator_id, auth.uid()))
    )
  );


-- ============================================================
-- 8. reports: poder reportar también mensajes, y dar seguimiento.
--
-- `status` existe para poder triar desde el dashboard de Supabase
-- (Apple pide actuar sobre lo reportado en menos de 24 h).
-- El CHECK obliga a que cada reporte apunte a exactamente una cosa.
-- ============================================================
ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS reported_message_id uuid REFERENCES public.messages(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS details text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';

ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_status_check;
ALTER TABLE public.reports
  ADD CONSTRAINT reports_status_check
  CHECK (status IN ('pending', 'reviewed', 'actioned', 'dismissed'));

ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_reason_check;
ALTER TABLE public.reports
  ADD CONSTRAINT reports_reason_check
  CHECK (reason IN ('spam', 'harassment', 'inappropriate', 'fake', 'safety', 'other'));

ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_one_target;
ALTER TABLE public.reports
  ADD CONSTRAINT reports_one_target CHECK (
    (reported_user_id    IS NOT NULL)::int
  + (reported_event_id   IS NOT NULL)::int
  + (reported_message_id IS NOT NULL)::int = 1
  );

ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_details_len;
ALTER TABLE public.reports
  ADD CONSTRAINT reports_details_len CHECK (details IS NULL OR length(details) <= 1000);

-- Un mismo usuario no reporta dos veces lo mismo (y de paso evita
-- que se pueda inundar la cola desde una sola cuenta).
CREATE UNIQUE INDEX IF NOT EXISTS reports_unique_user_target
  ON public.reports (reporter_id, reported_user_id)    WHERE reported_user_id    IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reports_unique_event_target
  ON public.reports (reporter_id, reported_event_id)   WHERE reported_event_id   IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reports_unique_message_target
  ON public.reports (reporter_id, reported_message_id) WHERE reported_message_id IS NOT NULL;

-- No se puede reportar contenido propio.
DROP POLICY IF EXISTS "Users can create reports" ON public.reports;

CREATE POLICY "Users can create reports"
  ON public.reports FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = reporter_id
    AND (reported_user_id IS NULL OR reported_user_id <> auth.uid())
  );


-- ============================================================
-- 9. Borrar el propio mensaje.
--
-- Hace falta para moderación: quien escribe algo puede retirarlo,
-- y el borrado desde el dashboard sigue estando disponible para ti.
-- ============================================================
CREATE POLICY "Senders can delete own messages"
  ON public.messages FOR DELETE TO authenticated
  USING (sender_id = auth.uid());


-- ============================================================
-- 10. Borrado de cuenta: lo que el CASCADE no cubre.
--
-- auth.admin.deleteUser() borra auth.users y de ahí caen en
-- cascada profiles, events, participaciones, amistades, grupos
-- creados, mensajes, insignias, puntos y bloqueos. Lo que NO cae
-- son los objetos de Storage, así que la Edge Function borra
-- también la carpeta del avatar.
--
-- Los reportes hechos POR el usuario que se va se conservan sin
-- autor (reporter_id pasa a NULL) para no perder la cola de
-- moderación cuando alguien reporta y luego borra su cuenta.
-- ============================================================
ALTER TABLE public.reports
  DROP CONSTRAINT IF EXISTS reports_reporter_id_fkey;

ALTER TABLE public.reports
  ALTER COLUMN reporter_id DROP NOT NULL;

ALTER TABLE public.reports
  ADD CONSTRAINT reports_reporter_id_fkey
  FOREIGN KEY (reporter_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- >>> 20260819000000_join-requests.sql <<<
-- ============================================================
-- Eventos privados con aprobación ("pedir unirme").
--
-- Reglas:
--   privacy = 'open'    → lo ve todo el mundo, entras directo.
--   privacy = 'friends' → solo lo ven los amigos del creador, entran directo.
--   privacy = 'private' → lo ve todo el mundo, pero unirse requiere que el
--                         creador apruebe. La solicitud queda como 'pending'.
--
-- El status NO lo decide el cliente: lo fija un trigger según la privacidad
-- del evento, y solo la RPC respond_to_join_request() puede cambiarlo.
-- ============================================================


-- ============================================================
-- 1. is_event_participant() ahora exige status = 'joined'.
--
-- CRÍTICO para que la aprobación signifique algo. Esta función gobierna
-- quién lee el chat del evento (política de messages) y quién ve la lista
-- de asistentes (política de event_participants). Sin el filtro, bastaba
-- con PEDIR unirse para entrar al chat y ver quién va, sin que nadie
-- aprobara nada.
--
-- Hasta ahora todas las filas eran 'joined', así que el filtro no cambia
-- nada del comportamiento existente.
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_event_participant(_event_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.event_participants
    WHERE event_id = _event_id
      AND user_id  = _user_id
      AND status   = 'joined'
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_event_participant(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_event_participant(uuid, uuid) TO authenticated;


-- ============================================================
-- 2. Los eventos privados se ven; lo que se restringe es entrar.
--
-- Antes 'private' significaba "solo lo ve el creador", así que nadie
-- podía siquiera encontrarlo para pedir unirse.
-- ============================================================
DROP POLICY IF EXISTS "Events visibility policy" ON public.events;

CREATE POLICY "Events visibility policy"
  ON public.events FOR SELECT TO authenticated
  USING (
    NOT public.is_blocked(auth.uid(), creator_id)
    AND (
      privacy IN ('open', 'private')
      OR creator_id = auth.uid()
      OR (privacy = 'friends' AND public.are_friends(creator_id, auth.uid()))
    )
  );


-- ============================================================
-- 3. El status de entrada lo fija el servidor, no el cliente.
--
-- Sin esto, cualquiera podría insertar status='joined' directamente en un
-- evento privado y saltarse la aprobación por completo.
-- ============================================================
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

  -- Las escrituras del servidor (RPC SECURITY DEFINER, service_role) pasan
  -- tal cual; solo se normaliza lo que llega del cliente.
  IF current_user = 'authenticated' THEN
    IF v_privacy = 'private' AND NEW.user_id <> v_creator_id THEN
      NEW.status := 'pending';
    ELSE
      NEW.status := 'joined';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_participant_initial_status() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_set_participant_initial_status ON public.event_participants;
CREATE TRIGGER trg_set_participant_initial_status
  BEFORE INSERT ON public.event_participants
  FOR EACH ROW EXECUTE FUNCTION public.set_participant_initial_status();


-- ============================================================
-- 4. Nadie se auto-aprueba.
--
-- La política de UPDATE deja a cada quien modificar su propia fila, lo que
-- incluiría cambiar 'pending' → 'joined'. Este trigger lo impide: el status
-- solo lo mueve respond_to_join_request(), que corre como postgres.
-- ============================================================
CREATE OR REPLACE FUNCTION public.prevent_status_tampering()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'permission denied: solo el organizador puede aprobar o rechazar'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_status_tampering() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_prevent_status_tampering ON public.event_participants;
CREATE TRIGGER trg_prevent_status_tampering
  BEFORE UPDATE ON public.event_participants
  FOR EACH ROW EXECUTE FUNCTION public.prevent_status_tampering();


-- ============================================================
-- 5. Aprobar suma plazas, puntos, reputación e insignias.
--
-- Los triggers existentes solo escuchaban INSERT, así que al aprobar una
-- solicitud (que es un UPDATE) no se recalculaban las plazas ni se daban
-- los puntos de la incorporación.
-- ============================================================
DROP TRIGGER IF EXISTS trg_recalc_spots_update ON public.event_participants;
CREATE TRIGGER trg_recalc_spots_update
  AFTER UPDATE OF status ON public.event_participants
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.recalc_event_spots();

-- award_points es idempotente (UNIQUE en point_events), así que puede
-- dispararse de más sin duplicar nada.
DROP TRIGGER IF EXISTS trg_on_participant_join_award_update ON public.event_participants;
CREATE TRIGGER trg_on_participant_join_award_update
  AFTER UPDATE OF status ON public.event_participants
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM 'joined' AND NEW.status = 'joined')
  EXECUTE FUNCTION public.on_participant_join_award();

-- award_reputation SUMA, no es idempotente: el WHEN acota el disparo a la
-- transición real hacia 'joined' para no regalar reputación repetida.
DROP TRIGGER IF EXISTS trg_participant_creator_rep_update ON public.event_participants;
CREATE TRIGGER trg_participant_creator_rep_update
  AFTER UPDATE OF status ON public.event_participants
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM 'joined' AND NEW.status = 'joined')
  EXECUTE FUNCTION public.on_participant_creator_rep();

DROP TRIGGER IF EXISTS trg_badge_check_on_participant_status ON public.event_participants;
CREATE TRIGGER trg_badge_check_on_participant_status
  AFTER UPDATE OF status ON public.event_participants
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM 'joined' AND NEW.status = 'joined')
  EXECUTE FUNCTION public.on_participant_badge_check();


-- ============================================================
-- 6. respond_to_join_request — el organizador aprueba o rechaza.
--
-- Rechazar borra la fila en vez de dejarla en 'declined': así la persona
-- puede volver a pedirlo más adelante (por ejemplo si el evento cambia de
-- hora) en lugar de quedar bloqueada para siempre por el UNIQUE.
-- ============================================================
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

  SELECT id, creator_id, max_spots INTO v_event
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
    RETURN;
  END IF;

  -- Bloquea la fila del evento para serializar las aprobaciones: sin esto,
  -- dos aprobaciones simultáneas podrían pasar del aforo.
  PERFORM 1 FROM public.events WHERE id = _event_id FOR UPDATE;

  SELECT COUNT(*) INTO v_count
  FROM public.event_participants
  WHERE event_id = _event_id AND status = 'joined';

  IF v_count >= v_event.max_spots THEN
    RAISE EXCEPTION 'EVENT_FULL' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.event_participants
  SET    status = 'joined'
  WHERE  event_id = _event_id AND user_id = _user_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.respond_to_join_request(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.respond_to_join_request(uuid, uuid, boolean) TO authenticated;


-- Búsqueda de solicitudes pendientes por evento.
CREATE INDEX IF NOT EXISTS event_participants_pending_idx
  ON public.event_participants (event_id)
  WHERE status = 'pending';


-- ============================================================
-- OJO — cambio de significado en los eventos 'private' que YA existan.
--
-- Antes de esta migración, privacy='private' quería decir "solo lo ve el
-- creador". A partir de ahora quiere decir "lo ve todo el mundo, pero yo
-- apruebo quién entra". Los eventos privados que ya estuvieran creados
-- pasan a ser visibles para cualquiera.
--
-- Revisa si hay alguno antes de dar por bueno el cambio:
--
--   SELECT id, title, creator_id, starts_at
--   FROM   public.events
--   WHERE  privacy = 'private';
--
-- Si quieres que los antiguos sigan siendo poco visibles, pásalos a
-- 'friends' (solo los ven los amigos del creador):
--
--   UPDATE public.events SET privacy = 'friends'
--   WHERE  privacy = 'private' AND created_at < now();
-- ============================================================


-- >>> 20260820000000_fix-participant-status-trigger.sql <<<
-- ============================================================
-- ARREGLO CRÍTICO: la aprobación de eventos privados nunca llegaba
-- a activarse. Todo el mundo entraba directo.
--
-- Qué pasaba
--   set_participant_initial_status() se declaró SECURITY DEFINER y
--   además se protegió con `IF current_user = 'authenticated'`. Dentro
--   de una función SECURITY DEFINER current_user es el DUEÑO de la
--   función (postgres), nunca 'authenticated', así que esa condición
--   era siempre falsa y el cuerpo no se ejecutaba jamás.
--
--   El cliente inserta literalmente `status: 'joined'`
--   (EventBottomSheet.tsx, handleJoin). Sin la normalización del
--   trigger, ese 'joined' se guardaba tal cual: en un evento privado
--   quien pulsaba "Pedir unirme" quedaba dentro al instante, con
--   plaza, chat y lista de asistentes, y el panel "Solicitudes (N)"
--   del organizador salía siempre vacío.
--
--   El resto del código del proyecto ya documenta esta regla — ver
--   prevent_score_tampering y prevent_self_checkin en
--   20260604120000, que son SECURITY INVOKER precisamente para que
--   `current_user = 'authenticated'` funcione.
--
-- Arreglo
--   Se quita la condición en vez de quitar SECURITY DEFINER: la
--   función necesita leer public.events sin que la RLS le filtre la
--   fila. La normalización pasa a ser incondicional, que es correcto
--   porque NADA del lado servidor inserta en event_participants
--   (no hay un solo INSERT INTO event_participants en las migraciones;
--   respond_to_join_request solo hace UPDATE, y ese UPDATE no dispara
--   este trigger BEFORE INSERT).
-- ============================================================
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

  -- El status de entrada lo decide siempre el servidor, venga de donde
  -- venga el INSERT. Lo que mande el cliente se ignora.
  IF v_privacy = 'private' AND NEW.user_id <> v_creator_id THEN
    NEW.status := 'pending';
  ELSE
    NEW.status := 'joined';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_participant_initial_status() FROM PUBLIC, anon, authenticated;

-- El trigger ya existe desde 20260819000000 y apunta a esta misma
-- función; CREATE OR REPLACE basta, no hay que recrearlo.


-- ============================================================
-- OPCIONAL (no se ejecuta): gente que entró en un evento privado sin
-- aprobación por culpa del bug. Míralo antes de tocar nada.
--
--   SELECT e.id, e.title, p.user_id, p.status, p.joined_at
--   FROM   public.event_participants p
--   JOIN   public.events e ON e.id = p.event_id
--   WHERE  e.privacy = 'private'
--     AND  p.user_id <> e.creator_id
--     AND  p.status  = 'joined';
--
-- Para devolverlos a la cola de aprobación (el UPDATE va como postgres
-- desde el SQL Editor, así que prevent_status_tampering no lo bloquea):
--
--   UPDATE public.event_participants p
--   SET    status = 'pending'
--   FROM   public.events e
--   WHERE  e.id = p.event_id
--     AND  e.privacy = 'private'
--     AND  p.user_id <> e.creator_id
--     AND  p.status  = 'joined';
-- ============================================================


-- >>> 20260821000000_notifications.sql <<<
-- ============================================================
-- Avisos dentro de la app: solicitudes de unirse, solicitudes de
-- amistad y mensajes sin leer.
--
-- Hasta ahora no había forma de enterarse de nada sin ir a mirar. Lo
-- único que faltaba en el esquema era saber hasta dónde ha leído cada
-- quien en cada chat; lo demás ya se puede contar de lo que hay.
-- ============================================================


-- ============================================================
-- 1. Hasta dónde ha leído cada miembro.
--
-- DEFAULT now() a propósito: los miembros que ya existen quedan al día
-- en vez de despertar con el contador disparado por todo el historial.
-- ============================================================
ALTER TABLE public.group_members
  ADD COLUMN IF NOT EXISTS last_read_at timestamptz NOT NULL DEFAULT now();

-- Los contadores filtran por grupo y fecha en cada consulta.
CREATE INDEX IF NOT EXISTS messages_group_created_idx
  ON public.messages (group_id, created_at DESC);


-- ============================================================
-- 2. Marcar un chat como leído.
--
-- Va por RPC porque group_members NO tiene política de UPDATE, y es
-- deliberado: dejar que cada quien edite su fila de membresía abriría
-- la puerta a reescribir group_id o user_id. La función solo toca
-- last_read_at y solo de quien llama.
-- ============================================================
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
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mark_group_read(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.mark_group_read(uuid) TO authenticated;


-- ============================================================
-- 3. Los tres contadores de la barra inferior, en una sola llamada.
--
-- SECURITY DEFINER para poder contar filas que la RLS no dejaría leer
-- en bruto (las solicitudes pendientes de MIS eventos incluyen a gente
-- cuyo perfil no tengo por qué poder listar). Solo devuelve números,
-- nunca filas, y siempre acotado a auth.uid().
-- ============================================================
CREATE OR REPLACE FUNCTION public.notification_counts()
RETURNS TABLE (join_requests bigint, friend_requests bigint, unread_messages bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    -- Gente esperando a que la apruebe en eventos míos
    (SELECT count(*)
       FROM public.event_participants p
       JOIN public.events e ON e.id = p.event_id
      WHERE e.creator_id = auth.uid()
        AND e.is_active
        AND p.status = 'pending'),

    -- Solicitudes de amistad que me han mandado
    (SELECT count(*)
       FROM public.friendships f
      WHERE f.addressee_id = auth.uid()
        AND f.status = 'pending'
        AND NOT public.is_blocked(auth.uid(), f.requester_id)),

    -- Mensajes posteriores a mi última lectura, sin contar los míos.
    -- Bloquear ya saca a ambas partes de sus DMs comunes, pero en un
    -- grupo de tres o más la persona bloqueada sigue dentro.
    (SELECT count(*)
       FROM public.group_members gm
       JOIN public.messages m ON m.group_id = gm.group_id
      WHERE gm.user_id   = auth.uid()
        AND m.sender_id <> auth.uid()
        AND m.created_at > gm.last_read_at
        AND NOT public.is_blocked(auth.uid(), m.sender_id));
$$;

REVOKE EXECUTE ON FUNCTION public.notification_counts() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.notification_counts() TO authenticated;


-- ============================================================
-- 4. Desglose por evento, para el aviso en cada tarjeta de Mis eventos.
-- ============================================================
CREATE OR REPLACE FUNCTION public.pending_requests_by_event()
RETURNS TABLE (event_id uuid, pending bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.event_id, count(*)
    FROM public.event_participants p
    JOIN public.events e ON e.id = p.event_id
   WHERE e.creator_id = auth.uid()
     AND e.is_active
     AND p.status = 'pending'
   GROUP BY p.event_id;
$$;

REVOKE EXECUTE ON FUNCTION public.pending_requests_by_event() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.pending_requests_by_event() TO authenticated;


-- ============================================================
-- 5. Desglose por chat, para el punto en cada grupo o DM de Amigos.
-- ============================================================
-- Devuelve también el nombre: los DM son grupos llamados
-- '__dm_<uuid menor>_<uuid mayor>' (ver create_dm), así que con el nombre
-- el cliente sabe a qué amigo corresponde cada chat sin consultas extra.
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
     AND NOT public.is_blocked(auth.uid(), m.sender_id)
   GROUP BY m.group_id, g.name;
$$;

REVOKE EXECUTE ON FUNCTION public.unread_by_group() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.unread_by_group() TO authenticated;


-- ============================================================
-- 6. friendships no emitía realtime, así que una solicitud de amistad
-- no encendía el aviso hasta el siguiente refresco.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'friendships'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.friendships;
  END IF;
END $$;

-- >>> 20260822000000_approval-notice.sql <<<
-- ============================================================
-- Aviso a quien fue aprobado.
--
-- Los contadores de 20260821000000 cuentan lo que te llega: solicitudes
-- y mensajes. Faltaba el sentido contrario — "ya te dejaron entrar" —,
-- que es justo lo que espera quien pidió unirse a un evento privado.
-- ============================================================


-- ============================================================
-- 1. Cuándo se aprobó y si ya lo ha visto.
--
-- approval_seen arranca en true a propósito: así las filas que ya
-- existen (y las de quien entra directo a un evento abierto) no
-- encienden nada. Solo lo pone en false una aprobación de verdad.
-- ============================================================
ALTER TABLE public.event_participants
  ADD COLUMN IF NOT EXISTS approved_at   timestamptz,
  ADD COLUMN IF NOT EXISTS approval_seen boolean NOT NULL DEFAULT true;


-- ============================================================
-- 2. Aprobar deja marca. Igual que antes salvo el UPDATE final.
-- ============================================================
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

  SELECT id, creator_id, max_spots INTO v_event
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
    RETURN;
  END IF;

  -- Bloquea la fila del evento para serializar las aprobaciones: sin esto,
  -- dos aprobaciones simultáneas podrían pasar del aforo.
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


-- ============================================================
-- 3. Marcar los avisos como vistos, al abrir Mis eventos.
--
-- Por RPC y no por política de UPDATE: event_participants tiene el
-- trigger prevent_status_tampering encima y la fila la comparten dos
-- personas. Esta función solo toca approval_seen y solo de quien llama.
-- ============================================================
CREATE OR REPLACE FUNCTION public.mark_approvals_seen()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.event_participants
  SET    approval_seen = true
  WHERE  user_id = auth.uid()
    AND  approval_seen = false;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mark_approvals_seen() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.mark_approvals_seen() TO authenticated;


-- ============================================================
-- 4. El contador gana una cuarta cifra.
--
-- Hay que borrarla antes: CREATE OR REPLACE no puede cambiar el tipo de
-- retorno de una función que ya existe, y añadir una columna al RETURNS
-- TABLE es justo eso (42P13).
-- ============================================================
DROP FUNCTION IF EXISTS public.notification_counts();

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
    -- Gente esperando a que la apruebe en eventos míos
    (SELECT count(*)
       FROM public.event_participants p
       JOIN public.events e ON e.id = p.event_id
      WHERE e.creator_id = auth.uid()
        AND e.is_active
        AND p.status = 'pending'),

    -- Solicitudes de amistad que me han mandado
    (SELECT count(*)
       FROM public.friendships f
      WHERE f.addressee_id = auth.uid()
        AND f.status = 'pending'
        AND NOT public.is_blocked(auth.uid(), f.requester_id)),

    -- Mensajes posteriores a mi última lectura, sin contar los míos
    (SELECT count(*)
       FROM public.group_members gm
       JOIN public.messages m ON m.group_id = gm.group_id
      WHERE gm.user_id   = auth.uid()
        AND m.sender_id <> auth.uid()
        AND m.created_at > gm.last_read_at
        AND NOT public.is_blocked(auth.uid(), m.sender_id)),

    -- Eventos a los que me han dejado entrar y aún no he visto
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

-- >>> 20260823000000_profile-origin.sql <<<
-- ============================================================
-- De dónde es quien no vive en la ciudad del campus.
--
-- residence_type ya distinguía local / foráneo / internacional, pero no
-- guardaba de dónde, que es justo lo que hace que alguien recién llegado
-- encuentre a gente de su tierra.
--
-- Un solo campo de texto con el valor canónico:
--   internacional -> código ISO de dos letras ('CO')
--   foráneo       -> nombre del estado ('Jalisco')
-- El cliente traduce los códigos con Intl.DisplayNames, así que la lista
-- de países no hay que mantenerla en cada idioma ni en la base.
-- ============================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS origin text;


-- ============================================================
-- Y que se vea en el perfil público.
--
-- La columna va AL FINAL: CREATE OR REPLACE VIEW deja añadir columnas
-- por el final, pero no reordenar ni cambiar las que ya están.
-- ============================================================
CREATE OR REPLACE VIEW public.public_profiles
WITH (security_invoker = false) AS
SELECT
  id,
  name,
  avatar_url,
  major,
  semester,
  residence_type,
  interests,
  languages,
  campus_id,
  points,
  reputation,
  created_at,
  origin
FROM public.profiles p
WHERE auth.uid() IS NOT NULL
  AND NOT public.is_blocked(auth.uid(), p.id);

GRANT SELECT ON public.public_profiles TO authenticated;

-- >>> 20260824000000_indexes.sql <<<
-- ============================================================
-- Índices en las columnas por las que más se filtra.
--
-- La base tenía tres índices en total. Descontando los que ya crean las
-- restricciones UNIQUE, las columnas de abajo se recorrían enteras en
-- cada consulta. Lo que lo hace urgente es notification_counts(): las
-- toca todas y se dispara con cada cambio en tiempo real, así que cada
-- mensaje enviado provocaba varios escaneos secuenciales.
--
-- Sin CONCURRENTLY a propósito: el SQL Editor ejecuta el script dentro
-- de una transacción y CREATE INDEX CONCURRENTLY no puede correr ahí.
-- Con el tamaño actual de las tablas el bloqueo es de milisegundos.
-- ============================================================


-- Mis eventos, estadísticas del perfil, y los contadores de mensajes y
-- aprobaciones. La UNIQUE (event_id, user_id) ya cubre event_id, pero no
-- sirve para buscar por user_id.
CREATE INDEX IF NOT EXISTS event_participants_user_id_idx
  ON public.event_participants (user_id);

-- Los avisos de "te aprobaron". Parcial porque approval_seen es true en
-- casi todas las filas: el índice queda diminuto y solo lista lo pendiente.
CREATE INDEX IF NOT EXISTS event_participants_unseen_approval_idx
  ON public.event_participants (user_id)
  WHERE approval_seen = false;

-- Eventos que organizo: Mis eventos, el panel de solicitudes y el
-- contador de solicitudes pendientes.
CREATE INDEX IF NOT EXISTS events_creator_id_idx
  ON public.events (creator_id);

-- Solicitudes de amistad recibidas. Compuesto con status porque el
-- contador filtra por las dos columnas a la vez, y la UNIQUE existente
-- empieza por requester_id, que no ayuda aquí.
CREATE INDEX IF NOT EXISTS friendships_addressee_status_idx
  ON public.friendships (addressee_id, status);

-- Mis chats. La UNIQUE (group_id, user_id) cubre group_id, no user_id.
CREATE INDEX IF NOT EXISTS group_members_user_id_idx
  ON public.group_members (user_id);

-- Mensajes sin leer: el contador excluye los propios comparando sender_id.
CREATE INDEX IF NOT EXISTS messages_sender_id_idx
  ON public.messages (sender_id);

-- >>> 20260825000000_spots-race-and-retention.sql <<<
-- ============================================================
-- 1. Carrera de aforo al apuntarse.
--
-- recalc_event_spots() contaba DESPUÉS de insertar y en READ COMMITTED:
-- dos personas apuntándose a la vez podían contar ambas antes de que la
-- otra confirmara, ver hueco las dos, y pasar del máximo.
--
-- El arreglo es bloquear la fila del evento ANTES de contar, que es lo
-- que ya hacía respond_to_join_request() en la ruta de aprobación —esa
-- estaba bien— y que faltaba en la de apuntarse directo.
--
-- Sin riesgo de interbloqueo: las dos rutas piden el mismo lock y en el
-- mismo orden (primero events, luego event_participants), y volver a
-- pedirlo dentro de la misma transacción no bloquea.
-- ============================================================
CREATE OR REPLACE FUNCTION public.recalc_event_spots()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_id uuid;
  v_count    integer;
  v_max      integer;
BEGIN
  v_event_id := COALESCE(NEW.event_id, OLD.event_id);

  -- FOR UPDATE serializa: quien llegue segundo espera aquí y cuenta ya
  -- con la fila de la otra persona confirmada.
  SELECT max_spots INTO v_max
  FROM public.events
  WHERE id = v_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- El evento se borró en la misma transacción (cascade); no hay nada
    -- que recalcular.
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM public.event_participants
  WHERE event_id = v_event_id AND status = 'joined';

  IF TG_OP = 'INSERT' AND v_count > v_max THEN
    RAISE EXCEPTION 'EVENT_FULL' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.events
  SET current_spots = v_count
  WHERE id = v_event_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.recalc_event_spots() FROM PUBLIC, anon, authenticated;


-- ============================================================
-- 2. Caducidad de mensajes.
--
-- messages.expires_at existe desde la primera migración y NADIE la
-- escribía nunca: era NULL en todas las filas. Así que no es que
-- faltara la limpieza, es que no había nada marcado que limpiar, y los
-- chats crecían sin límite junto con el coste de los contadores.
--
-- OJO, esto borra mensajes. Dos propiedades que lo hacen seguro:
--   · Solo afecta a mensajes NUEVOS. Los que ya existen tienen
--     expires_at NULL y la limpieza filtra por "expires_at < now()",
--     así que ninguno de ellos entra jamás.
--   · La ventana es un único número, abajo. Cambiarla es una línea.
-- ============================================================

-- 90 días. Suficiente para que un chat de evento siga siendo útil
-- semanas después, y para que un DM no se evapore en un cuatrimestre.
CREATE OR REPLACE FUNCTION public.set_message_expiry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Lo decide el servidor, no el cliente: si no, cualquiera podría
  -- mandar mensajes que no caducan nunca (o que caducan al instante en
  -- la conversación de otro).
  NEW.expires_at := now() + interval '90 days';
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_message_expiry() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_set_message_expiry ON public.messages;
CREATE TRIGGER trg_set_message_expiry
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.set_message_expiry();


CREATE OR REPLACE FUNCTION public.purge_expired_messages()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.messages
  WHERE expires_at IS NOT NULL AND expires_at < now();
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.purge_expired_messages() FROM PUBLIC, anon, authenticated;

-- La limpieza filtra por fecha, así que conviene tenerla indexada.
-- Parcial: las filas antiguas con NULL no entran en el índice.
CREATE INDEX IF NOT EXISTS messages_expires_at_idx
  ON public.messages (expires_at)
  WHERE expires_at IS NOT NULL;

-- >>> 20260825010000_schedule-message-purge.sql <<<
-- ============================================================
-- Programar la limpieza de mensajes caducados.
--
-- Va en su propio script a propósito: el SQL Editor ejecuta cada uno
-- dentro de una transacción, y si CREATE EXTENSION pg_cron fallara
-- —porque la extensión no esté disponible en el plan— se llevaría por
-- delante todo lo demás del script. Separado, un fallo aquí no toca ni
-- el arreglo de la carrera de aforo ni el trigger de caducidad.
--
-- Si esto falla, no pasa nada grave: los mensajes se marcan igual con su
-- fecha de caducidad y basta con llamar a purge_expired_messages() a
-- mano de vez en cuando, o programarlo desde Database → Cron Jobs en el
-- panel de Supabase.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- unschedule falla si el trabajo no existe, de ahí el envoltorio.
DO $$
BEGIN
  PERFORM cron.unschedule('purge-expired-messages');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'purge-expired-messages',
  '17 4 * * *',                       -- 04:17 cada día, fuera de horas punta
  $$SELECT public.purge_expired_messages()$$
);

-- >>> 20260826000000_device-tokens.sql <<<
-- ============================================================
-- Tokens de dispositivo para notificaciones push.
--
-- Un token identifica a un iPhone concreto, no a una persona: si alguien
-- cierra sesión y entra otra cuenta en el mismo teléfono, el token debe
-- CAMBIAR de dueño, no duplicarse. De ahí el UNIQUE sobre token y el
-- upsert que reasigna user_id.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.device_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token      text NOT NULL,
  platform   text NOT NULL DEFAULT 'ios' CHECK (platform IN ('ios', 'android')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token)
);

CREATE INDEX IF NOT EXISTS device_tokens_user_id_idx
  ON public.device_tokens (user_id);

ALTER TABLE public.device_tokens ENABLE ROW LEVEL SECURITY;

-- Solo ves y borras los tuyos. El alta va por RPC (abajo): con una
-- política de INSERT abierta, cualquiera podría registrar el token de
-- otro dispositivo a su nombre y desviarle las notificaciones.
CREATE POLICY "Users can view own device tokens"
  ON public.device_tokens FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can delete own device tokens"
  ON public.device_tokens FOR DELETE TO authenticated
  USING (user_id = auth.uid());


-- ============================================================
-- Alta / renovación del token.
--
-- APNs rota los tokens por su cuenta, así que esto se llama en cada
-- arranque y tiene que ser idempotente.
-- ============================================================
CREATE OR REPLACE FUNCTION public.register_device_token(_token text, _platform text DEFAULT 'ios')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  IF _token IS NULL OR length(_token) = 0 THEN
    RAISE EXCEPTION 'EMPTY_TOKEN' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.device_tokens (user_id, token, platform)
  VALUES (auth.uid(), _token, COALESCE(_platform, 'ios'))
  ON CONFLICT (token) DO UPDATE
    SET user_id    = auth.uid(),
        platform   = COALESCE(EXCLUDED.platform, 'ios'),
        updated_at = now();
END;
$$;

REVOKE EXECUTE ON FUNCTION public.register_device_token(text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.register_device_token(text, text) TO authenticated;


-- Baja al cerrar sesión: sin esto, el teléfono seguiría recibiendo
-- notificaciones de una cuenta de la que ya se salió.
CREATE OR REPLACE FUNCTION public.unregister_device_token(_token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.device_tokens
  WHERE token = _token AND user_id = auth.uid();
END;
$$;

REVOKE EXECUTE ON FUNCTION public.unregister_device_token(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.unregister_device_token(text) TO authenticated;

-- >>> 20260827000000_push-triggers.sql <<<
-- ============================================================
-- Disparadores de notificaciones push.
--
-- Hasta ahora send-push solo se podía llamar a mano. Esto conecta los
-- cuatro momentos en los que la app debería avisar aunque esté cerrada:
--   1. Alguien pide unirse a un evento mío.
--   2. Me aprueban la solicitud.
--   3. Me llega un mensaje.
--   4. Me llega una solicitud de amistad.
--
-- Todo es servidor: la base llama a la Edge Function por HTTP (pg_net).
-- No hace falta build nuevo de la app.
--
-- REQUISITOS antes de ejecutar este script:
--   a) La extensión pg_net habilitada (el CREATE EXTENSION de abajo la
--      pone; si el plan no la trae, se habilita en Database → Extensions).
--   b) El secreto 'service_role_key' guardado en Vault. Va en su propio
--      script porque lleva la clave dentro y esto se versiona en git.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_net;


-- ============================================================
-- 1. push_send() — el único sitio que habla con la Edge Function.
--
-- Tres decisiones que importan:
--   · La clave sale de Vault, nunca de este archivo (esto va a git).
--   · Si la persona no tiene ningún dispositivo registrado, ni se hace
--     la llamada. Es la mayoría de los casos mientras solo iOS registre.
--   · El EXCEPTION del final es lo más importante del script: una push
--     que falla no puede tumbar el mensaje, la solicitud ni la
--     aprobación que la provocó. Se queda en WARNING y la vida sigue.
--
-- net.http_post es asíncrono (encola y devuelve un id), así que esto no
-- añade espera a la escritura del usuario.
-- ============================================================
CREATE OR REPLACE FUNCTION public.push_send(
    _user_id uuid,
    _title   text,
    _body    text,
    _data    jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
-- public al final a propósito: así nadie puede colar un http_post suyo
-- que se resuelva antes que el de pg_net.
SET search_path = extensions, net, public
AS $$
DECLARE
  v_key text;
BEGIN
  IF _user_id IS NULL OR _title IS NULL OR _body IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.device_tokens WHERE user_id = _user_id) THEN
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_key
  FROM   vault.decrypted_secrets
  WHERE  name = 'service_role_key';

  IF v_key IS NULL THEN
    RAISE WARNING 'push_send: falta el secreto service_role_key en Vault';
    RETURN;
  END IF;

  PERFORM http_post(
    url     := 'https://myarlozvkbebygwszgkf.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || v_key
               ),
    body    := jsonb_build_object(
                 'user_id', _user_id,
                 'title',   _title,
                 'body',    _body,
                 'data',    COALESCE(_data, '{}'::jsonb)
               )
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'push_send falló (%): %', SQLSTATE, SQLERRM;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.push_send(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;


-- ============================================================
-- 2. Alguien pide unirse a un evento mío.
--
-- Solo eventos privados generan 'pending' (lo fija
-- set_participant_initial_status), así que este trigger no se dispara
-- en los abiertos.
-- ============================================================
CREATE OR REPLACE FUNCTION public.on_join_request_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_creator uuid;
  v_event   text;
  v_who     text;
BEGIN
  SELECT e.creator_id, e.title INTO v_creator, v_event
  FROM   public.events e WHERE e.id = NEW.event_id;

  IF v_creator IS NULL OR v_creator = NEW.user_id THEN RETURN NEW; END IF;
  IF public.is_blocked(v_creator, NEW.user_id)     THEN RETURN NEW; END IF;

  SELECT COALESCE(NULLIF(p.name, ''), 'Alguien') INTO v_who
  FROM   public.profiles p WHERE p.id = NEW.user_id;

  PERFORM public.push_send(
    v_creator,
    'Nueva solicitud',
    COALESCE(v_who, 'Alguien') || ' quiere unirse a ' || COALESCE(v_event, 'tu evento'),
    jsonb_build_object('type', 'join_request', 'event_id', NEW.event_id)
  );
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.on_join_request_push() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_join_request_push ON public.event_participants;
CREATE TRIGGER trg_join_request_push
  AFTER INSERT ON public.event_participants
  FOR EACH ROW
  WHEN (NEW.status = 'pending')
  EXECUTE FUNCTION public.on_join_request_push();


-- ============================================================
-- 3. Me aprobaron la solicitud.
--
-- Acotado a pending → joined: la otra transición hacia 'joined' es
-- entrar directo a un evento abierto, y ahí no hay nada que avisar.
-- ============================================================
CREATE OR REPLACE FUNCTION public.on_approval_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event text;
BEGIN
  SELECT e.title INTO v_event
  FROM   public.events e WHERE e.id = NEW.event_id;

  PERFORM public.push_send(
    NEW.user_id,
    'Ya estás dentro',
    'Te aprobaron en ' || COALESCE(v_event, 'el evento'),
    jsonb_build_object('type', 'approval', 'event_id', NEW.event_id)
  );
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.on_approval_push() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_approval_push ON public.event_participants;
CREATE TRIGGER trg_approval_push
  AFTER UPDATE OF status ON public.event_participants
  FOR EACH ROW
  WHEN (OLD.status = 'pending' AND NEW.status = 'joined')
  EXECUTE FUNCTION public.on_approval_push();


-- ============================================================
-- 4. Mensaje nuevo.
--
-- Los DM son grupos llamados '__dm_<uuid>_<uuid>' (ver create_dm), y ese
-- nombre no se le enseña a nadie: en un DM el título es el nombre de
-- quien escribe, y en un grupo el nombre del grupo con el remitente
-- delante del texto.
--
-- Se respeta is_blocked: en un DM el bloqueo ya saca a las dos partes,
-- pero en un grupo de tres o más la persona bloqueada sigue dentro.
-- ============================================================
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
  -- El chat de evento nunca llegó a usarse (messages.event_id está muerto);
  -- si algún día se usa, aquí es donde iría.
  IF NEW.group_id IS NULL THEN RETURN NEW; END IF;

  SELECT g.name INTO v_group FROM public.groups g WHERE g.id = NEW.group_id;

  SELECT COALESCE(NULLIF(p.name, ''), 'Alguien') INTO v_sender
  FROM   public.profiles p WHERE p.id = NEW.sender_id;
  v_sender := COALESCE(v_sender, 'Alguien');

  v_body := left(NEW.content, 120);
  IF length(NEW.content) > 120 THEN v_body := v_body || '…'; END IF;

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

DROP TRIGGER IF EXISTS trg_message_push ON public.messages;
CREATE TRIGGER trg_message_push
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.on_message_push();


-- ============================================================
-- 5. Solicitud de amistad.
-- ============================================================
CREATE OR REPLACE FUNCTION public.on_friend_request_push()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_who text;
BEGIN
  IF NEW.addressee_id = NEW.requester_id THEN RETURN NEW; END IF;
  IF public.is_blocked(NEW.addressee_id, NEW.requester_id) THEN RETURN NEW; END IF;

  SELECT COALESCE(NULLIF(p.name, ''), 'Alguien') INTO v_who
  FROM   public.profiles p WHERE p.id = NEW.requester_id;

  PERFORM public.push_send(
    NEW.addressee_id,
    'Solicitud de amistad',
    COALESCE(v_who, 'Alguien') || ' te quiere agregar',
    jsonb_build_object('type', 'friend_request', 'requester_id', NEW.requester_id)
  );
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.on_friend_request_push() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_friend_request_push ON public.friendships;
CREATE TRIGGER trg_friend_request_push
  AFTER INSERT ON public.friendships
  FOR EACH ROW
  WHEN (NEW.status = 'pending')
  EXECUTE FUNCTION public.on_friend_request_push();

-- >>> 20260828000000_institutions.sql <<<
-- ============================================================
-- Instituciones genéricas + auto-join por dominio verificado en servidor
--
-- Antes: `campuses` tenía UNA columna email_domain, y el cliente decidía la
-- pertenencia con `email.endsWith('@tec.mx')` escrito a mano en Onboarding.
-- Eso significa que cualquiera podía asignarse el campus que quisiera desde
-- la API REST: el navegador no es un sitio donde verificar nada.
--
-- Después: `institutions` con una LISTA de dominios, y el servidor resuelve
-- la pertenencia en el trigger de alta. El cliente puede seguir *eligiendo*
-- una institución (queda sin verificar), pero no puede declararse verificado.
--
-- Idempotente: pensada para pegarse en el SQL Editor, incluso dos veces.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. campuses -> institutions
--
-- RENAME y no una tabla nueva: conserva los datos, la PK y la clave ajena
-- profiles.campus_id, que pasa a apuntar a institutions sin tocarla.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'campuses')
     AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'institutions')
  THEN
    ALTER TABLE public.campuses RENAME TO institutions;

    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'institutions'
        AND policyname = 'Anyone can view campuses'
    ) THEN
      ALTER POLICY "Anyone can view campuses" ON public.institutions
        RENAME TO "Anyone can view institutions";
    END IF;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. Columnas nuevas
-- ------------------------------------------------------------
ALTER TABLE public.institutions
  ADD COLUMN IF NOT EXISTS slug          text,
  ADD COLUMN IF NOT EXISTS email_domains text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_active     boolean NOT NULL DEFAULT true;

-- Traspasa el dominio único al array, si la columna vieja sigue ahí.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'institutions' AND column_name = 'email_domain'
  ) THEN
    UPDATE public.institutions
    SET email_domains = ARRAY[lower(email_domain)]
    WHERE email_domain IS NOT NULL AND email_domains = '{}';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. La fila existente pasa a ser una institución completa.
--
-- OJO, REVÍSAME ANTES DE EJECUTAR: las coordenadas del seed original eran
-- las de Monterrey (25.6514, -100.2899), pero el mapa de la app arranca en
-- Querétaro. Se unifican en Querétaro, que es lo que la app hace de verdad.
-- Si tu campus es otro, cambia estas dos líneas y el nombre.
-- ------------------------------------------------------------
UPDATE public.institutions
SET name          = 'Tec de Monterrey Campus Querétaro',
    slug          = 'tec-mty-qro',
    email_domains = ARRAY['tec.mx', 'exatec.mx', 'itesm.mx'],
    lat           = 20.6134,
    lng           = -100.4063
WHERE slug IS NULL
  AND 'tec.mx' = ANY (email_domains);

-- Cualquier otra fila sin slug recibe uno derivado del nombre.
UPDATE public.institutions
SET slug = regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')
WHERE slug IS NULL;

-- ------------------------------------------------------------
-- 4. Restricciones, ya con los datos limpios
-- ------------------------------------------------------------
ALTER TABLE public.institutions ALTER COLUMN slug SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'institutions_slug_key'
  ) THEN
    ALTER TABLE public.institutions ADD CONSTRAINT institutions_slug_key UNIQUE (slug);
  END IF;
END $$;

-- El dominio único ya vive en el array; la columna sobra.
ALTER TABLE public.institutions DROP COLUMN IF EXISTS email_domain;

-- GIN, porque la búsqueda es "¿este dominio está en el array?".
CREATE INDEX IF NOT EXISTS institutions_email_domains_idx
  ON public.institutions USING gin (email_domains);

-- institution_for_email compara con `= ANY (email_domains)` para poder usar
-- ese índice, y eso exige que los dominios estén en minúsculas y sin espacios.
--
-- Se hace con un trigger y no con un CHECK por dos razones: Postgres no admite
-- subconsultas en un CHECK (y recorrer un array necesita unnest), y además
-- normalizar es mejor que rechazar — quien dé de alta una institución con
-- "TEC.MX" quiere decir tec.mx, no equivocarse.
CREATE OR REPLACE FUNCTION public.normalize_institution_domains()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.email_domains := ARRAY(
    SELECT lower(btrim(d))
    FROM unnest(COALESCE(NEW.email_domains, '{}')) AS d
    WHERE btrim(d) <> ''
  );
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.normalize_institution_domains() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_normalize_institution_domains ON public.institutions;
CREATE TRIGGER trg_normalize_institution_domains
  BEFORE INSERT OR UPDATE ON public.institutions
  FOR EACH ROW EXECUTE FUNCTION public.normalize_institution_domains();

-- Normaliza lo que ya hubiera en la tabla antes de este trigger.
UPDATE public.institutions
SET email_domains = ARRAY(SELECT lower(btrim(d)) FROM unnest(email_domains) AS d)
WHERE email_domains IS DISTINCT FROM ARRAY(SELECT lower(btrim(d)) FROM unnest(email_domains) AS d);

-- ------------------------------------------------------------
-- 5. Vista de compatibilidad
--
-- El cliente y src/integrations/supabase/types.ts siguen hablando de
-- `campuses`. La vista deja que ese código funcione sin cambios mientras se
-- migra, exponiendo el primer dominio como el `email_domain` de siempre.
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.campuses;
CREATE VIEW public.campuses WITH (security_invoker = true) AS
SELECT id,
       name,
       email_domains[1] AS email_domain,
       lat,
       lng,
       created_at
FROM public.institutions
WHERE is_active;

GRANT SELECT ON public.campuses TO authenticated;

-- ------------------------------------------------------------
-- 6. La marca de pertenencia verificada
-- ------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS institution_verified boolean NOT NULL DEFAULT false;

-- ------------------------------------------------------------
-- 7. Resolver institución a partir del correo
--
-- SECURITY DEFINER y sin permiso de ejecución para nadie: solo la llama el
-- trigger de alta, que corre como postgres.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.institution_for_email(_email text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id
  FROM public.institutions
  WHERE is_active
    AND lower(split_part(_email, '@', 2)) = ANY (email_domains)
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.institution_for_email(text) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 8. El alta asigna la institución
--
-- Sustituye a handle_new_user() conservando lo que ya hacía (crear el
-- perfil); ahora además resuelve la institución por dominio.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_institution uuid;
BEGIN
  v_institution := public.institution_for_email(NEW.email);

  INSERT INTO public.profiles (id, email, campus_id, institution_verified)
  VALUES (NEW.id, NEW.email, v_institution, v_institution IS NOT NULL);

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 9. El cliente no puede declararse verificado
--
-- Mismo mecanismo que ya protege points y reputation: si quien escribe es el
-- rol `authenticated` (es decir, el navegador) y la bandera cambia, se
-- rechaza. Las funciones SECURITY DEFINER corren como postgres y pasan.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_score_tampering()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.points IS DISTINCT FROM OLD.points OR NEW.reputation IS DISTINCT FROM OLD.reputation)
     AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'permission denied: score fields are read-only for regular users'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.institution_verified IS DISTINCT FROM OLD.institution_verified
     AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'permission denied: institution_verified is set by the server, not the client'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_score_tampering() FROM PUBLIC, anon, authenticated;

-- El trigger ya existe desde 20260604120000, pero recrearlo hace que esta
-- migración no dependa de ello.
DROP TRIGGER IF EXISTS trg_prevent_score_tampering ON public.profiles;
CREATE TRIGGER trg_prevent_score_tampering
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_score_tampering();

-- ------------------------------------------------------------
-- 10. Perfiles que ya existen
--
-- Quien se registró con un correo institucional antes de esta migración
-- queda verificado y adscrito, aunque hubiera elegido otra cosa a mano.
-- ------------------------------------------------------------
UPDATE public.profiles p
SET campus_id            = i.id,
    institution_verified = true
FROM public.institutions i
WHERE i.is_active
  AND lower(split_part(p.email, '@', 2)) = ANY (i.email_domains)
  AND (p.campus_id IS DISTINCT FROM i.id OR NOT p.institution_verified);

-- ------------------------------------------------------------
-- 11. La vista pública expone la insignia
--
-- DROP + CREATE y no CREATE OR REPLACE: este último exige que las columnas
-- que ya existen coincidan en nombre y ORDEN, y si la vista de producción
-- hubiera derivado un milímetro respecto al esquema del repo, fallaría. Nada
-- depende de esta vista, así que recrearla es seguro.
--
-- Se conserva security_invoker = false, que es como estaba
-- (ver 20260604120000_fix-three-security-bugs.sql).
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.public_profiles;
CREATE VIEW public.public_profiles
WITH (security_invoker = false) AS
SELECT
  id,
  name,
  avatar_url,
  major,
  semester,
  residence_type,
  interests,
  languages,
  campus_id,
  points,
  reputation,
  created_at,
  origin,
  institution_verified
FROM public.profiles p
WHERE auth.uid() IS NOT NULL
  AND NOT public.is_blocked(auth.uid(), p.id);

GRANT SELECT ON public.public_profiles TO authenticated;

COMMIT;

-- >>> 20260829000000_institution-isolation.sql <<<
-- ============================================================
-- Aislamiento por institución
--
-- Hasta ahora la institución ETIQUETABA a la gente pero no SEPARABA nada:
-- la política de eventos era "cualquiera ve los abiertos" y la búsqueda de
-- personas iba contra public_profiles sin filtro. Un correo genérico veía
-- exactamente lo mismo que alguien del campus.
--
-- A partir de aquí cada institución es un entorno cerrado: solo ves eventos y
-- personas de la tuya. Lo impone la RLS, no el cliente, así que no se salta
-- llamando a la API directamente.
--
-- Se conserva SIEMPRE la visibilidad de lo propio: tus eventos y tu perfil los
-- ves aunque tu institución cambie o falte, para no dejar a nadie encerrado
-- fuera de sus propias cosas.
--
-- Idempotente: pensada para pegarse en el SQL Editor, incluso dos veces.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. ¿Son de la misma institución?
--
-- SECURITY DEFINER porque tiene que leer profiles saltándose la RLS: si no,
-- la propia política que la usa entraría en recursión.
-- STABLE para que el planificador la evalúe una vez por consulta, no por fila.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.same_institution(_a uuid, _b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles pa
    JOIN public.profiles pb ON pb.id = _b
    WHERE pa.id = _a
      AND pa.campus_id IS NOT NULL
      AND pa.campus_id = pb.campus_id
  );
$$;

REVOKE EXECUTE ON FUNCTION public.same_institution(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.same_institution(uuid, uuid) TO authenticated;

-- ------------------------------------------------------------
-- 2. Eventos: se acotan a la institución de quien los crea
--
-- Se desnormaliza en una columna en vez de resolverlo con un JOIN dentro de la
-- política: la RLS se evalúa por fila y en el mapa eso son cientos de filas.
-- ------------------------------------------------------------
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS institution_id uuid REFERENCES public.institutions(id);

-- El cliente no la manda: la pone el servidor a partir del perfil del creador.
CREATE OR REPLACE FUNCTION public.set_event_institution()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  SELECT campus_id INTO NEW.institution_id
  FROM public.profiles
  WHERE id = NEW.creator_id;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_event_institution() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_set_event_institution ON public.events;
CREATE TRIGGER trg_set_event_institution
  BEFORE INSERT ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.set_event_institution();

-- Eventos que ya existen.
UPDATE public.events e
SET institution_id = p.campus_id
FROM public.profiles p
WHERE p.id = e.creator_id
  AND e.institution_id IS DISTINCT FROM p.campus_id;

CREATE INDEX IF NOT EXISTS events_institution_id_idx
  ON public.events (institution_id) WHERE is_active;

-- ------------------------------------------------------------
-- 3. La política de visibilidad, con la institución dentro
--
-- Parte de la de 20260819000000_join-requests.sql y le añade el corte por
-- institución. Lo propio se saca fuera del AND para que tus eventos sigan
-- siendo tuyos pase lo que pase.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Events visibility policy" ON public.events;

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

-- ------------------------------------------------------------
-- 4. Personas: la vista pública también se acota
--
-- Es la que alimentan la búsqueda de amigos y las fichas de perfil. Sin esto,
-- acotar los eventos serviría de poco: se seguiría viendo a todo el mundo.
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.public_profiles;
CREATE VIEW public.public_profiles
WITH (security_invoker = false) AS
SELECT
  id,
  name,
  avatar_url,
  major,
  semester,
  residence_type,
  interests,
  languages,
  campus_id,
  points,
  reputation,
  created_at,
  origin,
  institution_verified
FROM public.profiles p
WHERE auth.uid() IS NOT NULL
  AND NOT public.is_blocked(auth.uid(), p.id)
  AND (p.id = auth.uid() OR public.same_institution(auth.uid(), p.id));

GRANT SELECT ON public.public_profiles TO authenticated;

-- ------------------------------------------------------------
-- 5. Sin institución no se termina el onboarding
--
-- El cliente ya lo exige (Onboarding.tsx no deja pasar el paso sin elegir),
-- pero eso es una comprobación de navegador: se salta con una llamada a la
-- API. Aquí se garantiza de verdad.
--
-- NOT VALID a propósito: solo se aplica a filas nuevas y a las que se
-- actualicen. Sin eso, la migración fallaría entera si existiera un perfil
-- antiguo con el onboarding hecho y sin campus, y no puedo comprobar desde
-- fuera si lo hay. Para exigirlo también a los viejos, cuando estés seguro:
--     ALTER TABLE public.profiles VALIDATE CONSTRAINT profiles_institution_required;
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_institution_required'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_institution_required
      CHECK (NOT onboarding_completed OR campus_id IS NOT NULL) NOT VALID;
  END IF;
END $$;

COMMIT;

-- >>> 20260830000000_seed-institutions.sql <<<
-- ============================================================
-- Siembra de universidades mexicanas
--
-- Con el aislamiento por institución activo, la tabla no puede tener una sola
-- fila: quien no sea del Tec tendría que elegir el Tec o quedarse fuera.
--
-- SOBRE LA FIABILIDAD DE ESTOS DATOS:
--
--   · Los dominios están comprobados: los 20 tienen registros MX activos. Eso
--     confirma que existen y reciben correo. NO confirma que los alumnos
--     tengan cuenta ahí — en varias universidades el dominio principal es de
--     personal y los alumnos usan un subdominio. Donde lo conozco, van los dos.
--     Si un dominio está mal, esos alumnos no quedan inscritos solos: tendrán
--     que elegir su universidad a mano y saldrán como no verificados.
--
--   · Las coordenadas son APROXIMADAS, de memoria, y no las he verificado. Solo
--     deciden dónde abre el mapa. Un error de cientos de metros no se nota; uno
--     de kilómetros sí. Revisa las de los campus que te importen antes de fiarte.
--
--   · Varias universidades tienen muchos campus. Aquí va uno por universidad,
--     el principal. Si necesitas separar campus, añade filas con su propio slug.
--
-- Idempotente: ON CONFLICT DO NOTHING, así que re-ejecutarla no duplica nada
-- ni pisa lo que ya hayas corregido a mano.
-- ============================================================

BEGIN;

INSERT INTO public.institutions (name, slug, email_domains, lat, lng) VALUES
  ('Universidad Nacional Autónoma de México',        'unam',    ARRAY['unam.mx', 'comunidad.unam.mx'], 19.3320,  -99.1870),
  ('Instituto Politécnico Nacional',                 'ipn',     ARRAY['ipn.mx', 'alumno.ipn.mx'],      19.5045,  -99.1470),
  ('Universidad de Guadalajara',                     'udg',     ARRAY['udg.mx', 'alumnos.udg.mx'],     20.6560, -103.3250),
  ('Universidad Autónoma de Nuevo León',             'uanl',    ARRAY['uanl.edu.mx'],                  25.7250, -100.3130),
  ('Universidad Autónoma Metropolitana',             'uam',     ARRAY['uam.mx'],                       19.3650,  -99.0740),
  ('Benemérita Universidad Autónoma de Puebla',      'buap',    ARRAY['buap.mx', 'alumno.buap.mx'],    19.0000,  -98.2030),
  ('Universidad Autónoma del Estado de México',      'uaemex',  ARRAY['uaemex.mx'],                    19.2900,  -99.6700),
  ('Universidad Autónoma de San Luis Potosí',        'uaslp',   ARRAY['uaslp.mx'],                     22.1500, -100.9800),
  ('Universidad Autónoma de Querétaro',              'uaq',     ARRAY['uaq.mx'],                       20.5880, -100.4050),
  ('Universidad Iberoamericana',                     'ibero',   ARRAY['ibero.mx'],                     19.3770,  -99.2620),
  ('Instituto Tecnológico Autónomo de México',       'itam',    ARRAY['itam.mx'],                      19.3480,  -99.2060),
  ('Universidad Anáhuac',                            'anahuac', ARRAY['anahuac.mx'],                   19.4190,  -99.3020),
  ('Universidad de las Américas Puebla',             'udlap',   ARRAY['udlap.mx'],                     19.0540,  -98.2830),
  ('Universidad Panamericana',                       'up',      ARRAY['up.edu.mx'],                    19.3520,  -99.1900),
  ('El Colegio de México',                           'colmex',  ARRAY['colmex.mx'],                    19.3020,  -99.2050),
  ('Centro de Investigación y Docencia Económicas',  'cide',    ARRAY['cide.edu'],                     19.3720,  -99.2670)
ON CONFLICT DO NOTHING;

COMMIT;

-- >>> 20260831000000_fix-institution-names.sql <<<
-- ============================================================
-- Reparacion: acentos rotos en los nombres de las instituciones
--
-- Los nombres entraron con mojibake (se veia "Quer" seguido de dos simbolos raros en vez de la e
-- acentuada). La causa fue el portapapeles de macOS: pbcopy con la variable LANG
-- vacia etiqueta el contenido como Mac Roman, y el navegador lo reconvierte
-- como si lo fuera, convirtiendo cada byte UTF-8 en dos caracteres.
--
-- Este archivo es ASCII PURO a proposito. Los nombres van con escapes Unicode
-- (U&'...\00E9...'), de modo que ningun portapapeles, editor ni terminal mal
-- configurado puede volver a corromperlos. Postgres los expande al ejecutar.
--
-- Se corrige por slug, que es ASCII y llego intacto, asi que da igual como
-- haya quedado el nombre.
--
-- Idempotente: ejecutarla dos veces no cambia nada la segunda vez.
-- ============================================================

BEGIN;

UPDATE public.institutions i
SET name = c.nombre
FROM (VALUES
    ('tec-mty-qro', U&'Tec de Monterrey Campus Quer\00E9taro'),
    ('unam', U&'Universidad Nacional Aut\00F3noma de M\00E9xico'),
    ('ipn', U&'Instituto Polit\00E9cnico Nacional'),
    ('udg', 'Universidad de Guadalajara'),
    ('uanl', U&'Universidad Aut\00F3noma de Nuevo Le\00F3n'),
    ('uam', U&'Universidad Aut\00F3noma Metropolitana'),
    ('buap', U&'Benem\00E9rita Universidad Aut\00F3noma de Puebla'),
    ('uaemex', U&'Universidad Aut\00F3noma del Estado de M\00E9xico'),
    ('uaslp', U&'Universidad Aut\00F3noma de San Luis Potos\00ED'),
    ('uaq', U&'Universidad Aut\00F3noma de Quer\00E9taro'),
    ('ibero', 'Universidad Iberoamericana'),
    ('itam', U&'Instituto Tecnol\00F3gico Aut\00F3nomo de M\00E9xico'),
    ('anahuac', U&'Universidad An\00E1huac'),
    ('udlap', U&'Universidad de las Am\00E9ricas Puebla'),
    ('up', 'Universidad Panamericana'),
    ('colmex', U&'El Colegio de M\00E9xico'),
    ('cide', U&'Centro de Investigaci\00F3n y Docencia Econ\00F3micas')
) AS c(slug, nombre)
WHERE i.slug = c.slug
  AND i.name IS DISTINCT FROM c.nombre;

COMMIT;

-- >>> 20260901000000_events-map-index.sql <<<
-- ============================================================
-- Índice para la consulta principal del mapa.
--
-- MapHome pide siempre lo mismo:
--
--     select * from events where is_active and ends_at > now()
--
-- y hasta ahora eso era un recorrido secuencial de la tabla entera. Los
-- índices que había son de creator_id e institution_id, que no sirven aquí.
--
-- Parcial sobre is_active en vez de un compuesto (is_active, ends_at): la
-- inmensa mayoría de las filas tienen is_active = true, así que el índice
-- pesa prácticamente lo mismo, pero se ahorra la columna y deja fuera los
-- eventos cancelados, que es justo lo que la consulta nunca quiere.
--
-- Sobre ends_at y no sobre starts_at: la condición es un rango sobre
-- ends_at, así que el índice se posiciona en now() y recorre hacia
-- adelante. Los eventos ya pasados se quedan detrás del punto de entrada
-- sin llegar a leerse, que es lo que hace que esto siga funcionando
-- cuando la tabla acumule años de eventos viejos.
--
-- Sin CONCURRENTLY a propósito, por lo mismo que en 20260824000000: el SQL
-- Editor ejecuta el script dentro de una transacción y CREATE INDEX
-- CONCURRENTLY no puede correr ahí. Con el tamaño actual de la tabla el
-- bloqueo es de milisegundos.
--
-- Idempotente: re-ejecutarlo no hace nada.
-- ============================================================

CREATE INDEX IF NOT EXISTS events_active_ends_idx
  ON public.events (ends_at)
  WHERE is_active;

-- >>> 20260902000000_friends-pagination.sql <<<
-- ============================================================
-- Paginar amigos y solicitudes en el servidor.
--
-- El cliente traía TODAS las amistades y luego pedía los perfiles con
-- `.in('id', [...])`, metiendo la lista entera de uuid en la URL. Son unos
-- 37 bytes por uuid contra un límite de ~8 kB: pasados unos 200 amigos la
-- petición se rechaza con 414 y la pestaña se queda vacía del todo.
--
-- De paso arregla dos cosas más que venían con ello:
--
--   · `.range()` iba sin `.order()`. Postgres no garantiza ningún orden sin
--     ORDER BY, así que con LIMIT/OFFSET se podían repetir y saltar filas
--     entre páginas. Aquí el orden es total (nombre, y el id para desempatar).
--
--   · El contador de la cabecera enseñaba los amigos CARGADOS, no los que
--     hay. Ahora viene el total de verdad, gratis con una función de ventana:
--     se evalúa antes del LIMIT.
--
-- SECURITY INVOKER (lo de por defecto), a propósito y no DEFINER: así la RLS
-- de `friendships` sigue aplicándose y `public_profiles` filtra por su cuenta
-- (bloqueos e institución). La función no puede enseñar nada que el cliente
-- no pudiera pedir ya por su cuenta; solo lo hace en una consulta en vez de
-- en dos y sin meter nada en la URL.
--
-- Idempotente: pensada para pegarse en el SQL Editor, incluso dos veces.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Una página de mis amigos
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.friends_page(
  _limit  integer DEFAULT 15,
  _offset integer DEFAULT 0
)
RETURNS TABLE (
  id         uuid,
  name       text,
  avatar_url text,
  major      text,
  total      bigint
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
    -- Antes del LIMIT: da cuántos hay, no cuántos caben en la página.
    count(*) OVER () AS total
  FROM public.friendships f
  JOIN public.public_profiles p
    ON p.id = CASE
                WHEN f.requester_id = auth.uid() THEN f.addressee_id
                ELSE f.requester_id
              END
  WHERE f.status = 'accepted'
    AND (f.requester_id = auth.uid() OR f.addressee_id = auth.uid())
  -- El id desempata: sin él, dos personas con el mismo nombre podrían
  -- intercambiarse entre páginas y aparecer dos veces o ninguna.
  ORDER BY p.name NULLS LAST, p.id
  LIMIT  least(greatest(_limit, 1), 100)
  OFFSET greatest(_offset, 0);
$$;

REVOKE EXECUTE ON FUNCTION public.friends_page(integer, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.friends_page(integer, integer) TO authenticated;

-- ------------------------------------------------------------
-- 2. Las solicitudes de amistad que he recibido
--
-- Mismo problema de URL y misma solución. El tope es una válvula: una cuenta
-- que dispare solicitudes en masa no debe poder tumbar la pantalla.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.friend_requests_incoming(
  _limit integer DEFAULT 200
)
RETURNS TABLE (
  friendship_id uuid,
  id            uuid,
  name          text,
  avatar_url    text,
  major         text
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    f.id,
    p.id,
    p.name,
    p.avatar_url,
    p.major
  FROM public.friendships f
  JOIN public.public_profiles p ON p.id = f.requester_id
  WHERE f.addressee_id = auth.uid()
    AND f.status = 'pending'
  ORDER BY f.created_at DESC, f.id
  LIMIT least(greatest(_limit, 1), 500);
$$;

REVOKE EXECUTE ON FUNCTION public.friend_requests_incoming(integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.friend_requests_incoming(integer) TO authenticated;

COMMIT;

-- >>> 20260903000000_event-rate-limit.sql <<<
-- ============================================================
-- Límite de creación de eventos
--
-- La política de INSERT sobre events solo comprueba que el creador seas
-- tú (`auth.uid() = creator_id`). No hay nada que impida a un script
-- meter eventos en bucle.
--
-- Lo que lo vuelve urgente es que el mapa pasó a estar acotado a 500
-- eventos (MAX_MAP_EVENTS, migración 20260901000000): con el tope, quien
-- llene esos 500 no satura la app, hace algo peor — desplaza a los
-- eventos reales fuera del mapa SIN que nada indique que faltan.
--
-- Va en un trigger y no dentro de la política porque así se puede
-- devolver un código estable que el cliente traduce (ver rpcErrors.ts);
-- una política que no pasa solo produce el error genérico de RLS.
-- ============================================================

-- Márgenes holgados: son para frenar un bucle, no para estorbar a quien
-- organiza de verdad. Un usuario normal no llega a estos números.
CREATE OR REPLACE FUNCTION public.enforce_event_rate_limit()
RETURNS trigger
LANGUAGE plpgsql
-- DEFINER a propósito: el recuento tiene que ver TODAS las filas del
-- usuario. Con INVOKER, alguien podría esconderse tras la política de
-- visibilidad para que sus propios eventos no se contaran.
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_ultima int;
  v_dia    int;
BEGIN
  -- Sin sesión: service_role, semillas y las propias migraciones. No se
  -- les aplica el límite, o el seed de datos de prueba fallaría.
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT
    count(*) FILTER (WHERE created_at > now() - interval '1 hour'),
    count(*) FILTER (WHERE created_at > now() - interval '1 day')
  INTO v_ultima, v_dia
  FROM public.events
  WHERE creator_id = v_uid
    AND created_at > now() - interval '1 day';

  IF v_ultima >= 5 OR v_dia >= 20 THEN
    RAISE EXCEPTION 'EVENT_RATE_LIMIT'
      USING HINT = 'Demasiados eventos creados en poco tiempo.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_event_rate_limit() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_event_rate_limit ON public.events;
CREATE TRIGGER trg_event_rate_limit
  BEFORE INSERT ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_event_rate_limit();

-- >>> 20260904000000_badges-own-only.sql <<<
-- ============================================================
-- Las insignias, solo las tuyas
--
-- `badges` se quedó con la política del primer día,
-- `FOR SELECT USING (true)`: cualquiera autenticado podía leer las filas
-- de todo el mundo. Era la única tabla de datos que seguía así, y
-- contradice el aislamiento por institución que impusieron
-- 20260828000000 y 20260829000000 — no filtra nombres, pero sí una
-- lista de UUIDs de usuarios de OTRAS instituciones.
--
-- Se cierra a lo que la app usa de verdad: Profile.tsx es el único sitio
-- que las lee, y siempre las del propio usuario. La hoja de perfil de
-- otra persona (UserProfileSheet) no las enseña.
-- ============================================================

DROP POLICY IF EXISTS "Users can view badges" ON public.badges;

CREATE POLICY "Users can view own badges"
  ON public.badges FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- >>> 20260905000000_create-tip-seen.sql <<<
-- ============================================================
-- Aviso de "aquí se crean los eventos", una sola vez por persona
--
-- Va en profiles y no en localStorage a propósito: tiene que
-- sobrevivir a un cambio de dispositivo. Mismo patrón que
-- `onboarding_completed`, que ya vive aquí.
--
-- NO hace falta tocar RLS: las políticas de profiles ya dejan a cada
-- usuario leer y actualizar su propia fila, así que la columna queda
-- cubierta por las que hay.
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS create_tip_seen boolean NOT NULL DEFAULT false;

-- >>> 20260906000000_consentimiento-legal.sql <<<
-- ============================================================
-- Constancia de que la persona aceptó los términos y confirmó
-- ser mayor de edad
--
-- La app se publica con clasificación 18+ y los términos exigen
-- 18 años, pero hasta ahora eso solo estaba ESCRITO: nadie lo
-- confirmaba y no quedaba constancia de nada. Una casilla que no
-- se guarda no sirve de prueba, así que el onboarding escribe
-- aquí el momento exacto.
--
-- Dos columnas y no una porque son dos afirmaciones distintas:
-- "acepto este contrato" y "declaro tener 18 años". Se marcan en
-- el mismo instante, pero cada una se sostiene por su cuenta si
-- alguna vez hay que demostrarla.
--
-- Nullable a propósito: las cuentas que ya existen no han pasado
-- por esta pantalla, y ponerles una fecha inventada sería
-- justamente falsificar la constancia. NULL significa "no consta",
-- que es la verdad.
--
-- NO hace falta tocar RLS: las políticas de profiles ya dejan a
-- cada usuario leer y actualizar su propia fila, así que las
-- columnas quedan cubiertas por las que hay. Mismo patrón que
-- `onboarding_completed` y `create_tip_seen`.
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS age_confirmed_at  timestamptz;

-- >>> 20260907000000_matricula.sql <<<
-- ============================================================
-- Matrícula deducida del correo institucional
--
-- a01714719@tec.mx  ->  a01714719
--
-- Lo hace el SERVIDOR, en el trigger de alta, por la misma razón
-- que la institución: el correo lo ha verificado el proveedor de
-- autenticación, así que la parte de antes de la @ es un dato
-- acreditado. Si lo escribiera el cliente sería un campo de texto
-- cualquiera y no acreditaría nada.
--
-- SOLO cuando el correo pertenece a una institución reconocida.
-- Con un correo genérico la parte local no es ninguna matrícula
-- (de `pepe.lopez@gmail.com` no sale una matrícula, sale "pepe.lopez"),
-- así que ahí se queda en NULL.
--
-- No se valida el FORMATO a propósito. El de la matrícula del Tec
-- (una a y ocho dígitos) no es el de las otras dieciséis
-- instituciones sembradas, y una expresión regular pensada para una
-- de ellas dejaría al resto sin matrícula sin decir por qué.
--
-- NO se filtra a otros usuarios: la vista `public_profiles`, que es
-- por donde se leen los perfiles ajenos, enumera sus columnas una a
-- una y esta no está. Comprobado al escribir esta migración. Si
-- alguna vez se añade ahí, se estaría publicando la matrícula de
-- todo el mundo.
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS student_id text;

COMMENT ON COLUMN public.profiles.student_id IS
  'Matricula deducida de la parte local del correo institucional. La escribe el servidor en el alta; NULL si el correo no pertenece a ninguna institucion reconocida.';


-- ------------------------------------------------------------
-- 1. De dónde sale la matrícula
--
-- Función aparte para que el alta y el relleno de las cuentas que
-- ya existen usen exactamente la misma regla, y no dos copias que
-- se separen con el tiempo.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.student_id_for_email(_email text)
RETURNS text
LANGUAGE sql
-- STABLE y no IMMUTABLE: por dentro consulta la tabla de instituciones, así
-- que el resultado depende del contenido de la base y no solo del argumento.
-- Declararla IMMUTABLE invitaría al planificador a cachear resultados que
-- pueden cambiar al añadir un dominio.
STABLE
-- SECURITY DEFINER por lo mismo que institution_for_email, a la que llama:
-- esa tiene EXECUTE revocado para authenticated, así que sin esto una llamada
-- desde el navegador moriría con "permission denied" por dentro.
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN _email IS NULL THEN NULL
    -- Sin institución no hay matrícula que deducir.
    WHEN public.institution_for_email(_email) IS NULL THEN NULL
    ELSE lower(btrim(split_part(_email, '@', 1)))
  END;
$$;

-- Nadie la llama desde fuera: solo el trigger de alta y el relleno de abajo,
-- que corren como postgres. Misma postura que institution_for_email.
REVOKE EXECUTE ON FUNCTION public.student_id_for_email(text) FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 2. El alta la asigna
--
-- Se reescribe entera conservando lo que ya hacía (crear el perfil
-- y resolver la institución) y añadiendo la matrícula.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_institution uuid;
BEGIN
  v_institution := public.institution_for_email(NEW.email);

  INSERT INTO public.profiles (id, email, campus_id, institution_verified, student_id)
  VALUES (
    NEW.id,
    NEW.email,
    v_institution,
    v_institution IS NOT NULL,
    public.student_id_for_email(NEW.email)
  );

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 3. El cliente no puede reescribirla
--
-- Mismo mecanismo que ya protege points, reputation e
-- institution_verified: si quien escribe es el rol `authenticated`
-- (o sea, el navegador) y el valor cambia, se rechaza. Las
-- funciones SECURITY DEFINER corren como postgres y pasan.
--
-- Solo se protege cuando HAY matrícula puesta. Un perfil sin
-- institución la tiene en NULL, y ahí no hay nada que falsear:
-- si algún día se añade un campo para escribirla a mano, este
-- guardia no lo estorba.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_score_tampering()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.points IS DISTINCT FROM OLD.points OR NEW.reputation IS DISTINCT FROM OLD.reputation)
     AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'permission denied: score fields are read-only for regular users'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.institution_verified IS DISTINCT FROM OLD.institution_verified
     AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'permission denied: institution_verified is set by the server, not the client'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.student_id IS NOT NULL
     AND NEW.student_id IS DISTINCT FROM OLD.student_id
     AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'permission denied: student_id is derived from the verified email, not set by the client'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_score_tampering() FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 4. Las cuentas que ya existen
--
-- Solo las que tienen institución y aún no tienen matrícula. No se
-- pisa nada que ya tuviera valor.
-- ------------------------------------------------------------
UPDATE public.profiles
SET    student_id = public.student_id_for_email(email)
WHERE  student_id IS NULL
  AND  public.student_id_for_email(email) IS NOT NULL;


-- ============================================================
-- Comprobación (se ejecuta y devuelve filas)
--
-- La primera consulta prueba la regla con casos concretos: el de
-- Sebastián debe dar 'a01714719', y un correo genérico debe dar
-- NULL. La segunda cuenta cómo quedaron las cuentas existentes.
-- ============================================================
SELECT 'a01714719@tec.mx'      AS correo, public.student_id_for_email('a01714719@tec.mx')      AS matricula
UNION ALL
SELECT 'A01714719@TEC.MX',              public.student_id_for_email('A01714719@TEC.MX')
UNION ALL
SELECT 'pepe.lopez@gmail.com',          public.student_id_for_email('pepe.lopez@gmail.com')
UNION ALL
SELECT 'alguien@unam.mx',               public.student_id_for_email('alguien@unam.mx');

SELECT count(*) FILTER (WHERE student_id IS NOT NULL) AS con_matricula,
       count(*) FILTER (WHERE student_id IS NULL)     AS sin_matricula,
       count(*)                                        AS total
FROM   public.profiles;

-- >>> 20260914000000_chat-editar-borrar-orden.sql <<<
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

-- >>> 20260915000000_catalogo-universidades.sql <<<
-- ============================================================
-- Catalogo de universidades y campus
--
-- Hasta aqui cada fila de `institutions` era a la vez universidad, campus
-- y comunidad, con sus dominios de correo pegados. Eso aguantaba una sola
-- universidad con un solo campus. Con los cuatro campus del Tec deja de
-- aguantar: los cuatro comparten tec.mx, asi que el dominio no dice el
-- campus, y el alta los habria metido a todos en uno cualquiera.
--
-- Queda asi:
--   universities  -> pais, nombre, nombre corto, DOMINIOS, activa
--   institutions  -> el campus (y la comunidad): pertenece a una
--                    universidad, con ciudad, nombre de campus y centro
--                    del mapa. profiles.campus_id sigue apuntando aqui.
--
-- Decisiones de Sebastian (2026-09-15):
--   * Correo de una universidad con varios campus: el servidor verifica la
--     universidad y la persona elige el campus, que la base solo acepta si
--     es de esa universidad.
--   * campus_id se elige UNA vez desde la app. Cambiarlo despues es cosa
--     del panel. Cierra un hueco que ya existia: la app podia moverse de
--     comunidad cuando quisiera y conservar la insignia de verificado.
--   * Cada campus sigue siendo su propia comunidad (same_institution no
--     cambia): Tec Guadalajara no ve a Tec Queretaro.
--   * Las 16 universidades mexicanas sembradas en 20260830 NO se tocan:
--     siguen activas y siguen dando alta por dominio. Solo no salen en el
--     selector, porque no pertenecen a ninguna universidad del catalogo.
--
-- No se reasigna ningun perfil. Los 28 de Tec Queretaro conservan su fila,
-- su id y su verificacion.
--
-- ASCII puro (nombres con U&'...'), porque se pega en el SQL Editor y con
-- acentos ya salio con mojibake. Idempotente: se puede pegar dos veces.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Universidades
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.universities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL,
  name          text NOT NULL,
  short_name    text NOT NULL,
  -- ISO 3166-1 alfa-2: la app lo agrupa y lo traduce con Intl.
  country_code  text NOT NULL,
  email_domains text[] NOT NULL DEFAULT '{}',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT universities_slug_key UNIQUE (slug),
  CONSTRAINT universities_country_code_check CHECK (country_code ~ '^[A-Z]{2}$')
);

ALTER TABLE public.universities ENABLE ROW LEVEL SECURITY;

-- Supabase suele darlo por defecto a las tablas nuevas de public, pero no
-- se deja a la suerte: sin esto el guardia del paso 7 fallaria al leerla.
GRANT SELECT ON public.universities TO authenticated;

-- El catalogo es publico para quien ya inicio sesion, igual que
-- "Anyone can view institutions". Escribir, solo desde el panel.
DROP POLICY IF EXISTS "Anyone can view universities" ON public.universities;
CREATE POLICY "Anyone can view universities"
  ON public.universities FOR SELECT TO authenticated USING (true);

-- Mismo normalizador que institutions: minusculas y sin espacios, para
-- que la comparacion exacta con `= ANY (email_domains)` sea fiable.
DROP TRIGGER IF EXISTS trg_normalize_university_domains ON public.universities;
CREATE TRIGGER trg_normalize_university_domains
  BEFORE INSERT OR UPDATE ON public.universities
  FOR EACH ROW EXECUTE FUNCTION public.normalize_institution_domains();


-- ------------------------------------------------------------
-- 2. El campus sabe de que universidad es
--
-- Todas nulables: las 16 filas antiguas no pertenecen a ninguna
-- universidad del catalogo y se quedan exactamente como estaban.
-- ------------------------------------------------------------
ALTER TABLE public.institutions
  ADD COLUMN IF NOT EXISTS university_id uuid REFERENCES public.universities(id),
  ADD COLUMN IF NOT EXISTS campus_name   text,
  ADD COLUMN IF NOT EXISTS city          text,
  ADD COLUMN IF NOT EXISTS short_name    text;

-- Un mismo campus no puede estar dos veces en una universidad. Las que no
-- tienen campus (una sola sede) cuentan como campus '' para esto.
CREATE UNIQUE INDEX IF NOT EXISTS institutions_university_campus_key
  ON public.institutions (university_id, coalesce(campus_name, ''))
  WHERE university_id IS NOT NULL;


-- ------------------------------------------------------------
-- 3. Siembra de universidades
--
-- Dominios comprobados en fuentes oficiales el 2026-09-15:
--   tec.mx            alumnos del Tec (matricula@tec.mx).
--   exatec.mx,
--   itesm.mx          YA estaban configurados para el Tec; se conservan
--                     para no dejar sin verificar a nadie que entre con
--                     ellos, pero no se pudieron confirmar en una fuente
--                     oficial (los egresados usan exatec.tec.mx).
--   fsu.edu           its.fsu.edu (correo de estudiantes).
--   purdue.edu        it.purdue.edu (cuenta de carrera).
--   u.icesi.edu.co    estudiantes, egresados y catedra (icesi.edu.co).
--   icesi.edu.co      personal administrativo (icesi.edu.co).
--   javeriana.edu.co  sede Bogota (javeriana.edu.co). Javeriana Cali usa
--                     javerianacali.edu.co y NO esta incluida.
--   CESA              sin dominio: ninguna fuente oficial dice cual usan
--                     los estudiantes. Eligen a mano y quedan sin verificar.
--
-- Comparacion EXACTA de dominio: fsu.edu no acepta evil-fsu.edu ni
-- fsu.edu.co, y un subdominio solo vale si esta listado (u.icesi.edu.co).
--
-- ON CONFLICT actualiza nombre y pais pero NO los dominios: si alguien los
-- corrige a mano en el panel, re-ejecutar esto no los pisa.
-- ------------------------------------------------------------
INSERT INTO public.universities (slug, name, short_name, country_code, email_domains) VALUES
  ('tec',           U&'Tecnol\00F3gico de Monterrey',                      'Tec',       'MX', ARRAY['tec.mx', 'exatec.mx', 'itesm.mx']),
  ('florida-state', 'Florida State University',                             'FSU',       'US', ARRAY['fsu.edu']),
  ('purdue',        'Purdue University',                                    'Purdue',    'US', ARRAY['purdue.edu']),
  ('icesi',         'Universidad Icesi',                                    'Icesi',     'CO', ARRAY['u.icesi.edu.co', 'icesi.edu.co']),
  ('javeriana',     'Pontificia Universidad Javeriana',                     'Javeriana', 'CO', ARRAY['javeriana.edu.co']),
  ('cesa',          'Colegio de Estudios Superiores de Administraci' || U&'\00F3n', 'CESA', 'CO', ARRAY[]::text[])
ON CONFLICT (slug) DO UPDATE
  SET name         = EXCLUDED.name,
      short_name   = EXCLUDED.short_name,
      country_code = EXCLUDED.country_code;


-- ------------------------------------------------------------
-- 4. Campus
--
-- Tec Queretaro es la fila que ya existe: se renombra su slug al formato
-- legible y se conserva su id, sus coordenadas y sus 28 perfiles.
-- ------------------------------------------------------------
UPDATE public.institutions
SET slug = 'tec-queretaro'
WHERE slug = 'tec-mty-qro'
  AND NOT EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'tec-queretaro');

-- Coordenadas: Wikipedia (fichas de cada campus). CESA no tiene; va la de
-- su direccion (Carrera 6 No. 34-51, La Merced, Bogota) APROXIMADA. Solo
-- decide donde abre el mapa.
--
-- Los dominios de estos campus quedan vacios: viven en la universidad.
-- Tec Queretaro tenia los del Tec; sin vaciarlos, el alta seguiria
-- mandando a todo @tec.mx a Queretaro.
--
-- ON CONFLICT no pisa lat/lng de filas que ya existian (Queretaro).
INSERT INTO public.institutions (slug, name, university_id, campus_name, city, short_name, email_domains, lat, lng)
SELECT v.slug, v.name, u.id, v.campus_name, v.city, v.short_name, '{}'::text[], v.lat, v.lng
FROM (VALUES
  ('tec-queretaro',        'tec',           U&'Tecnol\00F3gico de Monterrey, Campus Quer\00E9taro',        U&'Quer\00E9taro',        U&'Quer\00E9taro',        'Tec QRO',   20.6134,     -100.4063),
  ('tec-guadalajara',      'tec',           U&'Tecnol\00F3gico de Monterrey, Campus Guadalajara',          'Guadalajara',             'Zapopan',                 'Tec GDL',   20.73504,    -103.45488),
  ('tec-monterrey',        'tec',           U&'Tecnol\00F3gico de Monterrey, Campus Monterrey',            'Monterrey',               'Monterrey',               'Tec MTY',   25.651435,   -100.290686),
  ('tec-ciudad-de-mexico', 'tec',           U&'Tecnol\00F3gico de Monterrey, Campus Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', 'Tec CCM',   19.284056,   -99.135926),
  ('florida-state',        'florida-state', 'Florida State University',                                   NULL,                      'Tallahassee',             'FSU',       30.442,      -84.298),
  ('purdue',               'purdue',        'Purdue University',                                          NULL,                      'West Lafayette',          'Purdue',    40.42500,    -86.92306),
  ('icesi',                'icesi',         'Universidad Icesi',                                          NULL,                      'Cali',                    'Icesi',     3.341571,    -76.530198),
  ('javeriana',            'javeriana',     'Pontificia Universidad Javeriana',                           NULL,                      U&'Bogot\00E1',            'Javeriana', 4.62894444,  -74.06485),
  ('cesa',                 'cesa',          'CESA ' || U&'\2014' || ' Colegio de Estudios Superiores de Administraci' || U&'\00F3n', NULL, U&'Bogot\00E1', 'CESA', 4.6190, -74.0670)
) AS v(slug, university_slug, name, campus_name, city, short_name, lat, lng)
JOIN public.universities u ON u.slug = v.university_slug
ON CONFLICT (slug) DO UPDATE
  SET name          = EXCLUDED.name,
      university_id = EXCLUDED.university_id,
      campus_name   = EXCLUDED.campus_name,
      city          = EXCLUDED.city,
      short_name    = EXCLUDED.short_name,
      email_domains = '{}';


-- ------------------------------------------------------------
-- 5. Del correo a la universidad y al campus
--
-- email_domain(): lo que va despues de la ULTIMA @, recortado y en
-- minusculas. Nunca "contiene": se compara el dominio entero.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.email_domain(_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT nullif(lower(btrim(substring(btrim(coalesce(_email, '')) FROM '@([^@]+)$'))), '');
$$;

REVOKE EXECUTE ON FUNCTION public.email_domain(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.email_domain(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.university_for_email(_email text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id
  FROM public.universities u
  WHERE u.is_active
    AND public.email_domain(_email) = ANY (u.email_domains)
  ORDER BY u.slug
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.university_for_email(text) FROM PUBLIC, anon, authenticated;

-- El campus que se puede asignar SOLO por el correo:
--   * universidad del catalogo con un unico campus activo -> ese campus;
--   * universidad con varios campus (el Tec) -> ninguno: lo elige la persona;
--   * dominio de una de las filas antiguas (UNAM...) -> esa fila, como antes.
CREATE OR REPLACE FUNCTION public.institution_for_email(_email text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH uni AS (
    SELECT public.university_for_email(_email) AS id
  ), campus AS (
    SELECT i.id
    FROM public.institutions i, uni
    WHERE i.university_id = uni.id AND i.is_active
  )
  SELECT CASE
    WHEN (SELECT id FROM uni) IS NOT NULL THEN
      CASE WHEN (SELECT count(*) FROM campus) = 1 THEN (SELECT id FROM campus) END
    ELSE (
      SELECT i.id
      FROM public.institutions i
      WHERE i.is_active
        AND public.email_domain(_email) = ANY (i.email_domains)
      ORDER BY i.slug
      LIMIT 1
    )
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.institution_for_email(text) FROM PUBLIC, anon, authenticated;

-- La matricula sale de cualquier correo acreditado, tambien del de una
-- universidad con varios campus (antes dependia de tener campus asignado).
CREATE OR REPLACE FUNCTION public.student_id_for_email(_email text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN _email IS NULL THEN NULL
    WHEN public.university_for_email(_email) IS NULL
     AND public.institution_for_email(_email) IS NULL THEN NULL
    ELSE lower(btrim(split_part(_email, '@', 1)))
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.student_id_for_email(text) FROM PUBLIC, anon, authenticated;

-- La universidad acreditada por el correo de QUIEN LLAMA. Lee auth.users
-- (por eso DEFINER) pero solo la fila de auth.uid(): no sirve para
-- preguntar por el correo de otro.
CREATE OR REPLACE FUNCTION public.my_email_university()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.university_for_email(u.email)
  FROM auth.users u
  WHERE u.id = auth.uid();
$$;

REVOKE EXECUTE ON FUNCTION public.my_email_university() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.my_email_university() TO authenticated;


-- ------------------------------------------------------------
-- 6. El alta
--
-- Igual que en 20260907000000_matricula.sql; lo que cambia esta dentro de
-- institution_for_email. Se reescribe para que esta migracion no dependa
-- del orden en que se aplicaron las anteriores.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_institution uuid;
BEGIN
  v_institution := public.institution_for_email(NEW.email);

  INSERT INTO public.profiles (id, email, campus_id, institution_verified, student_id)
  VALUES (
    NEW.id,
    NEW.email,
    v_institution,
    v_institution IS NOT NULL,
    public.student_id_for_email(NEW.email)
  );

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 7. Elegir campus desde la app
--
-- Solo aplica al rol `authenticated` (la app); el panel y las funciones
-- del servidor pasan. Reglas:
--   * Si ya tenia campus, no se cambia (CAMPUS_LOCKED).
--   * Solo campus activos del catalogo (CAMPUS_NOT_AVAILABLE). Las filas
--     antiguas sin universidad no se pueden elegir a mano.
--   * Con correo de una universidad, solo sus campus (CAMPUS_NOT_ALLOWED),
--     y entonces queda verificado. Con correo generico, sin verificar.
--
-- SECURITY INVOKER a proposito: necesita current_user = 'authenticated'
-- para saber quien escribe. Lo que necesita de auth.users lo pide a
-- my_email_university().
--
-- El nombre del disparador importa: los BEFORE se ejecutan en orden
-- alfabetico, y este tiene que ir DESPUES de trg_prevent_score_tampering,
-- que rechaza que la app toque institution_verified. Asi el guardia ve lo
-- que mando la app, y la verificacion la pone el servidor despues.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_profile_campus()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_target_university uuid;
  v_email_university  uuid;
BEGIN
  IF NEW.campus_id IS NOT DISTINCT FROM OLD.campus_id
     OR current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF OLD.campus_id IS NOT NULL THEN
    RAISE EXCEPTION 'CAMPUS_LOCKED' USING ERRCODE = '42501';
  END IF;

  SELECT i.university_id INTO v_target_university
  FROM public.institutions i
  JOIN public.universities u ON u.id = i.university_id
  WHERE i.id = NEW.campus_id
    AND i.is_active
    AND u.is_active;

  IF v_target_university IS NULL THEN
    RAISE EXCEPTION 'CAMPUS_NOT_AVAILABLE' USING ERRCODE = '42501';
  END IF;

  v_email_university := public.my_email_university();

  IF v_email_university IS NOT NULL AND v_email_university <> v_target_university THEN
    RAISE EXCEPTION 'CAMPUS_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;

  NEW.institution_verified := v_email_university IS NOT NULL;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_profile_campus() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_set_profile_campus ON public.profiles;
CREATE TRIGGER trg_set_profile_campus
  BEFORE UPDATE OF campus_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_profile_campus();


-- ------------------------------------------------------------
-- 8. Lo que ve el selector del alta
--
-- Solo campus del catalogo. Si el correo es de una universidad, solo los
-- suyos: a quien entra con @tec.mx no se le ofrece Purdue, que la base le
-- rechazaria de todos modos.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.campus_options()
RETURNS TABLE (
  id                    uuid,
  slug                  text,
  name                  text,
  campus_name           text,
  city                  text,
  short_name            text,
  university_slug       text,
  university_name       text,
  university_short_name text,
  country_code          text,
  email_verified        boolean
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH mine AS (SELECT public.my_email_university() AS id)
  SELECT i.id, i.slug, i.name, i.campus_name, i.city, i.short_name,
         u.slug, u.name, u.short_name, u.country_code,
         mine.id IS NOT NULL
  FROM public.institutions i
  JOIN public.universities u ON u.id = i.university_id
  CROSS JOIN mine
  WHERE i.is_active
    AND u.is_active
    AND (mine.id IS NULL OR u.id = mine.id)
  ORDER BY u.name, i.campus_name NULLS FIRST, i.slug;
$$;

REVOKE EXECUTE ON FUNCTION public.campus_options() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.campus_options() TO authenticated;

COMMIT;


-- ============================================================
-- Comprobacion
--   1. El catalogo: deben salir 9 campus en 6 universidades.
--   2. Tec Queretaro conserva sus perfiles.
--   3. La regla de dominios con casos concretos.
-- ============================================================
SELECT u.country_code, u.short_name AS universidad, i.slug, i.campus_name, i.city,
       (SELECT count(*) FROM public.profiles p WHERE p.campus_id = i.id) AS perfiles
FROM public.institutions i
JOIN public.universities u ON u.id = i.university_id
ORDER BY u.country_code, u.name, i.campus_name;

SELECT correo,
       (SELECT slug FROM public.universities WHERE id = public.university_for_email(correo)) AS universidad,
       (SELECT slug FROM public.institutions WHERE id = public.institution_for_email(correo)) AS campus
FROM (VALUES
  ('a01714719@tec.mx'), ('A01714719@TEC.MX'), ('x@evil-tec.mx'), ('x@tec.mx.evil.com'),
  ('x@u.icesi.edu.co'), ('x@purdue.edu'), ('x@purdue.edu.co'), ('x@unam.mx'), ('x@gmail.com')
) AS t(correo);

-- >>> 20260917000000_verificacion-institucional.sql <<<
-- ============================================================
-- Verificacion institucional y catalogo ampliado (esquema)
--
-- Modelo, adaptado a lo que ya existe en produccion (no se renombra nada
-- porque la version publicada en App Store lee `institutions` y la vista
-- `campuses`):
--
--   universities                  la institucion canonica (Tec, UNAM, Purdue...)
--   institutions                  sus campus; profiles.campus_id y
--                                 events.institution_id apuntan aqui
--   institution_email_domains     dominios con evidencia; solo los confirmados,
--                                 activos y habilitados verifican
--   email_domain_blocklist        correos personales y relays (Apple, Gmail...)
--   profile_affiliations          la afiliacion de cada perfil y su estado
--   institution_verification_challenges   codigos de un solo uso (solo hash)
--   institution_verification_events       auditoria
--   institution_requests          "agreguen mi institucion" y revisiones
--
-- Reglas que no cambian: cada campus es su propia comunidad
-- (same_institution), el campus se elige una vez desde la app, no se borra
-- ni se cambia el id de ninguna institucion y no se reasigna ningun perfil.
--
-- Lo que cambia para cuentas nuevas: la verificacion ya no la da el alta con
-- solo mirar el dominio (se daba incluso sin confirmar el correo). La da un
-- correo CONFIRMADO de un dominio con evidencia oficial, o un codigo enviado
-- al correo institucional. Las cuentas ya verificadas se conservan como
-- `legacy_*`; la unica verificada con el correo sin confirmar queda pendiente.
--
-- Idempotente. ASCII puro para poder pegarla en el SQL Editor.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 0. Extensiones
-- ------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Misma definicion que en 20260916000000_buscar-personas.sql: la que se
-- aplique primero la crea y la otra la deja igual.
CREATE OR REPLACE FUNCTION public.search_normalize(_t text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT btrim(regexp_replace(
    lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(_t, ''))),
    '\s+', ' ', 'g'
  ));
$$;
REVOKE EXECUTE ON FUNCTION public.search_normalize(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.search_normalize(text) TO authenticated;

-- ------------------------------------------------------------
-- 1. universities: datos de institucion
-- ------------------------------------------------------------
ALTER TABLE public.universities
  ADD COLUMN IF NOT EXISTS institution_type  text NOT NULL DEFAULT 'university',
  ADD COLUMN IF NOT EXISTS control           text,
  ADD COLUMN IF NOT EXISTS state_region      text,
  ADD COLUMN IF NOT EXISTS city              text,
  ADD COLUMN IF NOT EXISTS website_url       text,
  ADD COLUMN IF NOT EXISTS logo_url          text,
  ADD COLUMN IF NOT EXISTS aliases           text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS source_name       text,
  ADD COLUMN IF NOT EXISTS source_ref        text,
  ADD COLUMN IF NOT EXISTS source_url        text,
  ADD COLUMN IF NOT EXISTS source_checked_at date,
  ADD COLUMN IF NOT EXISTS search_document   text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS updated_at        timestamptz NOT NULL DEFAULT now();

-- Muchas instituciones del catalogo no tienen una abreviatura oficial: mejor
-- vacia que inventada.
ALTER TABLE public.universities ALTER COLUMN short_name DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'universities_institution_type_check') THEN
    ALTER TABLE public.universities ADD CONSTRAINT universities_institution_type_check CHECK (
      institution_type IN ('university', 'technological_university', 'polytechnic_university',
        'technological_institute', 'university_institution', 'technological_institution',
        'technical_institution', 'college', 'community_college', 'school', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'universities_control_check') THEN
    ALTER TABLE public.universities ADD CONSTRAINT universities_control_check
      CHECK (control IS NULL OR control IN ('public', 'private'));
  END IF;
END $$;

-- La clave estable del importador: pais + slug canonico.
CREATE UNIQUE INDEX IF NOT EXISTS universities_country_slug_key
  ON public.universities (country_code, slug);
CREATE UNIQUE INDEX IF NOT EXISTS universities_source_key
  ON public.universities (country_code, source_name, source_ref)
  WHERE source_ref IS NOT NULL;

-- ------------------------------------------------------------
-- 2. institutions (campus)
-- ------------------------------------------------------------
ALTER TABLE public.institutions
  ADD COLUMN IF NOT EXISTS campus_slug     text,
  ADD COLUMN IF NOT EXISTS state_region    text,
  ADD COLUMN IF NOT EXISTS search_document text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS updated_at      timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS institutions_university_campus_slug_key
  ON public.institutions (university_id, campus_slug)
  WHERE university_id IS NOT NULL AND campus_slug IS NOT NULL;

-- Los nueve campus del catalogo anterior: el slug de campus sale del suyo.
UPDATE public.institutions i
SET campus_slug = CASE
      WHEN i.campus_name IS NULL THEN 'principal'
      ELSE regexp_replace(i.slug, '^' || u.slug || '-', '')
    END
FROM public.universities u
WHERE u.id = i.university_id
  AND i.campus_slug IS NULL;

-- Texto de busqueda: nombre, abreviatura, alias, ciudad y estado, sin
-- acentos. Columna mantenida por disparador y no expresion indexada porque
-- array_to_string no es IMMUTABLE.
CREATE OR REPLACE FUNCTION public.universities_search_document()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.search_document := public.search_normalize(concat_ws(' ',
    NEW.name, NEW.short_name, array_to_string(NEW.aliases, ' '), NEW.city, NEW.state_region));
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_universities_search_document ON public.universities;
CREATE TRIGGER trg_universities_search_document
  BEFORE INSERT OR UPDATE ON public.universities
  FOR EACH ROW EXECUTE FUNCTION public.universities_search_document();

CREATE OR REPLACE FUNCTION public.institutions_search_document()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.search_document := public.search_normalize(concat_ws(' ',
    NEW.name, NEW.campus_name, NEW.short_name, NEW.city, NEW.state_region));
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_institutions_search_document ON public.institutions;
CREATE TRIGGER trg_institutions_search_document
  BEFORE INSERT OR UPDATE ON public.institutions
  FOR EACH ROW EXECUTE FUNCTION public.institutions_search_document();

UPDATE public.universities SET search_document = search_document;
UPDATE public.institutions SET search_document = search_document;

CREATE INDEX IF NOT EXISTS universities_search_trgm_idx
  ON public.universities USING gin (search_document extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS institutions_search_trgm_idx
  ON public.institutions USING gin (search_document extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS institutions_university_id_idx
  ON public.institutions (university_id);

-- ------------------------------------------------------------
-- 3. Dominios de correo
--
-- Un dominio de sitio web no es un dominio de correo estudiantil. Solo
-- verifica un dominio con evidencia oficial de que se entrega a estudiantes
-- o a afiliados vigentes; la base lo impone con un CHECK, no solo el
-- importador. Se compara el hostname exacto: un subdominio es otra fila.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.institution_email_domains (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain              text NOT NULL,
  university_id       uuid NOT NULL REFERENCES public.universities(id),
  campus_id           uuid REFERENCES public.institutions(id),
  audience            text NOT NULL DEFAULT 'unknown'
    CHECK (audience IN ('student', 'faculty_staff', 'all_affiliates', 'alumni', 'unknown')),
  verification_enabled boolean NOT NULL DEFAULT false,
  confidence          text NOT NULL DEFAULT 'unconfirmed'
    CHECK (confidence IN ('confirmed', 'probable', 'unconfirmed')),
  official_source_url text,
  source_title        text,
  last_verified_at    date,
  notes               text,
  is_active           boolean NOT NULL DEFAULT true,
  -- Solo si hay evidencia de que la parte local es la matricula (a01234567@tec.mx).
  student_id_pattern  text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT institution_email_domains_domain_key UNIQUE (domain),
  -- ASCII (un IDN se guarda en punycode, xn--), minusculas, al menos un punto.
  CONSTRAINT institution_email_domains_domain_format CHECK (
    domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
    AND length(domain) <= 253),
  CONSTRAINT institution_email_domains_verification_rule CHECK (
    NOT verification_enabled OR (
      confidence = 'confirmed'
      AND is_active
      AND audience IN ('student', 'all_affiliates')
      AND official_source_url IS NOT NULL
      AND last_verified_at IS NOT NULL))
);
ALTER TABLE public.institution_email_domains ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.institution_email_domains FROM PUBLIC, anon, authenticated;

-- Correos personales y relays: nunca pueden ser de una institucion.
CREATE TABLE IF NOT EXISTS public.email_domain_blocklist (
  domain text PRIMARY KEY,
  kind   text NOT NULL CHECK (kind IN ('apple_relay', 'personal', 'disposable')),
  notes  text
);
ALTER TABLE public.email_domain_blocklist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_domain_blocklist FROM PUBLIC, anon, authenticated;

INSERT INTO public.email_domain_blocklist (domain, kind, notes) VALUES
  ('privaterelay.appleid.com', 'apple_relay', 'Sign in with Apple, Hide My Email (direcciones existentes)'),
  ('private.icloud.com',       'apple_relay', 'Sign in with Apple, Hide My Email (direcciones nuevas desde 2026)'),
  ('icloud.com', 'personal', NULL), ('me.com', 'personal', NULL), ('mac.com', 'personal', NULL),
  ('gmail.com', 'personal', NULL), ('googlemail.com', 'personal', NULL),
  ('outlook.com', 'personal', NULL), ('hotmail.com', 'personal', NULL), ('live.com', 'personal', NULL),
  ('msn.com', 'personal', NULL), ('outlook.es', 'personal', NULL), ('hotmail.es', 'personal', NULL),
  ('live.com.mx', 'personal', NULL), ('hotmail.com.mx', 'personal', NULL),
  ('yahoo.com', 'personal', NULL), ('yahoo.com.mx', 'personal', NULL), ('yahoo.es', 'personal', NULL),
  ('ymail.com', 'personal', NULL), ('aol.com', 'personal', NULL), ('proton.me', 'personal', NULL),
  ('protonmail.com', 'personal', NULL), ('gmx.com', 'personal', NULL), ('zoho.com', 'personal', NULL)
ON CONFLICT (domain) DO NOTHING;

CREATE OR REPLACE FUNCTION public.guard_institution_email_domain()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.domain := lower(rtrim(btrim(NEW.domain), '.'));
  IF EXISTS (SELECT 1 FROM public.email_domain_blocklist b WHERE b.domain = NEW.domain) THEN
    RAISE EXCEPTION 'DOMAIN_IS_PERSONAL: %', NEW.domain;
  END IF;
  IF NEW.campus_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.institutions i WHERE i.id = NEW.campus_id AND i.university_id = NEW.university_id
  ) THEN
    RAISE EXCEPTION 'DOMAIN_CAMPUS_MISMATCH: %', NEW.domain;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_institution_email_domain ON public.institution_email_domains;
CREATE TRIGGER trg_guard_institution_email_domain
  BEFORE INSERT OR UPDATE ON public.institution_email_domains
  FOR EACH ROW EXECUTE FUNCTION public.guard_institution_email_domain();

-- Los dominios que ya estaban en las universidades del catalogo pasan a la
-- tabla SIN verificar. La migracion de datos habilita los que tienen evidencia.
INSERT INTO public.institution_email_domains (domain, university_id, notes)
SELECT DISTINCT lower(d), u.id, 'Migrado de universities.email_domains (20260915); sin evidencia revisada'
FROM public.universities u, unnest(u.email_domains) AS d
WHERE btrim(d) <> ''
ON CONFLICT (domain) DO NOTHING;

-- ------------------------------------------------------------
-- 4. Secreto para los hash (pimienta)
--
-- Correos y codigos se guardan como HMAC-SHA256 con una clave que vive en
-- Vault, no en el repositorio. Sin ella, un volcado de la tabla no permite
-- probar correos por diccionario.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'institution_email_pepper') THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'institution_email_pepper',
      'HMAC para correos institucionales y codigos de verificacion'
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.institution_hmac(_value text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pepper text;
BEGIN
  SELECT decrypted_secret INTO v_pepper
  FROM vault.decrypted_secrets
  WHERE name = 'institution_email_pepper'
  LIMIT 1;
  IF v_pepper IS NULL THEN
    RAISE EXCEPTION 'VERIFICATION_NOT_CONFIGURED';
  END IF;
  RETURN encode(extensions.hmac(convert_to(_value, 'UTF8'), convert_to(v_pepper, 'UTF8'), 'sha256'), 'hex');
END;
$$;
REVOKE EXECUTE ON FUNCTION public.institution_hmac(text) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 5. Correo: normalizar, enmascarar, resolver
-- ------------------------------------------------------------
-- NULL si no parece un correo. No acepta caracteres fuera de ASCII en el
-- dominio: el cliente y la Edge Function lo convierten a punycode antes.
CREATE OR REPLACE FUNCTION public.normalize_email_address(_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN e ~ '^[^@\s]{1,64}@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
     AND length(e) <= 254 THEN e
  END
  FROM (SELECT lower(rtrim(btrim(coalesce(_email, '')), '.')) AS e) x;
$$;
REVOKE EXECUTE ON FUNCTION public.normalize_email_address(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.normalize_email_address(text) TO authenticated;

-- s***@tec.mx
CREATE OR REPLACE FUNCTION public.mask_email(_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE WHEN _email LIKE '%@%'
    THEN left(split_part(_email, '@', 1), 1) || '***@' || split_part(_email, '@', 2)
  END;
$$;
REVOKE EXECUTE ON FUNCTION public.mask_email(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.mask_email(text) TO authenticated;

-- El dominio (ya normalizado) solo si puede VERIFICAR: activo, habilitado,
-- confirmado, de estudiantes o afiliados, universidad activa y no personal.
CREATE OR REPLACE FUNCTION public.verifiable_email_domain(_email text)
RETURNS public.institution_email_domains
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT d.*
  FROM public.institution_email_domains d
  JOIN public.universities u ON u.id = d.university_id AND u.is_active
  WHERE d.domain = public.email_domain(public.normalize_email_address(_email))
    AND d.is_active
    AND d.verification_enabled
    AND d.confidence = 'confirmed'
    AND d.audience IN ('student', 'all_affiliates')
    AND NOT EXISTS (SELECT 1 FROM public.email_domain_blocklist b WHERE b.domain = d.domain)
  LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION public.verifiable_email_domain(text) FROM PUBLIC, anon, authenticated;

-- Las viejas funciones de 20260915 pasan a usar la tabla de dominios, para
-- que no quede un segundo camino que verifique con dominios sin evidencia.
CREATE OR REPLACE FUNCTION public.university_for_email(_email text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (public.verifiable_email_domain(_email)).university_id;
$$;
REVOKE EXECUTE ON FUNCTION public.university_for_email(text) FROM PUBLIC, anon, authenticated;

-- Campus que el correo determina SIN ambiguedad: el del dominio, o el unico
-- campus activo de la universidad. Nunca uno cualquiera de varios.
CREATE OR REPLACE FUNCTION public.institution_for_email(_email text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH d AS (SELECT * FROM public.verifiable_email_domain(_email))
  SELECT CASE
    WHEN (SELECT campus_id FROM d) IS NOT NULL THEN (SELECT campus_id FROM d)
    WHEN (SELECT university_id FROM d) IS NULL THEN NULL
    WHEN (SELECT count(*) FROM public.institutions i
          WHERE i.university_id = (SELECT university_id FROM d) AND i.is_active) = 1
      THEN (SELECT i.id FROM public.institutions i
            WHERE i.university_id = (SELECT university_id FROM d) AND i.is_active)
  END;
$$;
REVOKE EXECUTE ON FUNCTION public.institution_for_email(text) FROM PUBLIC, anon, authenticated;

-- Matricula solo cuando el dominio documenta el formato y la parte local lo cumple.
CREATE OR REPLACE FUNCTION public.student_id_for_email(_email text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN d.student_id_pattern IS NOT NULL
     AND split_part(public.normalize_email_address(_email), '@', 1) ~ d.student_id_pattern
    THEN split_part(public.normalize_email_address(_email), '@', 1)
  END
  FROM public.verifiable_email_domain(_email) d;
$$;
REVOKE EXECUTE ON FUNCTION public.student_id_for_email(text) FROM PUBLIC, anon, authenticated;

-- La universidad acreditada por el correo de acceso de quien llama, solo si
-- ese correo esta CONFIRMADO por el proveedor.
CREATE OR REPLACE FUNCTION public.my_email_university()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.university_for_email(u.email)
  FROM auth.users u
  WHERE u.id = auth.uid()
    AND u.email_confirmed_at IS NOT NULL;
$$;
REVOKE EXECUTE ON FUNCTION public.my_email_university() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.my_email_university() TO authenticated;

-- ------------------------------------------------------------
-- 6. Afiliaciones
--
-- Una fila por perfil: la afiliacion vigente. El historial va a la tabla de
-- auditoria. El correo institucional NO se guarda en claro: hash con
-- pimienta (para la unicidad) y version enmascarada (para mostrarla).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profile_affiliations (
  user_id                  uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  university_id            uuid REFERENCES public.universities(id),
  campus_id                uuid REFERENCES public.institutions(id),
  declared_role            text NOT NULL DEFAULT 'student'
    CHECK (declared_role IN ('student', 'faculty_staff', 'other')),
  status                   text NOT NULL DEFAULT 'unverified'
    CHECK (status IN ('unverified', 'pending_email', 'verified', 'expired', 'revoked', 'manual_review')),
  institutional_email_hash text,
  institutional_email_masked text,
  email_domain_id          uuid REFERENCES public.institution_email_domains(id),
  verification_method      text
    CHECK (verification_method IS NULL OR verification_method IN (
      'institutional_email_otp', 'auth_email_domain', 'legacy_auth_email', 'legacy_manual', 'manual_review')),
  verified_at              timestamptz,
  status_reason            text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_affiliations_verified_has_university CHECK (
    status <> 'verified' OR (university_id IS NOT NULL AND verified_at IS NOT NULL AND verification_method IS NOT NULL))
);
ALTER TABLE public.profile_affiliations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profile_affiliations FROM PUBLIC, anon, authenticated;

-- Un correo institucional verifica UNA cuenta. Se aplica en la base, asi que
-- dos confirmaciones simultaneas no pueden ganar las dos.
CREATE UNIQUE INDEX IF NOT EXISTS profile_affiliations_verified_email_key
  ON public.profile_affiliations (institutional_email_hash)
  WHERE status = 'verified' AND institutional_email_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS profile_affiliations_domain_idx
  ON public.profile_affiliations (email_domain_id) WHERE status = 'verified';

-- profiles.institution_verified sigue existiendo (la lee la app publicada y la
-- vista publica), pero ahora es un reflejo de la afiliacion.
CREATE OR REPLACE FUNCTION public.sync_profile_verified()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  UPDATE public.profiles
  SET institution_verified = (NEW.status = 'verified')
  WHERE id = NEW.user_id
    AND institution_verified IS DISTINCT FROM (NEW.status = 'verified');
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.sync_profile_verified() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_sync_profile_verified ON public.profile_affiliations;
CREATE TRIGGER trg_sync_profile_verified
  BEFORE INSERT OR UPDATE ON public.profile_affiliations
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_verified();

-- ------------------------------------------------------------
-- 7. Desafios y auditoria
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.institution_verification_challenges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  university_id   uuid NOT NULL REFERENCES public.universities(id),
  campus_id       uuid REFERENCES public.institutions(id),
  email_domain_id uuid NOT NULL REFERENCES public.institution_email_domains(id),
  email_hash      text NOT NULL,
  email_masked    text NOT NULL,
  -- Matricula tecleada, si se pidio. Privada: ninguna politica la expone.
  student_id_input text,
  otp_hash        text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'expired', 'revoked', 'locked', 'conflict', 'cancelled')),
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5,
  ip_hash         text,
  expires_at      timestamptz NOT NULL,
  resend_after    timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institution_verification_challenges_user_idx
  ON public.institution_verification_challenges (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS institution_verification_challenges_email_idx
  ON public.institution_verification_challenges (email_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS institution_verification_challenges_ip_idx
  ON public.institution_verification_challenges (ip_hash, created_at DESC) WHERE ip_hash IS NOT NULL;
ALTER TABLE public.institution_verification_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.institution_verification_challenges FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.institution_verification_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  challenge_id uuid,
  event        text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS institution_verification_events_user_idx
  ON public.institution_verification_events (user_id, created_at DESC);
ALTER TABLE public.institution_verification_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.institution_verification_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.log_verification_event(_user uuid, _challenge uuid, _event text, _detail jsonb DEFAULT '{}')
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.institution_verification_events (user_id, challenge_id, event, detail)
  VALUES (_user, _challenge, _event, coalesce(_detail, '{}'));
$$;
REVOKE EXECUTE ON FUNCTION public.log_verification_event(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 8. Solicitudes (agregar institucion, revision manual)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.institution_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('add_institution', 'manual_verification')),
  institution_name text,
  country_code  text CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  city          text,
  website_url   text,
  university_id uuid REFERENCES public.universities(id),
  campus_id     uuid REFERENCES public.institutions(id),
  notes         text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'duplicate')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT institution_requests_lengths CHECK (
    length(coalesce(institution_name, '')) <= 200 AND length(coalesce(city, '')) <= 120
    AND length(coalesce(website_url, '')) <= 300 AND length(coalesce(notes, '')) <= 1000)
);
CREATE INDEX IF NOT EXISTS institution_requests_user_idx ON public.institution_requests (user_id, created_at DESC);
ALTER TABLE public.institution_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.institution_requests FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 9. Verificacion por el correo de ACCESO (Google, correo confirmado)
--
-- Se evalua cuando el proveedor confirma el correo: al crear la cuenta si ya
-- llega confirmado (Google, Apple) o al confirmar despues (correo y
-- contrasena). Un relay de Apple o un Gmail nunca pasan de aqui.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_auth_email_affiliation(_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email     text;
  v_confirmed timestamptz;
  v_domain    public.institution_email_domains;
  v_hash      text;
  v_campus    uuid;
  v_profile_campus uuid;
  v_profile_university uuid;
  v_current   public.profile_affiliations;
BEGIN
  SELECT public.normalize_email_address(u.email), u.email_confirmed_at
  INTO v_email, v_confirmed
  FROM auth.users u WHERE u.id = _user_id;

  SELECT * INTO v_current FROM public.profile_affiliations WHERE user_id = _user_id;

  -- Si la verificacion venia del correo de acceso y ese correo cambio o dejo
  -- de ser verificable, se retira.
  IF v_current.status = 'verified'
     AND v_current.verification_method IN ('auth_email_domain', 'legacy_auth_email')
     AND v_current.institutional_email_hash IS NOT NULL
     AND (v_email IS NULL OR public.institution_hmac(v_email) <> v_current.institutional_email_hash) THEN
    UPDATE public.profile_affiliations
    SET status = 'revoked', status_reason = 'auth_email_changed'
    WHERE user_id = _user_id;
    PERFORM public.log_verification_event(_user_id, NULL, 'revoked', '{"reason":"auth_email_changed"}');
    SELECT * INTO v_current FROM public.profile_affiliations WHERE user_id = _user_id;
  END IF;

  IF v_email IS NULL OR v_confirmed IS NULL THEN
    RETURN 'not_confirmed';
  END IF;

  v_domain := public.verifiable_email_domain(v_email);
  IF v_domain.id IS NULL THEN
    RETURN 'not_institutional';
  END IF;

  IF v_current.status = 'verified' THEN
    RETURN 'already_verified';
  END IF;

  v_hash := public.institution_hmac(v_email);

  SELECT p.campus_id, i.university_id INTO v_profile_campus, v_profile_university
  FROM public.profiles p LEFT JOIN public.institutions i ON i.id = p.campus_id
  WHERE p.id = _user_id;

  v_campus := public.institution_for_email(v_email);

  -- El correo ya verifica otra cuenta: a revision, sin decir cual.
  IF EXISTS (
    SELECT 1 FROM public.profile_affiliations a
    WHERE a.institutional_email_hash = v_hash AND a.status = 'verified' AND a.user_id <> _user_id
  ) THEN
    INSERT INTO public.profile_affiliations (user_id, university_id, status, status_reason, email_domain_id, institutional_email_masked)
    VALUES (_user_id, v_domain.university_id, 'manual_review', 'email_in_use', v_domain.id, public.mask_email(v_email))
    ON CONFLICT (user_id) DO UPDATE SET status = 'manual_review', status_reason = 'email_in_use',
      university_id = EXCLUDED.university_id, email_domain_id = EXCLUDED.email_domain_id,
      institutional_email_masked = EXCLUDED.institutional_email_masked;
    PERFORM public.log_verification_event(_user_id, NULL, 'conflict', '{"method":"auth_email_domain"}');
    RETURN 'manual_review';
  END IF;

  -- Ya pertenece a otra institucion: no se le cambia la comunidad.
  IF v_profile_university IS NOT NULL AND v_profile_university <> v_domain.university_id THEN
    INSERT INTO public.profile_affiliations (user_id, university_id, status, status_reason, email_domain_id, institutional_email_masked)
    VALUES (_user_id, v_domain.university_id, 'manual_review', 'institution_mismatch', v_domain.id, public.mask_email(v_email))
    ON CONFLICT (user_id) DO UPDATE SET status = 'manual_review', status_reason = 'institution_mismatch',
      university_id = EXCLUDED.university_id, email_domain_id = EXCLUDED.email_domain_id,
      institutional_email_masked = EXCLUDED.institutional_email_masked;
    PERFORM public.log_verification_event(_user_id, NULL, 'institution_mismatch', '{"method":"auth_email_domain"}');
    RETURN 'manual_review';
  END IF;

  -- Campus inequivoco y todavia sin campus: se asigna.
  IF v_profile_campus IS NULL AND v_campus IS NOT NULL THEN
    UPDATE public.profiles SET campus_id = v_campus WHERE id = _user_id;
    v_profile_campus := v_campus;
  END IF;

  IF v_profile_campus IS NULL THEN
    -- Varios campus: se sugiere la universidad y la persona elige.
    INSERT INTO public.profile_affiliations (user_id, university_id, status, status_reason, email_domain_id, institutional_email_masked)
    VALUES (_user_id, v_domain.university_id, 'unverified', 'choose_campus', v_domain.id, public.mask_email(v_email))
    ON CONFLICT (user_id) DO UPDATE SET status = 'unverified', status_reason = 'choose_campus',
      university_id = EXCLUDED.university_id, email_domain_id = EXCLUDED.email_domain_id,
      institutional_email_masked = EXCLUDED.institutional_email_masked;
    RETURN 'choose_campus';
  END IF;

  INSERT INTO public.profile_affiliations (
    user_id, university_id, campus_id, status, institutional_email_hash, institutional_email_masked,
    email_domain_id, verification_method, verified_at, status_reason)
  VALUES (_user_id, v_domain.university_id, v_profile_campus, 'verified', v_hash, public.mask_email(v_email),
    v_domain.id, 'auth_email_domain', now(), NULL)
  ON CONFLICT (user_id) DO UPDATE SET
    university_id = EXCLUDED.university_id, campus_id = EXCLUDED.campus_id, status = 'verified',
    institutional_email_hash = EXCLUDED.institutional_email_hash,
    institutional_email_masked = EXCLUDED.institutional_email_masked,
    email_domain_id = EXCLUDED.email_domain_id, verification_method = 'auth_email_domain',
    verified_at = now(), status_reason = NULL;

  UPDATE public.profiles
  SET student_id = public.student_id_for_email(v_email)
  WHERE id = _user_id AND student_id IS NULL AND public.student_id_for_email(v_email) IS NOT NULL;

  PERFORM public.log_verification_event(_user_id, NULL, 'verified', '{"method":"auth_email_domain"}');
  RETURN 'verified';
EXCEPTION WHEN unique_violation THEN
  -- Otra cuenta gano la carrera con el mismo correo.
  UPDATE public.profile_affiliations SET status = 'manual_review', status_reason = 'email_in_use'
  WHERE user_id = _user_id;
  RETURN 'manual_review';
END;
$$;
REVOKE EXECUTE ON FUNCTION public.apply_auth_email_affiliation(uuid) FROM PUBLIC, anon, authenticated;

-- El alta ya NO verifica ni asigna campus por si sola: crea el perfil.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email) VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- AFTER y con nombre posterior a on_auth_user_created: el perfil ya existe.
CREATE OR REPLACE FUNCTION public.on_auth_user_email_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.email_confirmed_at IS DISTINCT FROM OLD.email_confirmed_at
     OR NEW.email IS DISTINCT FROM OLD.email THEN
    PERFORM public.apply_auth_email_affiliation(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.on_auth_user_email_state() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_auth_user_email_state ON auth.users;
CREATE TRIGGER trg_auth_user_email_state
  AFTER INSERT OR UPDATE OF email, email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.on_auth_user_email_state();

-- ------------------------------------------------------------
-- 10. Elegir campus desde la app (reemplaza la de 20260915)
--
--   * Si ya tenia campus, no se cambia (CAMPUS_LOCKED).
--   * Solo campus activos del catalogo (CAMPUS_NOT_AVAILABLE).
--   * Con correo de acceso confirmado y verificable, solo campus de esa
--     universidad (CAMPUS_NOT_ALLOWED); al elegirlo se completa la afiliacion.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_profile_campus()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_target_university uuid;
  v_email_university  uuid;
BEGIN
  IF NEW.campus_id IS NOT DISTINCT FROM OLD.campus_id
     OR current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF OLD.campus_id IS NOT NULL THEN
    RAISE EXCEPTION 'CAMPUS_LOCKED' USING ERRCODE = '42501';
  END IF;

  SELECT i.university_id INTO v_target_university
  FROM public.institutions i
  JOIN public.universities u ON u.id = i.university_id
  WHERE i.id = NEW.campus_id AND i.is_active AND u.is_active;

  IF v_target_university IS NULL THEN
    RAISE EXCEPTION 'CAMPUS_NOT_AVAILABLE' USING ERRCODE = '42501';
  END IF;

  v_email_university := public.my_email_university();
  IF v_email_university IS NOT NULL AND v_email_university <> v_target_university THEN
    RAISE EXCEPTION 'CAMPUS_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.set_profile_campus() FROM PUBLIC, anon, authenticated;

-- Despues de guardar el campus: completar la afiliacion por correo de acceso,
-- o retirarla si un cambio hecho desde el panel la deja en otra institucion.
CREATE OR REPLACE FUNCTION public.after_profile_campus_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_university uuid;
BEGIN
  IF NEW.campus_id IS NOT DISTINCT FROM OLD.campus_id THEN
    RETURN NEW;
  END IF;
  SELECT university_id INTO v_university FROM public.institutions WHERE id = NEW.campus_id;

  UPDATE public.profile_affiliations
  SET status = 'revoked', status_reason = 'institution_changed'
  WHERE user_id = NEW.id
    AND status IN ('verified', 'pending_email')
    AND university_id IS DISTINCT FROM v_university;
  IF FOUND THEN
    PERFORM public.log_verification_event(NEW.id, NULL, 'revoked', '{"reason":"institution_changed"}');
    UPDATE public.institution_verification_challenges SET status = 'revoked'
    WHERE user_id = NEW.id AND status = 'pending';
  END IF;

  UPDATE public.profile_affiliations
  SET campus_id = NEW.campus_id
  WHERE user_id = NEW.id AND status = 'verified' AND university_id = v_university;

  PERFORM public.apply_auth_email_affiliation(NEW.id);
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.after_profile_campus_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_after_profile_campus_change ON public.profiles;
CREATE TRIGGER trg_after_profile_campus_change
  AFTER UPDATE OF campus_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.after_profile_campus_change();

-- ------------------------------------------------------------
-- 11. Verificacion con codigo al correo institucional
--
-- start_: SOLO service_role (la Edge Function, que valida el JWT, manda el
-- correo y nunca guarda el codigo). confirm_: la app, con su sesion.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_institution_verification(
  _user_id       uuid,
  _university_id uuid,
  _campus_id     uuid,
  _email         text,
  _student_id    text DEFAULT NULL,
  _ip_hash       text DEFAULT NULL
)
RETURNS TABLE (status text, challenge_id uuid, code text, email_masked text, expires_at timestamptz, resend_after timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_email   text := public.normalize_email_address(_email);
  v_domain  public.institution_email_domains;
  v_profile_university uuid;
  v_last    public.institution_verification_challenges;
  v_current public.profile_affiliations;
  v_hash    text;
  v_code    text;
  v_id      uuid := gen_random_uuid();
  v_expires timestamptz := now() + interval '10 minutes';
  v_resend  timestamptz := now() + interval '60 seconds';
BEGIN
  IF _user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = _user_id) THEN
    RETURN QUERY SELECT 'NOT_AUTHENTICATED'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_email IS NULL THEN
    RETURN QUERY SELECT 'INVALID_EMAIL'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.email_domain_blocklist b WHERE b.domain = public.email_domain(v_email)) THEN
    RETURN QUERY SELECT 'PERSONAL_EMAIL'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  IF _student_id IS NOT NULL AND (length(btrim(_student_id)) = 0 OR length(_student_id) > 40) THEN
    RETURN QUERY SELECT 'INVALID_STUDENT_ID'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  v_domain := public.verifiable_email_domain(v_email);
  IF v_domain.id IS NULL OR v_domain.university_id <> _university_id THEN
    RETURN QUERY SELECT 'DOMAIN_NOT_VERIFIABLE'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  IF _campus_id IS NOT NULL AND (
       NOT EXISTS (SELECT 1 FROM public.institutions i WHERE i.id = _campus_id AND i.university_id = _university_id AND i.is_active)
       OR (v_domain.campus_id IS NOT NULL AND v_domain.campus_id <> _campus_id)) THEN
    RETURN QUERY SELECT 'CAMPUS_INVALID'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT i.university_id INTO v_profile_university
  FROM public.profiles p JOIN public.institutions i ON i.id = p.campus_id
  WHERE p.id = _user_id;
  IF v_profile_university IS NOT NULL AND v_profile_university <> _university_id THEN
    RETURN QUERY SELECT 'INSTITUTION_MISMATCH'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT * INTO v_current FROM public.profile_affiliations WHERE user_id = _user_id;
  v_hash := public.institution_hmac(v_email);

  IF v_current.status = 'verified' AND v_current.institutional_email_hash = v_hash THEN
    RETURN QUERY SELECT 'ALREADY_VERIFIED'::text, NULL::uuid, NULL::text, v_current.institutional_email_masked, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  -- Enfriamiento entre envios.
  SELECT * INTO v_last FROM public.institution_verification_challenges c
  WHERE c.user_id = _user_id ORDER BY c.created_at DESC LIMIT 1;
  IF v_last.id IS NOT NULL AND v_last.resend_after > now() THEN
    RETURN QUERY SELECT 'COOLDOWN'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, v_last.resend_after;
    RETURN;
  END IF;

  -- Limites: por cuenta, por correo y por IP.
  IF (SELECT count(*) FROM public.institution_verification_challenges c
      WHERE c.user_id = _user_id AND c.created_at > now() - interval '1 hour') >= 5
  OR (SELECT count(*) FROM public.institution_verification_challenges c
      WHERE c.user_id = _user_id AND c.created_at > now() - interval '1 day') >= 10
  OR (SELECT count(*) FROM public.institution_verification_challenges c
      WHERE c.email_hash = v_hash AND c.created_at > now() - interval '1 hour') >= 3
  OR (_ip_hash IS NOT NULL AND (SELECT count(*) FROM public.institution_verification_challenges c
      WHERE c.ip_hash = _ip_hash AND c.created_at > now() - interval '1 hour') >= 20) THEN
    PERFORM public.log_verification_event(_user_id, NULL, 'rate_limited', '{}');
    RETURN QUERY SELECT 'RATE_LIMITED'::text, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  -- Un desafio vivo a la vez.
  UPDATE public.institution_verification_challenges c SET status = 'revoked'
  WHERE c.user_id = _user_id AND c.status = 'pending';

  v_code := lpad((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000)::text, 6, '0');

  INSERT INTO public.institution_verification_challenges (
    id, user_id, university_id, campus_id, email_domain_id, email_hash, email_masked,
    student_id_input, otp_hash, ip_hash, expires_at, resend_after)
  VALUES (
    v_id, _user_id, _university_id, coalesce(_campus_id, v_domain.campus_id), v_domain.id, v_hash,
    public.mask_email(v_email), nullif(btrim(_student_id), ''),
    public.institution_hmac(v_id::text || ':' || v_code), _ip_hash, v_expires, v_resend);

  -- Una verificacion vigente no se degrada mientras se prueba otro correo.
  INSERT INTO public.profile_affiliations (user_id, university_id, campus_id, status, institutional_email_masked, email_domain_id)
  VALUES (_user_id, _university_id, _campus_id, 'pending_email', public.mask_email(v_email), v_domain.id)
  ON CONFLICT (user_id) DO UPDATE SET
    status = CASE WHEN profile_affiliations.status = 'verified' THEN 'verified' ELSE 'pending_email' END,
    university_id = CASE WHEN profile_affiliations.status = 'verified' THEN profile_affiliations.university_id ELSE EXCLUDED.university_id END,
    status_reason = CASE WHEN profile_affiliations.status = 'verified' THEN profile_affiliations.status_reason ELSE NULL END;

  PERFORM public.log_verification_event(_user_id, v_id, 'challenge_created', jsonb_build_object('domain', v_domain.domain));

  RETURN QUERY SELECT 'SENT'::text, v_id, v_code, public.mask_email(v_email), v_expires, v_resend;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.start_institution_verification(uuid, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.start_institution_verification(uuid, uuid, uuid, text, text, text) TO service_role;

-- Si el correo no se pudo enviar, el desafio no debe quedar vivo ni contar.
CREATE OR REPLACE FUNCTION public.cancel_institution_challenge(_challenge_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  UPDATE public.institution_verification_challenges
  SET status = 'cancelled', resend_after = now()
  WHERE id = _challenge_id AND status = 'pending'
  RETURNING user_id INTO v_user;
  IF v_user IS NOT NULL THEN
    UPDATE public.profile_affiliations SET status = 'unverified'
    WHERE user_id = v_user AND status = 'pending_email';
    PERFORM public.log_verification_event(v_user, _challenge_id, 'challenge_cancelled', '{}');
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.cancel_institution_challenge(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.cancel_institution_challenge(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.confirm_institution_verification(_code text)
RETURNS TABLE (status text, attempts_left integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid   uuid := auth.uid();
  v_c     public.institution_verification_challenges;
  v_ok    boolean;
  v_failed_hour integer;
  v_domain_ok boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  -- FOR UPDATE: dos confirmaciones a la vez se ponen en fila, y la segunda
  -- ya no encuentra el desafio pendiente.
  SELECT * INTO v_c FROM public.institution_verification_challenges c
  WHERE c.user_id = v_uid AND c.status = 'pending'
  ORDER BY c.created_at DESC LIMIT 1
  FOR UPDATE;

  IF v_c.id IS NULL THEN
    RETURN QUERY SELECT 'NO_PENDING'::text, 0;
    RETURN;
  END IF;

  IF v_c.expires_at <= now() THEN
    UPDATE public.institution_verification_challenges SET status = 'expired' WHERE id = v_c.id;
    UPDATE public.profile_affiliations SET status = 'expired' WHERE user_id = v_uid AND status = 'pending_email';
    PERFORM public.log_verification_event(v_uid, v_c.id, 'expired', '{}');
    RETURN QUERY SELECT 'EXPIRED'::text, 0;
    RETURN;
  END IF;

  SELECT count(*) INTO v_failed_hour FROM public.institution_verification_events e
  WHERE e.user_id = v_uid AND e.event = 'invalid_code' AND e.created_at > now() - interval '1 hour';
  IF v_failed_hour >= 15 THEN
    RETURN QUERY SELECT 'RATE_LIMITED'::text, 0;
    RETURN;
  END IF;

  v_ok := coalesce(_code, '') ~ '^[0-9]{6}$'
          AND public.institution_hmac(v_c.id::text || ':' || _code) = v_c.otp_hash;

  IF NOT v_ok THEN
    UPDATE public.institution_verification_challenges
    SET attempts = attempts + 1,
        status = CASE WHEN attempts + 1 >= max_attempts THEN 'locked' ELSE 'pending' END
    WHERE id = v_c.id;
    PERFORM public.log_verification_event(v_uid, v_c.id, 'invalid_code', '{}');
    IF v_c.attempts + 1 >= v_c.max_attempts THEN
      UPDATE public.profile_affiliations SET status = 'unverified' WHERE user_id = v_uid AND status = 'pending_email';
      RETURN QUERY SELECT 'LOCKED'::text, 0;
    ELSE
      RETURN QUERY SELECT 'INVALID_CODE'::text, v_c.max_attempts - v_c.attempts - 1;
    END IF;
    RETURN;
  END IF;

  -- El dominio pudo desactivarse entre el envio y la confirmacion.
  SELECT EXISTS (
    SELECT 1 FROM public.institution_email_domains d
    JOIN public.universities u ON u.id = d.university_id AND u.is_active
    WHERE d.id = v_c.email_domain_id AND d.is_active AND d.verification_enabled
      AND d.confidence = 'confirmed' AND d.audience IN ('student', 'all_affiliates')
  ) INTO v_domain_ok;
  IF NOT v_domain_ok THEN
    UPDATE public.institution_verification_challenges SET status = 'revoked' WHERE id = v_c.id;
    UPDATE public.profile_affiliations SET status = 'unverified' WHERE user_id = v_uid AND status = 'pending_email';
    RETURN QUERY SELECT 'DOMAIN_NOT_VERIFIABLE'::text, 0;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.profile_affiliations a
    WHERE a.institutional_email_hash = v_c.email_hash AND a.status = 'verified' AND a.user_id <> v_uid
  ) THEN
    UPDATE public.institution_verification_challenges SET status = 'conflict', consumed_at = now() WHERE id = v_c.id;
    UPDATE public.profile_affiliations SET status = 'manual_review', status_reason = 'email_in_use'
    WHERE user_id = v_uid AND status <> 'verified';
    PERFORM public.log_verification_event(v_uid, v_c.id, 'conflict', '{}');
    RETURN QUERY SELECT 'MANUAL_REVIEW'::text, 0;
    RETURN;
  END IF;

  BEGIN
    UPDATE public.institution_verification_challenges SET status = 'verified', consumed_at = now() WHERE id = v_c.id;

    INSERT INTO public.profile_affiliations (
      user_id, university_id, campus_id, status, institutional_email_hash, institutional_email_masked,
      email_domain_id, verification_method, verified_at)
    VALUES (v_uid, v_c.university_id, v_c.campus_id, 'verified', v_c.email_hash, v_c.email_masked,
      v_c.email_domain_id, 'institutional_email_otp', now())
    ON CONFLICT (user_id) DO UPDATE SET
      university_id = EXCLUDED.university_id,
      campus_id = coalesce(EXCLUDED.campus_id, profile_affiliations.campus_id),
      status = 'verified', status_reason = NULL,
      institutional_email_hash = EXCLUDED.institutional_email_hash,
      institutional_email_masked = EXCLUDED.institutional_email_masked,
      email_domain_id = EXCLUDED.email_domain_id,
      verification_method = 'institutional_email_otp', verified_at = now();
  EXCEPTION WHEN unique_violation THEN
    UPDATE public.institution_verification_challenges SET status = 'conflict', consumed_at = now() WHERE id = v_c.id;
    UPDATE public.profile_affiliations SET status = 'manual_review', status_reason = 'email_in_use' WHERE user_id = v_uid;
    RETURN QUERY SELECT 'MANUAL_REVIEW'::text, 0;
    RETURN;
  END;

  UPDATE public.profiles
  SET campus_id = coalesce(campus_id, v_c.campus_id),
      student_id = coalesce(student_id, v_c.student_id_input)
  WHERE id = v_uid;

  PERFORM public.log_verification_event(v_uid, v_c.id, 'verified', '{"method":"institutional_email_otp"}');
  RETURN QUERY SELECT 'VERIFIED'::text, 0;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.confirm_institution_verification(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.confirm_institution_verification(text) TO authenticated;

-- Lo que la app necesita saber de la propia verificacion. Sin hash, sin
-- correo completo, sin codigo.
CREATE OR REPLACE FUNCTION public.my_institution_verification()
RETURNS TABLE (
  status            text,
  status_reason     text,
  university_id     uuid,
  university_name   text,
  institution_type  text,
  campus_id         uuid,
  campus_name       text,
  email_masked      text,
  verification_method text,
  verified_at       timestamptz,
  pending_email_masked text,
  pending_expires_at   timestamptz,
  pending_resend_after timestamptz,
  pending_attempts_left integer,
  verification_available boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT p.id, p.campus_id, i.university_id AS profile_university
    FROM public.profiles p LEFT JOIN public.institutions i ON i.id = p.campus_id
    WHERE p.id = auth.uid()
  ), a AS (
    SELECT * FROM public.profile_affiliations WHERE user_id = auth.uid()
  ), c AS (
    SELECT * FROM public.institution_verification_challenges
    WHERE user_id = auth.uid() AND status = 'pending' AND expires_at > now()
    ORDER BY created_at DESC LIMIT 1
  )
  SELECT
    coalesce((SELECT a.status FROM a), 'unverified'),
    (SELECT a.status_reason FROM a),
    coalesce((SELECT a.university_id FROM a WHERE a.status IN ('verified', 'pending_email')), me.profile_university),
    u.name,
    u.institution_type,
    me.campus_id,
    coalesce(i.campus_name, i.name),
    (SELECT a.institutional_email_masked FROM a WHERE a.status = 'verified'),
    (SELECT a.verification_method FROM a WHERE a.status = 'verified'),
    (SELECT a.verified_at FROM a WHERE a.status = 'verified'),
    (SELECT c.email_masked FROM c),
    (SELECT c.expires_at FROM c),
    (SELECT c.resend_after FROM c),
    (SELECT c.max_attempts - c.attempts FROM c),
    EXISTS (
      SELECT 1 FROM public.institution_email_domains d
      WHERE d.university_id = u.id AND d.is_active AND d.verification_enabled
    )
  FROM me
  LEFT JOIN public.institutions i ON i.id = me.campus_id
  LEFT JOIN public.universities u
    ON u.id = coalesce((SELECT a.university_id FROM a WHERE a.status IN ('verified', 'pending_email')), me.profile_university);
$$;
REVOKE EXECUTE ON FUNCTION public.my_institution_verification() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.my_institution_verification() TO authenticated;

-- Retirar verificaciones cuando un dominio resulta no ser valido. No se hace
-- sola al desactivar el dominio: una verificacion hecha con evidencia vigente
-- sigue siendo cierta hasta que alguien decida lo contrario.
CREATE OR REPLACE FUNCTION public.revoke_verifications_for_domain(_domain_id uuid, _reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.profile_affiliations
  SET status = 'revoked', status_reason = coalesce(_reason, 'domain_revoked')
  WHERE email_domain_id = _domain_id AND status = 'verified';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM public.log_verification_event(NULL, NULL, 'domain_revoked',
    jsonb_build_object('domain_id', _domain_id, 'count', n, 'reason', _reason));
  RETURN n;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.revoke_verifications_for_domain(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.revoke_verifications_for_domain(uuid, text) TO service_role;

-- ------------------------------------------------------------
-- 12. Solicitudes desde la app
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_institution(
  _kind text,
  _institution_name text DEFAULT NULL,
  _country_code text DEFAULT NULL,
  _city text DEFAULT NULL,
  _website_url text DEFAULT NULL,
  _notes text DEFAULT NULL,
  _university_id uuid DEFAULT NULL,
  _campus_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id  uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  IF _kind NOT IN ('add_institution', 'manual_verification') THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  IF _kind = 'add_institution' AND length(btrim(coalesce(_institution_name, ''))) < 3 THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  IF (SELECT count(*) FROM public.institution_requests r
      WHERE r.user_id = v_uid AND r.created_at > now() - interval '1 day') >= 5 THEN
    RAISE EXCEPTION 'REQUEST_RATE_LIMIT';
  END IF;

  INSERT INTO public.institution_requests (user_id, kind, institution_name, country_code, city, website_url, notes, university_id, campus_id)
  VALUES (v_uid, _kind, nullif(btrim(_institution_name), ''), nullif(upper(btrim(_country_code)), ''),
    nullif(btrim(_city), ''), nullif(btrim(_website_url), ''), nullif(btrim(_notes), ''), _university_id, _campus_id)
  RETURNING id INTO v_id;

  IF _kind = 'manual_verification' THEN
    INSERT INTO public.profile_affiliations (user_id, university_id, campus_id, status, status_reason)
    VALUES (v_uid, _university_id, _campus_id, 'manual_review', 'user_request')
    ON CONFLICT (user_id) DO UPDATE SET status = 'manual_review', status_reason = 'user_request'
    WHERE profile_affiliations.status <> 'verified';
  END IF;
  RETURN v_id;
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'INVALID_REQUEST';
END;
$$;
REVOKE EXECUTE ON FUNCTION public.request_institution(text, text, text, text, text, text, uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.request_institution(text, text, text, text, text, text, uuid, uuid) TO authenticated;

-- ------------------------------------------------------------
-- 13. Buscar instituciones (selector del alta)
--
-- Una fila por campus. Sin texto: las mas usadas, o las mas cercanas si se
-- pasan coordenadas. Nunca se autoasigna nada: solo se ordena.
-- Con correo de acceso verificable, solo esa universidad (la base rechazaria
-- cualquier otra al guardar).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_institutions(
  _query        text DEFAULT NULL,
  _country_code text DEFAULT NULL,
  _type         text DEFAULT NULL,
  _limit        integer DEFAULT 20,
  _offset       integer DEFAULT 0,
  _lat          double precision DEFAULT NULL,
  _lng          double precision DEFAULT NULL
)
RETURNS TABLE (
  campus_id        uuid,
  campus_name      text,
  campus_city      text,
  university_id    uuid,
  university_name  text,
  short_name       text,
  institution_type text,
  country_code     text,
  state_region     text,
  city             text,
  campus_count     integer,
  verification_available boolean,
  email_verified   boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_q     text := public.search_normalize(left(coalesce(_query, ''), 100));
  v_mine  uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  v_mine := public.my_email_university();

  RETURN QUERY
  WITH base AS (
    SELECT i.id AS cid, i.campus_name AS cname, i.city AS ccity, i.lat, i.lng,
           u.id AS uid, u.name AS uname, u.short_name AS ushort, u.institution_type AS utype,
           u.country_code AS ucountry, u.state_region AS ustate, u.city AS ucity,
           (u.search_document || ' ' || i.search_document) AS doc
    FROM public.institutions i
    JOIN public.universities u ON u.id = i.university_id
    WHERE i.is_active AND u.is_active
      AND (v_mine IS NULL OR u.id = v_mine)
      AND (_country_code IS NULL OR u.country_code = upper(_country_code))
      AND (_type IS NULL OR u.institution_type = _type)
  ), matched AS (
    SELECT b.*,
      CASE
        WHEN v_q = '' THEN 3
        WHEN public.search_normalize(b.ushort) = v_q OR public.search_normalize(b.uname) = v_q THEN 0
        WHEN public.search_normalize(b.uname) LIKE v_q || '%' OR public.search_normalize(b.ushort) LIKE v_q || '%' THEN 1
        WHEN (' ' || b.doc) LIKE '% ' || v_q || '%' THEN 2
        ELSE 3
      END AS rank
    FROM base b
    WHERE v_q = ''
       OR NOT EXISTS (
         SELECT 1 FROM unnest(string_to_array(v_q, ' ')) t
         WHERE t <> '' AND position(t IN b.doc) = 0)
  )
  SELECT m.cid, m.cname, m.ccity, m.uid, m.uname, m.ushort, m.utype, m.ucountry, m.ustate, m.ucity,
    (SELECT count(*)::int FROM public.institutions x WHERE x.university_id = m.uid AND x.is_active),
    EXISTS (SELECT 1 FROM public.institution_email_domains d
            WHERE d.university_id = m.uid AND d.is_active AND d.verification_enabled),
    v_mine IS NOT NULL
  FROM matched m
  ORDER BY m.rank,
    CASE WHEN v_q = '' AND _lat IS NOT NULL AND _lng IS NOT NULL AND m.lat IS NOT NULL
         THEN (m.lat - _lat) ^ 2 + (m.lng - _lng) ^ 2 END NULLS LAST,
    CASE WHEN v_q = '' THEN (SELECT count(*) FROM public.profiles p WHERE p.campus_id = m.cid) END DESC NULLS LAST,
    m.uname, m.cname NULLS FIRST, m.cid
  LIMIT  least(greatest(coalesce(_limit, 20), 1), 50)
  OFFSET least(greatest(coalesce(_offset, 0), 0), 1000);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.search_institutions(text, text, text, integer, integer, double precision, double precision) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.search_institutions(text, text, text, integer, integer, double precision, double precision) TO authenticated;

-- ------------------------------------------------------------
-- 14. Perfil publico: institucion y campus, nunca matricula ni correo
--
-- CREATE OR REPLACE conserva las columnas existentes en su orden y anade las
-- nuevas al final.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.public_profiles
WITH (security_invoker = false) AS
SELECT
  p.id,
  p.name,
  p.avatar_url,
  p.major,
  p.semester,
  p.residence_type,
  p.interests,
  p.languages,
  p.campus_id,
  p.points,
  p.reputation,
  p.created_at,
  p.origin,
  p.institution_verified,
  u.name             AS university_name,
  u.short_name       AS university_short_name,
  u.institution_type AS institution_type,
  i.campus_name      AS campus_name
FROM public.profiles p
LEFT JOIN public.institutions i ON i.id = p.campus_id
LEFT JOIN public.universities u ON u.id = i.university_id
WHERE auth.uid() IS NOT NULL
  AND NOT public.is_blocked(auth.uid(), p.id)
  AND (p.id = auth.uid() OR public.same_institution(auth.uid(), p.id));

GRANT SELECT ON public.public_profiles TO authenticated;

-- ------------------------------------------------------------
-- 15. Cuentas que ya estaban verificadas
-- ------------------------------------------------------------
INSERT INTO public.profile_affiliations (
  user_id, university_id, campus_id, status, institutional_email_hash, institutional_email_masked,
  email_domain_id, verification_method, verified_at, status_reason)
SELECT
  p.id,
  i.university_id,
  p.campus_id,
  CASE WHEN d.id IS NOT NULL AND au.email_confirmed_at IS NULL THEN 'pending_email' ELSE 'verified' END,
  CASE WHEN d.id IS NOT NULL AND au.email_confirmed_at IS NOT NULL
       THEN public.institution_hmac(public.normalize_email_address(au.email)) END,
  CASE WHEN d.id IS NOT NULL THEN public.mask_email(public.normalize_email_address(au.email)) END,
  d.id,
  CASE WHEN d.id IS NOT NULL AND au.email_confirmed_at IS NULL THEN NULL
       WHEN d.id IS NOT NULL THEN 'legacy_auth_email'
       ELSE 'legacy_manual' END,
  CASE WHEN d.id IS NOT NULL AND au.email_confirmed_at IS NULL THEN NULL ELSE p.created_at END,
  CASE WHEN d.id IS NOT NULL AND au.email_confirmed_at IS NULL THEN 'legacy_unconfirmed_auth_email' END
FROM public.profiles p
JOIN auth.users au ON au.id = p.id
LEFT JOIN public.institutions i ON i.id = p.campus_id
LEFT JOIN public.institution_email_domains d
  ON d.domain = public.email_domain(public.normalize_email_address(au.email))
 AND d.university_id = i.university_id
WHERE p.institution_verified
  AND i.university_id IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;

COMMIT;

-- >>> 20260917010000_catalogo-instituciones-datos.sql <<<
-- ============================================================
-- Catalogo de instituciones: datos (GENERADO, no editar a mano)
--
-- Generado por scripts/import-institutions/import.mjs a partir de
-- scripts/import-institutions/data/catalog.json y email-domains.json.
-- Fuentes: SEP formato 911 (MX), SNIES del MEN (CO), IPEDS/NCES (US).
--
-- Upsert por slug; nunca borra. Falla si un id conocido cambiaria, si un
-- campus cambiaria de institucion o si algun perfil o evento cambia de
-- campus. En los registros que ya existian solo rellena lo vacio.
-- Requiere 20260917000000_verificacion-institucional.sql.
-- ============================================================

BEGIN;

CREATE TEMP TABLE _before_profiles ON COMMIT DROP AS
  SELECT campus_id, count(*) AS n FROM public.profiles GROUP BY campus_id;
CREATE TEMP TABLE _before_events ON COMMIT DROP AS
  SELECT institution_id, count(*) AS n FROM public.events GROUP BY institution_id;

-- 1. Ids que no pueden cambiar
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.universities WHERE slug = 'tec' AND id <> '2c931b2c-9449-4ba7-b701-2a57c2ae2f62') THEN
    RAISE EXCEPTION 'ID_CHANGED universities.tec';
  END IF;
  IF EXISTS (SELECT 1 FROM public.universities WHERE slug = 'icesi' AND id <> '24ba682b-945a-4355-865a-dc65ec118861') THEN
    RAISE EXCEPTION 'ID_CHANGED universities.icesi';
  END IF;
  IF EXISTS (SELECT 1 FROM public.universities WHERE slug = 'javeriana' AND id <> '9fa36a6f-f113-4788-90b2-5fc69430c851') THEN
    RAISE EXCEPTION 'ID_CHANGED universities.javeriana';
  END IF;
  IF EXISTS (SELECT 1 FROM public.universities WHERE slug = 'cesa' AND id <> '5ef91efd-a109-48d3-8f68-2a9308ce8c5e') THEN
    RAISE EXCEPTION 'ID_CHANGED universities.cesa';
  END IF;
  IF EXISTS (SELECT 1 FROM public.universities WHERE slug = 'purdue' AND id <> 'bcda7873-6322-4d24-8b49-428e6706ee7d') THEN
    RAISE EXCEPTION 'ID_CHANGED universities.purdue';
  END IF;
  IF EXISTS (SELECT 1 FROM public.universities WHERE slug = 'florida-state' AND id <> 'd8700f55-9fd3-42d1-a199-fba956e5d78d') THEN
    RAISE EXCEPTION 'ID_CHANGED universities.florida-state';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'tec-queretaro' AND id <> '1a898a3a-53c0-4468-8dc6-b03bef169a6e') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.tec-queretaro';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'tec-guadalajara' AND id <> '9269e0c2-1704-4264-8e26-294c7fddbf8a') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.tec-guadalajara';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'tec-monterrey' AND id <> 'a77a918e-5b0b-45b2-9a01-acdd4d61d08a') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.tec-monterrey';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'tec-ciudad-de-mexico' AND id <> '1fe414c7-3136-4696-ac67-2b07a416e9cf') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.tec-ciudad-de-mexico';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'florida-state' AND id <> 'be062ad6-1a5d-4687-a71d-21c2ac7a8ad0') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.florida-state';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'purdue' AND id <> '3869753e-03d4-4ad9-ae96-2b7605117f4b') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.purdue';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'icesi' AND id <> '2d5e3036-eed0-4398-92db-f92cb5f4dd4e') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.icesi';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'javeriana' AND id <> '91eb1307-a047-436b-ba78-8c6eca58c4fe') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.javeriana';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'cesa' AND id <> '62cd4de7-26c3-49e4-b4f4-7b5e3efd0617') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.cesa';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'unam' AND id <> '9aa57d8a-732e-4293-aa8a-bab741523796') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.unam';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'ipn' AND id <> 'a7463fb5-c938-4743-87cf-51f43edae71b') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.ipn';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'udg' AND id <> 'c32b35f0-6177-4488-bb3c-cfa2e0985164') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.udg';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'uanl' AND id <> 'd54d915b-c7a1-4e6d-a2b5-bb7ff3a6f603') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.uanl';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'buap' AND id <> '31744f31-49df-466f-bab4-f4527afde0f5') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.buap';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'uam' AND id <> 'e843d37b-5c82-42c0-b853-654807a41042') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.uam';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'uaemex' AND id <> '948cbbe0-8a83-4e6c-a4b6-e0aeb1d7f090') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.uaemex';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'uaslp' AND id <> '713927e5-430e-4325-af3f-0333d410b5d1') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.uaslp';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'uaq' AND id <> 'eaa4cd40-0566-42a6-ac91-e652b1137151') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.uaq';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'ibero' AND id <> '46a080c1-c6d2-4ee9-ba04-db520d6ef99e') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.ibero';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'itam' AND id <> 'f5d3ed89-6d29-4fbe-9470-44cd6ce0db26') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.itam';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'anahuac' AND id <> '60786e59-f502-4f49-824c-7509b8e2a400') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.anahuac';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'udlap' AND id <> '35a6dfa2-32e4-4286-ac5b-22241ecf3065') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.udlap';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'up' AND id <> '026f4553-90bf-46b6-b17f-5784dbff1b7f') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.up';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'colmex' AND id <> '9be8685c-ae88-4a73-ba4f-14b835d9b66b') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.colmex';
  END IF;
  IF EXISTS (SELECT 1 FROM public.institutions WHERE slug = 'cide' AND id <> 'e592d5a8-f8e9-41e9-b285-68c5f5f858e1') THEN
    RAISE EXCEPTION 'ID_CHANGED institutions.cide';
  END IF;
END $$;

-- 2. Instituciones
CREATE TEMP TABLE _u (slug text, country_code text, name text, short_name text, institution_type text, control text,
  state_region text, city text, website_url text, aliases text[], source_name text, source_ref text, source_url text,
  source_checked_at date, preserve boolean) ON COMMIT DROP;
INSERT INTO _u VALUES
  ('colegio-bolivar', 'CO', U&'Colegio Bol\00EDvar', NULL, 'school', 'private', 'Valle del Cauca', 'Cali', 'https://www.colegiobolivar.edu.co', ARRAY['Colegio Bolivar Cali']::text[], 'MEN-ESTABLECIMIENTOS', '376001001221', 'https://www.datos.gov.co/d/upkm-vdjb', '2026-09-14', false),
  ('cesa', 'CO', U&'Colegio de Estudios Superiores de Administraci\00F3n', 'CESA', 'university_institution', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.cesa.edu.co', ARRAY[]::text[], 'SNIES', '2704', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', true),
  ('colegio-mayor-de-antioquia', 'CO', 'Colegio Mayor de Antioquia', NULL, 'university_institution', 'public', 'Antioquia', U&'Medell\00EDn', 'https://www.colmayor.edu.co', ARRAY[]::text[], 'SNIES', '2110', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('escuela-colombiana-de-ingenieria-julio-garavito', 'CO', U&'Escuela Colombiana de Ingenier\00EDa Julio Garavito', U&'Escuela de Ingenier\00EDa', 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.escuelaing.edu.co', ARRAY[]::text[], 'SNIES', '2811', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('fundacion-universidad-autonoma-de-colombia', 'CO', U&'Fundaci\00F3n Universidad Aut\00F3noma de Colombia', 'FUAC', 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.fuac.edu.co', ARRAY[]::text[], 'SNIES', '1725', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('fundacion-universidad-de-america', 'CO', U&'Fundaci\00F3n Universidad de Am\00E9rica', NULL, 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.uamerica.edu.co', ARRAY[]::text[], 'SNIES', '1715', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('fundacion-universitaria-antonio-de-arevalo', 'CO', U&'Fundaci\00F3n Universitaria Antonio de Ar\00E9valo', 'Unitecnar', 'university_institution', 'private', U&'Bol\00EDvar', 'Cartagena de Indias', 'https://www.tecnar.edu.co', ARRAY[]::text[], 'SNIES', '3710', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('fundacion-universitaria-ceipa', 'CO', U&'Fundaci\00F3n Universitaria CEIPA', 'CEIPA', 'university_institution', 'private', 'Antioquia', 'Sabaneta', 'https://www.ceipa.edu.co', ARRAY[]::text[], 'SNIES', '2727', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('fundacion-universitaria-de-ciencias-de-la-salud', 'CO', U&'Fundaci\00F3n Universitaria de Ciencias de la Salud', NULL, 'university_institution', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.fucsalud.edu.co', ARRAY[]::text[], 'SNIES', '2702', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('fundacion-universitaria-del-area-andina', 'CO', U&'Fundaci\00F3n Universitaria del \00C1rea Andina', NULL, 'university_institution', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.areandina.edu.co', ARRAY[]::text[], 'SNIES', '2728', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('fundacion-universitaria-juan-n-corpas', 'CO', U&'Fundaci\00F3n Universitaria Juan N. Corpas', NULL, 'university_institution', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.juancorpas.edu.co', ARRAY[]::text[], 'SNIES', '2707', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('fundacion-universitaria-konrad-lorenz', 'CO', U&'Fundaci\00F3n Universitaria Konrad Lorenz', NULL, 'university_institution', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.konradlorenz.edu.co', ARRAY[]::text[], 'SNIES', '2712', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('instituto-tecnologico-metropolitano', 'CO', U&'Instituto Tecnol\00F3gico Metropolitano', NULL, 'university_institution', 'public', 'Antioquia', U&'Medell\00EDn', 'https://www.itm.edu.co', ARRAY[]::text[], 'SNIES', '3302', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('javeriana', 'CO', 'Pontificia Universidad Javeriana', 'Javeriana', 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.javeriana.edu.co', ARRAY[]::text[], 'SNIES', '1701', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', true),
  ('tecnologico-de-antioquia', 'CO', U&'Tecnol\00F3gico de Antioquia', NULL, 'university_institution', 'public', 'Antioquia', U&'Medell\00EDn', 'https://www.tdea.edu.co', ARRAY[]::text[], 'SNIES', '3204', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-antonio-narino', 'CO', U&'Universidad Antonio Nari\00F1o', NULL, 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.uan.edu.co', ARRAY[]::text[], 'SNIES', '1826', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-autonoma-de-bucaramanga', 'CO', U&'Universidad Aut\00F3noma de Bucaramanga', 'UNAB', 'university', 'private', 'Santander', 'Bucaramanga', 'https://www.unab.edu.co', ARRAY[]::text[], 'SNIES', '1823', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-autonoma-de-manizales', 'CO', U&'Universidad Aut\00F3noma de Manizales', NULL, 'university', 'private', 'Caldas', 'Manizales', 'https://www.autonoma.edu.co', ARRAY[]::text[], 'SNIES', '1825', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-autonoma-de-occidente-co', 'CO', U&'Universidad Aut\00F3noma de Occidente', 'UAO', 'university', 'private', 'Valle del Cauca', 'Cali', 'https://www.uao.edu.co', ARRAY[]::text[], 'SNIES', '1830', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-autonoma-del-caribe', 'CO', U&'Universidad Aut\00F3noma del Caribe', U&'Uniaut\00F3noma', 'university', 'private', U&'Atl\00E1ntico', 'Barranquilla', 'https://www.uac.edu.co', ARRAY[]::text[], 'SNIES', '1804', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-autonoma-indigena-intercultural', 'CO', U&'Universidad Aut\00F3noma Ind\00EDgena Intercultural', 'UAIIN', 'university', 'public', 'Cauca', U&'Popay\00E1n', 'https://www.uaiinpebi-cric.edu.co', ARRAY[]::text[], 'SNIES', '9929', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-autonoma-latinoamericana', 'CO', U&'Universidad Aut\00F3noma Latinoamericana', 'UNAULA', 'university', 'private', 'Antioquia', U&'Medell\00EDn', 'https://www.unaula.edu.co', ARRAY[]::text[], 'SNIES', '1814', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-catolica-de-colombia', 'CO', U&'Universidad Cat\00F3lica de Colombia', NULL, 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.ucatolica.edu.co', ARRAY[]::text[], 'SNIES', '1719', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-catolica-de-manizales', 'CO', U&'Universidad Cat\00F3lica de Manizales', NULL, 'university', 'private', 'Caldas', 'Manizales', 'https://www.ucm.edu.co', ARRAY[]::text[], 'SNIES', '1827', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-catolica-de-oriente', 'CO', U&'Universidad Cat\00F3lica de Oriente', 'UCO', 'university', 'private', 'Antioquia', 'Rionegro', 'https://www.uco.edu.co', ARRAY[]::text[], 'SNIES', '1726', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-catolica-de-pereira', 'CO', U&'Universidad Cat\00F3lica de Pereira', NULL, 'university', 'private', 'Risaralda', 'Pereira', 'https://www.ucp.edu.co', ARRAY[]::text[], 'SNIES', '2711', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-catolica-luis-amigo', 'CO', U&'Universidad Cat\00F3lica Luis Amig\00F3', NULL, 'university', 'private', 'Antioquia', U&'Medell\00EDn', 'https://www.ucatolicaluisamigo.edu.co', ARRAY[]::text[], 'SNIES', '2719', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-central', 'CO', 'Universidad Central', NULL, 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.ucentral.edu.co', ARRAY[]::text[], 'SNIES', '1709', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-ces', 'CO', 'Universidad CES', NULL, 'university', 'private', 'Antioquia', U&'Medell\00EDn', 'https://www.ces.edu.co', ARRAY[]::text[], 'SNIES', '2708', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-cesmag', 'CO', 'Universidad CESMAG', 'Unicesmag', 'university', 'private', U&'Nari\00F1o', 'Pasto', 'https://www.iucesmag.edu.co', ARRAY[]::text[], 'SNIES', '2744', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-colegio-mayor-de-cundinamarca', 'CO', 'Universidad Colegio Mayor de Cundinamarca', NULL, 'university', 'public', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.unicolmayor.edu.co', ARRAY[]::text[], 'SNIES', '1121', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-cooperativa-de-colombia', 'CO', 'Universidad Cooperativa de Colombia', NULL, 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.ucc.edu.co', ARRAY[]::text[], 'SNIES', '1818', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-antioquia', 'CO', 'Universidad de Antioquia', 'UdeA', 'university', 'public', 'Antioquia', U&'Medell\00EDn', 'https://www.udea.edu.co', ARRAY[]::text[], 'SNIES', '1201', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-bogota-jorge-tadeo-lozano', 'CO', U&'Universidad de Bogot\00E1 Jorge Tadeo Lozano', 'Utadeo', 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.utadeo.edu.co', ARRAY[]::text[], 'SNIES', '1707', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-boyaca', 'CO', U&'Universidad de Boyac\00E1', U&'Uniboyac\00E1', 'university', 'private', U&'Boyac\00E1', 'Tunja', 'https://www.uniboyaca.edu.co', ARRAY[]::text[], 'SNIES', '1734', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-caldas', 'CO', 'Universidad de Caldas', NULL, 'university', 'public', 'Caldas', 'Manizales', 'https://www.ucaldas.edu.co', ARRAY[]::text[], 'SNIES', '1112', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-cartagena', 'CO', 'Universidad de Cartagena', NULL, 'university', 'public', U&'Bol\00EDvar', 'Cartagena de Indias', 'https://www.unicartagena.edu.co', ARRAY[]::text[], 'SNIES', '1205', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-ciencias-aplicadas-y-ambientales', 'CO', 'Universidad de Ciencias Aplicadas y Ambientales', 'UDCA', 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.udca.edu.co', ARRAY[]::text[], 'SNIES', '1835', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-cordoba', 'CO', U&'Universidad de C\00F3rdoba', NULL, 'university', 'public', U&'C\00F3rdoba', U&'Monter\00EDa', 'https://www.unicordoba.edu.co', ARRAY[]::text[], 'SNIES', '1113', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-cundinamarca', 'CO', 'Universidad de Cundinamarca', 'UDEC', 'university', 'public', 'Cundinamarca', U&'Fusagasug\00E1', 'https://www.ucundinamarca.edu.co', ARRAY[]::text[], 'SNIES', '1214', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-ibague', 'CO', U&'Universidad de Ibagu\00E9', NULL, 'university', 'private', 'Tolima', U&'Ibagu\00E9', 'https://www.unibague.edu.co', ARRAY[]::text[], 'SNIES', '1831', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-investigacion-y-desarrollo', 'CO', U&'Universidad de Investigaci\00F3n y Desarrollo', 'UDI', 'university', 'private', 'Santander', 'Bucaramanga', 'https://www.udi.edu.co', ARRAY[]::text[], 'SNIES', '2847', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-la-amazonia', 'CO', 'Universidad de la Amazonia', NULL, 'university', 'public', U&'Caquet\00E1', 'Florencia', 'https://www.uniamazonia.edu.co', ARRAY[]::text[], 'SNIES', '1115', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-la-costa', 'CO', 'Universidad de la Costa', 'CUC', 'university', 'private', U&'Atl\00E1ntico', 'Barranquilla', 'https://www.cuc.edu.co', ARRAY[]::text[], 'SNIES', '2810', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-la-guajira', 'CO', 'Universidad de la Guajira', NULL, 'university', 'public', 'La Guajira', 'Riohacha', 'https://www.uniguajira.edu.co', ARRAY[]::text[], 'SNIES', '1218', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-la-sabana', 'CO', 'Universidad de la Sabana', 'Unisabana', 'university', 'private', 'Cundinamarca', U&'Ch\00EDa', 'https://www.unisabana.edu.co', ARRAY[]::text[], 'SNIES', '1711', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-la-salle', 'CO', 'Universidad de La Salle', 'La Salle', 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.lasalle.edu.co', ARRAY[]::text[], 'SNIES', '1803', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-los-andes', 'CO', 'Universidad de los Andes', 'Uniandes', 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.uniandes.edu.co', ARRAY[]::text[], 'SNIES', '1813', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-los-llanos', 'CO', 'Universidad de los Llanos', NULL, 'university', 'public', 'Meta', 'Villavicencio', NULL, ARRAY[]::text[], 'SNIES', '1119', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-manizales', 'CO', 'Universidad de Manizales', NULL, 'university', 'private', 'Caldas', 'Manizales', 'https://www.umanizales.edu.co', ARRAY[]::text[], 'SNIES', '1722', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-medellin', 'CO', U&'Universidad de Medell\00EDn', NULL, 'university', 'private', 'Antioquia', U&'Medell\00EDn', 'https://www.udem.edu.co', ARRAY[]::text[], 'SNIES', '1812', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-narino', 'CO', U&'Universidad de Nari\00F1o', NULL, 'university', 'public', U&'Nari\00F1o', 'Pasto', 'https://www.udenar.edu.co', ARRAY[]::text[], 'SNIES', '1206', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-pamplona', 'CO', 'Universidad de Pamplona', NULL, 'university', 'public', 'Norte de Santander', 'Pamplona', 'https://www.unipamplona.edu.co', ARRAY[]::text[], 'SNIES', '1212', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-san-buenaventura', 'CO', 'Universidad de San Buenaventura', NULL, 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.usbbog.edu.co', ARRAY[]::text[], 'SNIES', '1718', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-santander', 'CO', 'Universidad de Santander', 'UDES', 'university', 'private', 'Santander', 'Bucaramanga', 'https://www.udes.edu.co', ARRAY[]::text[], 'SNIES', '2832', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-de-sucre', 'CO', 'Universidad de Sucre', NULL, 'university', 'public', 'Sucre', 'Sincelejo', 'https://www.unisucre.edu.co', ARRAY[]::text[], 'SNIES', '1217', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-del-atlantico-co', 'CO', U&'Universidad del Atl\00E1ntico', NULL, 'university', 'public', U&'Atl\00E1ntico', 'Puerto Colombia', 'https://www.uniatlantico.edu.co', ARRAY[]::text[], 'SNIES', '1202', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-del-cauca', 'CO', 'Universidad del Cauca', NULL, 'university', 'public', 'Cauca', U&'Popay\00E1n', 'https://www.unicauca.edu.co', ARRAY[]::text[], 'SNIES', '1110', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-del-magdalena', 'CO', 'Universidad del Magdalena', 'Unimagdalena', 'university', 'public', 'Magdalena', 'Santa Marta', 'https://unimagdalena.edu.co', ARRAY[]::text[], 'SNIES', '1213', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-del-norte', 'CO', 'Universidad del Norte', 'Uninorte', 'university', 'private', U&'Atl\00E1ntico', 'Barranquilla', 'https://www.uninorte.edu.co', ARRAY[]::text[], 'SNIES', '1713', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-del-pacifico', 'CO', U&'Universidad del Pac\00EDfico', NULL, 'university', 'public', 'Valle del Cauca', 'Buenaventura', 'https://www.unipacifico.edu.co', ARRAY[]::text[], 'SNIES', '1122', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-del-quindio', 'CO', U&'Universidad del Quind\00EDo', NULL, 'university', 'public', U&'Quind\00EDo', 'Armenia', 'https://www.uniquindio.edu.co', ARRAY[]::text[], 'SNIES', '1208', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-del-rosario', 'CO', 'Universidad del Rosario', 'URosario', 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.urosario.edu.co', ARRAY[U&'Colegio Mayor de Nuestra Se\00F1ora del Rosario']::text[], 'SNIES', '1714', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-del-sinu-elias-bechara-zainum', 'CO', U&'Universidad del Sin\00FA El\00EDas Bechara Zainum', U&'Unisin\00FA', 'university', 'private', U&'C\00F3rdoba', U&'Monter\00EDa', 'https://www.unisinu.edu.co', ARRAY[]::text[], 'SNIES', '1833', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-del-tolima', 'CO', 'Universidad del Tolima', NULL, 'university', 'public', 'Tolima', U&'Ibagu\00E9', 'https://www.ut.edu.co', ARRAY[]::text[], 'SNIES', '1207', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-del-valle', 'CO', 'Universidad del Valle', 'Univalle', 'university', 'public', 'Valle del Cauca', 'Cali', 'https://www.univalle.edu.co', ARRAY[]::text[], 'SNIES', '1203', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-distrital-francisco-jose-de-caldas', 'CO', U&'Universidad Distrital Francisco Jos\00E9 de Caldas', 'UDistrital', 'university', 'public', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.udistrital.edu.co', ARRAY[]::text[], 'SNIES', '1301', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-eafit', 'CO', 'Universidad EAFIT', 'EAFIT', 'university', 'private', 'Antioquia', U&'Medell\00EDn', 'https://www.eafit.edu.co', ARRAY[]::text[], 'SNIES', '1712', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-ean', 'CO', 'Universidad EAN', NULL, 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.ean.edu.co', ARRAY[]::text[], 'SNIES', '2812', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-ecci', 'CO', 'Universidad ECCI', NULL, 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.ecci.edu.co', ARRAY[]::text[], 'SNIES', '5802', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-eia', 'CO', 'Universidad EIA', NULL, 'university', 'private', 'Antioquia', 'Envigado', 'https://www.eia.edu.co', ARRAY[]::text[], 'SNIES', '2813', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-el-bosque', 'CO', 'Universidad El Bosque', NULL, 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.unbosque.edu.co', ARRAY[]::text[], 'SNIES', '1729', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-externado-de-colombia', 'CO', 'Universidad Externado de Colombia', 'Externado', 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.uexternado.edu.co', ARRAY[]::text[], 'SNIES', '1706', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-francisco-de-paula-santander', 'CO', 'Universidad Francisco de Paula Santander', NULL, 'university', 'public', 'Norte de Santander', U&'San Jos\00E9 de C\00FAcuta', 'https://www.ufps.edu.co', ARRAY[]::text[], 'SNIES', '1209', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('icesi', 'CO', 'Universidad Icesi', 'Icesi', 'university', 'private', 'Valle del Cauca', 'Cali', 'https://www.icesi.edu.co', ARRAY[]::text[], 'SNIES', '1828', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', true),
  ('universidad-incca-de-colombia', 'CO', 'Universidad INCCA de Colombia', NULL, 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.unincca.edu.co', ARRAY[]::text[], 'SNIES', '1703', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-industrial-de-santander', 'CO', 'Universidad Industrial de Santander', 'UIS', 'university', 'public', 'Santander', 'Bucaramanga', 'https://www.uis.edu.co', ARRAY[]::text[], 'SNIES', '1204', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-internacional-del-tropico-americano', 'CO', U&'Universidad Internacional del Tr\00F3pico Americano', NULL, 'university', 'public', 'Casanare', 'Yopal', 'https://www.unitropico.edu.co', ARRAY[]::text[], 'SNIES', '2743', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-la-gran-colombia', 'CO', 'Universidad La Gran Colombia', NULL, 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.ugc.edu.co', ARRAY[]::text[], 'SNIES', '1801', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-libre', 'CO', 'Universidad Libre', NULL, 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.unilibre.edu.co', ARRAY[]::text[], 'SNIES', '1806', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-manuela-beltran', 'CO', U&'Universidad Manuela Beltr\00E1n', 'UMB', 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.umb.edu.co', ARRAY[]::text[], 'SNIES', '1735', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-mariana', 'CO', 'Universidad Mariana', NULL, 'university', 'private', U&'Nari\00F1o', 'Pasto', 'https://www.umariana.edu.co', ARRAY[]::text[], 'SNIES', '1720', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-metropolitana', 'CO', 'Universidad Metropolitana', NULL, 'university', 'private', U&'Atl\00E1ntico', 'Barranquilla', 'https://www.unimetro.edu.co', ARRAY[]::text[], 'SNIES', '1824', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-militar-nueva-granada', 'CO', 'Universidad Militar Nueva Granada', 'UMNG', 'university', 'public', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.umng.edu.co', ARRAY[]::text[], 'SNIES', '1117', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-nacional-abierta-y-a-distancia', 'CO', 'Universidad Nacional Abierta y a Distancia', 'UNAD', 'university', 'public', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.unad.edu.co', ARRAY[]::text[], 'SNIES', '2102', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-nacional-de-colombia', 'CO', 'Universidad Nacional de Colombia', 'UNAL', 'university', 'public', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.unal.edu.co', ARRAY[]::text[], 'SNIES', '1101', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-pedagogica-nacional', 'CO', U&'Universidad Pedag\00F3gica Nacional', NULL, 'university', 'public', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.pedagogica.edu.co', ARRAY[]::text[], 'SNIES', '1105', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-pedagogica-y-tecnologica-de-colombia', 'CO', U&'Universidad Pedag\00F3gica y Tecnol\00F3gica de Colombia', 'UPTC', 'university', 'public', U&'Boyac\00E1', 'Tunja', 'https://www.uptc.edu.co', ARRAY[]::text[], 'SNIES', '1106', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-piloto-de-colombia', 'CO', 'Universidad Piloto de Colombia', NULL, 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.unipiloto.edu.co', ARRAY[]::text[], 'SNIES', '1815', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-pontificia-bolivariana', 'CO', 'Universidad Pontificia Bolivariana', 'UPB', 'university', 'private', 'Antioquia', U&'Medell\00EDn', 'https://www.upb.edu.co', ARRAY[]::text[], 'SNIES', '1710', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-popular-del-cesar', 'CO', 'Universidad Popular del Cesar', NULL, 'university', 'public', 'Cesar', 'Valledupar', 'https://www.unicesar.edu.co', ARRAY[]::text[], 'SNIES', '1120', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-santiago-de-cali', 'CO', 'Universidad Santiago de Cali', 'USC', 'university', 'private', 'Valle del Cauca', 'Cali', 'https://www.usc.edu.co', ARRAY[]::text[], 'SNIES', '1805', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-santo-tomas', 'CO', U&'Universidad Santo Tom\00E1s', 'USTA', 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.usta.edu.co', ARRAY[]::text[], 'SNIES', '1704', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-sergio-arboleda', 'CO', 'Universidad Sergio Arboleda', NULL, 'university', 'private', U&'Bogot\00E1 D.C.', U&'Bogot\00E1', 'https://www.usergioarboleda.edu.co', ARRAY[]::text[], 'SNIES', '1728', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-simon-bolivar', 'CO', U&'Universidad Sim\00F3n Bol\00EDvar', NULL, 'university', 'private', U&'Atl\00E1ntico', 'Barranquilla', 'https://www.unisimonbolivar.edu.co', ARRAY[]::text[], 'SNIES', '2805', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-surcolombiana', 'CO', 'Universidad Surcolombiana', NULL, 'university', 'public', 'Huila', 'Neiva', 'https://www.usco.edu.co', ARRAY[]::text[], 'SNIES', '1114', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-tecnologica-de-bolivar', 'CO', U&'Universidad Tecnol\00F3gica de Bol\00EDvar', NULL, 'university', 'private', U&'Bol\00EDvar', 'Cartagena de Indias', 'https://www.unitecnologica.edu.co', ARRAY[]::text[], 'SNIES', '1832', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-tecnologica-de-pereira', 'CO', U&'Universidad Tecnol\00F3gica de Pereira', 'UTP', 'university', 'public', 'Risaralda', 'Pereira', 'https://www.utp.edu.co', ARRAY[]::text[], 'SNIES', '1111', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('universidad-tecnologica-del-choco-diego-luis-cordoba', 'CO', U&'Universidad Tecnol\00F3gica del Choc\00F3 Diego Luis C\00F3rdoba', 'UTCH', 'university', 'public', U&'Choc\00F3', U&'Quibd\00F3', 'https://www.utch.edu.co', ARRAY[]::text[], 'SNIES', '1118', 'https://www.datos.gov.co/d/n5yy-8nav', '2026-09-14', false),
  ('buap', 'MX', U&'Benem\00E9rita Universidad Aut\00F3noma de Puebla', 'BUAP', 'university', 'public', 'Puebla', 'Puebla', NULL, ARRAY[]::text[], 'SEP-911', '21MSU0014E', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('centro-de-ensenanza-tecnica-y-superior', 'MX', U&'Centro de Ense\00F1anza T\00E9cnica y Superior', NULL, 'university_institution', 'private', 'Baja California', 'Mexicali', NULL, ARRAY[]::text[], 'SEP-911', '02MSU0021Z', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('centro-de-estudios-del-mayab', 'MX', 'Centro de Estudios del Mayab', NULL, 'university_institution', 'private', U&'Yucat\00E1n', U&'M\00E9rida', NULL, ARRAY[]::text[], 'SEP-911', '31MSU0038V', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('centro-de-estudios-superiores-del-bajio', 'MX', U&'Centro de Estudios Superiores del Baj\00EDo', NULL, 'university_institution', 'private', U&'Quer\00E9taro', U&'Quer\00E9taro', NULL, ARRAY[]::text[], 'SEP-911', '22MSU0030V', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('centro-de-estudios-superiores-en-ciencias-juridicas-y-criminologicas', 'MX', U&'Centro de Estudios Superiores en Ciencias Jur\00EDdicas y Criminol\00F3gicas', NULL, 'university_institution', 'private', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, ARRAY[]::text[], 'SEP-911', '09MSU0073Z', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('cide', 'MX', U&'Centro de Investigaci\00F3n y Docencia Econ\00F3micas', 'CIDE', 'university_institution', 'public', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, ARRAY[]::text[], 'SEP-911', '09MSU3470S', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('centro-universitario-de-tijuana', 'MX', 'Centro Universitario de Tijuana', NULL, 'university_institution', 'private', 'Baja California', 'Tijuana', NULL, ARRAY[]::text[], 'SEP-911', '02MSU0003K', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('centro-universitario-metropolitano-hidalgo', 'MX', 'Centro Universitario Metropolitano Hidalgo', NULL, 'university_institution', 'private', 'Hidalgo', 'Mineral de la Reforma', NULL, ARRAY[]::text[], 'SEP-911', '13MSU0286N', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('centro-universitario-siglo-xxi', 'MX', 'Centro Universitario Siglo XXI', NULL, 'university_institution', 'private', 'Hidalgo', 'Pachuca de Soto', NULL, ARRAY[]::text[], 'SEP-911', '13MSU0009K', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('colmex', 'MX', U&'El Colegio de M\00E9xico', 'Colmex', 'university_institution', 'public', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, ARRAY[]::text[], 'SEP-911', '09MSU0132Y', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-de-ciencias-y-estudios-superiores-de-tamaulipas', 'MX', 'Instituto de Ciencias y Estudios Superiores de Tamaulipas', NULL, 'university_institution', 'private', 'Tamaulipas', 'Tampico', NULL, ARRAY[]::text[], 'SEP-911', '28MSU0730I', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-de-estudios-superiores-isima', 'MX', 'Instituto de Estudios Superiores ISIMA', NULL, 'university_institution', 'private', U&'Quer\00E9taro', U&'Quer\00E9taro', NULL, ARRAY[]::text[], 'SEP-911', '22MSU0046W', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('ipn', 'MX', U&'Instituto Polit\00E9cnico Nacional', 'IPN', 'university', 'public', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', 'https://www.ipn.mx', ARRAY[]::text[], 'SEP-911', '09MSU0027N', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-profesional-de-emprendedores', 'MX', 'Instituto Profesional de Emprendedores', NULL, 'university_institution', 'private', 'Chiapas', U&'Tuxtla Guti\00E9rrez', NULL, ARRAY[]::text[], 'SEP-911', '07MSU0170C', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('itam', 'MX', U&'Instituto Tecnol\00F3gico Aut\00F3nomo de M\00E9xico', 'ITAM', 'university', 'private', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, ARRAY[]::text[], 'SEP-911', '09MSU0124P', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-acapulco', 'MX', U&'Instituto Tecnol\00F3gico de Acapulco', NULL, 'technological_institute', 'public', 'Guerrero', U&'Acapulco de Ju\00E1rez', NULL, ARRAY[]::text[], 'SEP-911', '12MSU0276H', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-aguascalientes', 'MX', U&'Instituto Tecnol\00F3gico de Aguascalientes', NULL, 'technological_institute', 'public', 'Aguascalientes', 'Aguascalientes', NULL, ARRAY[]::text[], 'SEP-911', '01MSU0029T', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-apizaco', 'MX', U&'Instituto Tecnol\00F3gico de Apizaco', NULL, 'technological_institute', 'public', 'Tlaxcala', 'Tzompantepec', NULL, ARRAY[]::text[], 'SEP-911', '29MSU0009L', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-campeche', 'MX', U&'Instituto Tecnol\00F3gico de Campeche', NULL, 'technological_institute', 'public', 'Campeche', 'Campeche', NULL, ARRAY[]::text[], 'SEP-911', '04MSU0220X', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-cancun', 'MX', U&'Instituto Tecnol\00F3gico de Canc\00FAn', NULL, 'technological_institute', 'public', 'Quintana Roo', U&'Benito Ju\00E1rez', NULL, ARRAY[]::text[], 'SEP-911', '23MSU0105U', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-chilpancingo', 'MX', U&'Instituto Tecnol\00F3gico de Chilpancingo', NULL, 'technological_institute', 'public', 'Guerrero', 'Chilpancingo de los Bravo', NULL, ARRAY[]::text[], 'SEP-911', '12MSU0050B', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-ciudad-juarez', 'MX', U&'Instituto Tecnol\00F3gico de Ciudad Ju\00E1rez', NULL, 'technological_institute', 'public', 'Chihuahua', U&'Ju\00E1rez', NULL, ARRAY[]::text[], 'SEP-911', '08MSU0041H', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-ciudad-madero', 'MX', U&'Instituto Tecnol\00F3gico de Ciudad Madero', NULL, 'technological_institute', 'public', 'Tamaulipas', 'Ciudad Madero', NULL, ARRAY[]::text[], 'SEP-911', '28MSU0028A', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-colima', 'MX', U&'Instituto Tecnol\00F3gico de Colima', NULL, 'technological_institute', 'public', 'Colima', U&'Villa de \00C1lvarez', NULL, ARRAY[]::text[], 'SEP-911', '06MSU0020X', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-culiacan', 'MX', U&'Instituto Tecnol\00F3gico de Culiac\00E1n', NULL, 'technological_institute', 'public', 'Sinaloa', U&'Culiac\00E1n', NULL, ARRAY[]::text[], 'SEP-911', '25MSU0021K', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-durango', 'MX', U&'Instituto Tecnol\00F3gico de Durango', NULL, 'technological_institute', 'public', 'Durango', 'Durango', NULL, ARRAY[]::text[], 'SEP-911', '10MSU0028B', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-estudios-superiores-de-zamora', 'MX', U&'Instituto Tecnol\00F3gico de Estudios Superiores de Zamora', NULL, 'technological_institute', 'public', U&'Michoac\00E1n', 'Zamora', NULL, ARRAY[]::text[], 'SEP-911', '16MSU0074H', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-estudios-superiores-los-cabos', 'MX', U&'Instituto Tecnol\00F3gico de Estudios Superiores Los Cabos', NULL, 'technological_institute', 'public', 'Baja California Sur', 'Los Cabos', NULL, ARRAY[]::text[], 'SEP-911', '03MSU0046H', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-hermosillo', 'MX', U&'Instituto Tecnol\00F3gico de Hermosillo', NULL, 'technological_institute', 'public', 'Sonora', 'Hermosillo', NULL, ARRAY[]::text[], 'SEP-911', '26MSU0404P', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-la-laguna', 'MX', U&'Instituto Tecnol\00F3gico de La Laguna', NULL, 'technological_institute', 'public', 'Coahuila', U&'Torre\00F3n', NULL, ARRAY[]::text[], 'SEP-911', '05MSU0069Q', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-la-paz', 'MX', U&'Instituto Tecnol\00F3gico de La Paz', NULL, 'technological_institute', 'public', 'Baja California Sur', 'La Paz', NULL, ARRAY[]::text[], 'SEP-911', '03MSU0023X', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-los-mochis', 'MX', U&'Instituto Tecnol\00F3gico de Los Mochis', NULL, 'technological_institute', 'public', 'Sinaloa', 'Ahome', NULL, ARRAY[]::text[], 'SEP-911', '25MSU0389O', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-matamoros', 'MX', U&'Instituto Tecnol\00F3gico de Matamoros', NULL, 'technological_institute', 'public', 'Tamaulipas', 'Matamoros', NULL, ARRAY[]::text[], 'SEP-911', '28MSU0044S', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-merida', 'MX', U&'Instituto Tecnol\00F3gico de M\00E9rida', NULL, 'technological_institute', 'public', U&'Yucat\00E1n', U&'M\00E9rida', NULL, ARRAY[]::text[], 'SEP-911', '31MSU0023T', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-morelia', 'MX', U&'Instituto Tecnol\00F3gico de Morelia', NULL, 'technological_institute', 'public', U&'Michoac\00E1n', 'Morelia', NULL, ARRAY[]::text[], 'SEP-911', '16MSU0022B', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-nuevo-leon', 'MX', U&'Instituto Tecnol\00F3gico de Nuevo Le\00F3n', NULL, 'technological_institute', 'public', U&'Nuevo Le\00F3n', 'Guadalupe', NULL, ARRAY[]::text[], 'SEP-911', '19MSU1082U', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-oaxaca', 'MX', U&'Instituto Tecnol\00F3gico de Oaxaca', NULL, 'technological_institute', 'public', 'Oaxaca', U&'Oaxaca de Ju\00E1rez', NULL, ARRAY[]::text[], 'SEP-911', '20MSU0037Q', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-pachuca', 'MX', U&'Instituto Tecnol\00F3gico de Pachuca', NULL, 'technological_institute', 'public', 'Hidalgo', 'Pachuca de Soto', NULL, ARRAY[]::text[], 'SEP-911', '13MSU0025B', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-puebla', 'MX', U&'Instituto Tecnol\00F3gico de Puebla', NULL, 'technological_institute', 'public', 'Puebla', 'Puebla', NULL, ARRAY[]::text[], 'SEP-911', '21MSU0615Y', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-queretaro', 'MX', U&'Instituto Tecnol\00F3gico de Quer\00E9taro', NULL, 'technological_institute', 'public', U&'Quer\00E9taro', U&'Quer\00E9taro', NULL, ARRAY[U&'TecNM Campus Quer\00E9taro', U&'Tecnol\00F3gico Nacional de M\00E9xico, Campus Quer\00E9taro']::text[], 'SEP-911', '22MSU0024K', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-saltillo', 'MX', U&'Instituto Tecnol\00F3gico de Saltillo', NULL, 'technological_institute', 'public', 'Coahuila', 'Saltillo', NULL, ARRAY[]::text[], 'SEP-911', '05MSU0051R', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-san-luis-potosi', 'MX', U&'Instituto Tecnol\00F3gico de San Luis Potos\00ED', NULL, 'technological_institute', 'public', U&'San Luis Potos\00ED', U&'Soledad de Graciano S\00E1nchez', NULL, ARRAY[]::text[], 'SEP-911', '24MSU0223H', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-sonora', 'MX', U&'Instituto Tecnol\00F3gico de Sonora', 'ITSON', 'university', 'public', 'Sonora', 'Cajeme', NULL, ARRAY[]::text[], 'SEP-911', '26MSU0023H', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-tepic', 'MX', U&'Instituto Tecnol\00F3gico de Tepic', NULL, 'technological_institute', 'public', 'Nayarit', 'Tepic', NULL, ARRAY[]::text[], 'SEP-911', '18MSU0254Q', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-tijuana', 'MX', U&'Instituto Tecnol\00F3gico de Tijuana', NULL, 'technological_institute', 'public', 'Baja California', 'Tijuana', NULL, ARRAY[]::text[], 'SEP-911', '02MSU0023Y', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-tuxtla-gutierrez', 'MX', U&'Instituto Tecnol\00F3gico de Tuxtla Guti\00E9rrez', NULL, 'technological_institute', 'public', 'Chiapas', U&'Tuxtla Guti\00E9rrez', NULL, ARRAY[]::text[], 'SEP-911', '07MSU0003F', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-villahermosa', 'MX', U&'Instituto Tecnol\00F3gico de Villahermosa', NULL, 'technological_institute', 'public', 'Tabasco', 'Centro', NULL, ARRAY[]::text[], 'SEP-911', '27MSU0180X', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-zacatecas', 'MX', U&'Instituto Tecnol\00F3gico de Zacatecas', NULL, 'technological_institute', 'public', 'Zacatecas', 'Zacatecas', NULL, ARRAY[]::text[], 'SEP-911', '32MSU0025Q', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-de-zacatepec', 'MX', U&'Instituto Tecnol\00F3gico de Zacatepec', NULL, 'technological_institute', 'public', 'Morelos', 'Zacatepec', NULL, ARRAY[]::text[], 'SEP-911', '17MSU0237A', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-del-istmo', 'MX', U&'Instituto Tecnol\00F3gico del Istmo', NULL, 'technological_institute', 'public', 'Oaxaca', U&'Juchit\00E1n de Zaragoza', NULL, ARRAY[]::text[], 'SEP-911', '20MSU0052I', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-mario-molina', 'MX', U&'Instituto Tecnol\00F3gico Mario Molina', NULL, 'technological_institute', 'public', 'Jalisco', 'Zapopan', NULL, ARRAY[]::text[], 'SEP-911', '14MSU0295U', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-superior-de-calkini-en-el-estado-de-campeche', 'MX', U&'Instituto Tecnol\00F3gico Superior de Calkin\00ED en el Estado de Campeche', NULL, 'technological_institute', 'public', 'Campeche', U&'Calkin\00ED', NULL, ARRAY[]::text[], 'SEP-911', '04MSU0013P', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-superior-de-irapuato', 'MX', U&'Instituto Tecnol\00F3gico Superior de Irapuato', NULL, 'technological_institute', 'public', 'Guanajuato', 'Irapuato', NULL, ARRAY[]::text[], 'SEP-911', '11MSU0038H', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-superior-de-lerdo', 'MX', U&'Instituto Tecnol\00F3gico Superior de Lerdo', NULL, 'technological_institute', 'public', 'Durango', 'Lerdo', NULL, ARRAY[]::text[], 'SEP-911', '10MSU0012A', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-tecnologico-superior-de-xalapa', 'MX', U&'Instituto Tecnol\00F3gico Superior de Xalapa', NULL, 'technological_institute', 'public', 'Veracruz', 'Xalapa', NULL, ARRAY[]::text[], 'SEP-911', '30MSU0215J', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-universitario-del-centro-de-mexico', 'MX', U&'Instituto Universitario del Centro de M\00E9xico', NULL, 'university_institution', 'private', 'Guanajuato', U&'Le\00F3n', NULL, ARRAY[]::text[], 'SEP-911', '11MSU0151A', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('instituto-universitario-del-norte', 'MX', 'Instituto Universitario del Norte', NULL, 'university_institution', 'private', 'Coahuila', 'Saltillo', NULL, ARRAY[]::text[], 'SEP-911', '05MSU0047E', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('ites-rene-descartes', 'MX', U&'ITES Ren\00E9 Descartes', NULL, 'university_institution', 'private', 'Campeche', 'Campeche', NULL, ARRAY[]::text[], 'SEP-911', '04MSU0005G', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('iteso-universidad-jesuita-de-guadalajara', 'MX', 'ITESO, Universidad Jesuita de Guadalajara', 'ITESO', 'university', 'private', 'Jalisco', 'San Pedro Tlaquepaque', NULL, ARRAY[]::text[], 'SEP-911', '14MSU0044P', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('tecnologico-de-estudios-superiores-de-ecatepec', 'MX', U&'Tecnol\00F3gico de Estudios Superiores de Ecatepec', NULL, 'technological_institute', 'public', U&'Estado de M\00E9xico', 'Ecatepec de Morelos', NULL, ARRAY[]::text[], 'SEP-911', '15MSU0180S', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('tec', 'MX', U&'Tecnol\00F3gico de Monterrey', 'Tec', 'university', 'private', U&'Nuevo Le\00F3n', 'Monterrey', 'https://tec.mx', ARRAY['ITESM', U&'Instituto Tecnol\00F3gico y de Estudios Superiores de Monterrey']::text[], 'SEP-911', '19MSU0029S', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', true),
  ('universidad-alfa-y-omega', 'MX', 'Universidad Alfa y Omega', NULL, 'university', 'private', 'Tabasco', 'Centro', NULL, ARRAY[]::text[], 'SEP-911', '27MSU0004S', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('anahuac', 'MX', U&'Universidad An\00E1huac', U&'An\00E1huac', 'university', 'private', U&'Estado de M\00E9xico', 'Huixquilucan', NULL, ARRAY[]::text[], 'SEP-911', '15MSU0038D', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-anahuac-de-cancun', 'MX', U&'Universidad An\00E1huac de Canc\00FAn', NULL, 'university', 'private', 'Quintana Roo', U&'Benito Ju\00E1rez', NULL, ARRAY[]::text[], 'SEP-911', '23MSU0010G', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-agraria-antonio-narro', 'MX', U&'Universidad Aut\00F3noma Agraria Antonio Narro', NULL, 'university', 'public', 'Coahuila', 'Saltillo', NULL, ARRAY[]::text[], 'SEP-911', '05MSU0645A', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-benito-juarez-de-oaxaca', 'MX', U&'Universidad Aut\00F3noma Benito Ju\00E1rez de Oaxaca', 'UABJO', 'university', 'public', 'Oaxaca', U&'Oaxaca de Ju\00E1rez', NULL, ARRAY[]::text[], 'SEP-911', '20MSU0011I', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-chapingo', 'MX', U&'Universidad Aut\00F3noma Chapingo', NULL, 'university', 'public', U&'Estado de M\00E9xico', 'Texcoco', NULL, ARRAY[]::text[], 'SEP-911', '15MSU0020E', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-aguascalientes', 'MX', U&'Universidad Aut\00F3noma de Aguascalientes', 'UAA', 'university', 'public', 'Aguascalientes', 'Aguascalientes', NULL, ARRAY[]::text[], 'SEP-911', '01MSU0215O', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-baja-california', 'MX', U&'Universidad Aut\00F3noma de Baja California', 'UABC', 'university', 'public', 'Baja California', 'Tijuana', NULL, ARRAY[]::text[], 'SEP-911', '02MSU0020A', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-baja-california-sur', 'MX', U&'Universidad Aut\00F3noma de Baja California Sur', NULL, 'university', 'public', 'Baja California Sur', 'La Paz', NULL, ARRAY[]::text[], 'SEP-911', '03MSU0064X', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-campeche', 'MX', U&'Universidad Aut\00F3noma de Campeche', NULL, 'university', 'public', 'Campeche', 'Campeche', NULL, ARRAY[]::text[], 'SEP-911', '04MSU0018K', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-chiapas', 'MX', U&'Universidad Aut\00F3noma de Chiapas', 'UNACH', 'university', 'public', 'Chiapas', U&'Tuxtla Guti\00E9rrez', NULL, ARRAY[]::text[], 'SEP-911', '07MSU0001H', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-chihuahua', 'MX', U&'Universidad Aut\00F3noma de Chihuahua', 'UACH', 'university', 'public', 'Chihuahua', 'Chihuahua', NULL, ARRAY[]::text[], 'SEP-911', '08MSU0017H', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-ciudad-juarez', 'MX', U&'Universidad Aut\00F3noma de Ciudad Ju\00E1rez', 'UACJ', 'university', 'public', 'Chihuahua', U&'Ju\00E1rez', NULL, ARRAY[]::text[], 'SEP-911', '08MSU0245B', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-coahuila', 'MX', U&'Universidad Aut\00F3noma de Coahuila', 'UAdeC', 'university', 'public', 'Coahuila', U&'Torre\00F3n', NULL, ARRAY[]::text[], 'SEP-911', '05MSU0010R', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-durango', 'MX', U&'Universidad Aut\00F3noma de Durango', NULL, 'university', 'private', 'Durango', 'Durango', NULL, ARRAY[]::text[], 'SEP-911', '10MSU0060K', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-guadalajara', 'MX', U&'Universidad Aut\00F3noma de Guadalajara', 'UAG', 'university', 'private', 'Jalisco', 'Zapopan', NULL, ARRAY[]::text[], 'SEP-911', '14MSU0028Y', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-guerrero', 'MX', U&'Universidad Aut\00F3noma de Guerrero', 'UAGro', 'university', 'public', 'Guerrero', U&'Acapulco de Ju\00E1rez', NULL, ARRAY[]::text[], 'SEP-911', '12MSU0015W', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-la-ciudad-de-mexico', 'MX', U&'Universidad Aut\00F3noma de la Ciudad de M\00E9xico', 'UACM', 'university', 'public', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, ARRAY[]::text[], 'SEP-911', '09MSU0075X', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-nayarit', 'MX', U&'Universidad Aut\00F3noma de Nayarit', 'UAN', 'university', 'public', 'Nayarit', 'Tepic', NULL, ARRAY[]::text[], 'SEP-911', '18MSU0019M', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('uanl', 'MX', U&'Universidad Aut\00F3noma de Nuevo Le\00F3n', 'UANL', 'university', 'public', U&'Nuevo Le\00F3n', U&'San Nicol\00E1s de los Garza', 'https://www.uanl.mx', ARRAY[]::text[], 'SEP-911', '19MSU0011T', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-occidente', 'MX', U&'Universidad Aut\00F3noma de Occidente', NULL, 'university', 'public', 'Sinaloa', U&'Culiac\00E1n', NULL, ARRAY[]::text[], 'SEP-911', '25MSU0370Q', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('uaq', 'MX', U&'Universidad Aut\00F3noma de Quer\00E9taro', 'UAQ', 'university', 'public', U&'Quer\00E9taro', U&'Quer\00E9taro', NULL, ARRAY[]::text[], 'SEP-911', '22MSU0016B', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('uaslp', 'MX', U&'Universidad Aut\00F3noma de San Luis Potos\00ED', 'UASLP', 'university', 'public', U&'San Luis Potos\00ED', U&'San Luis Potos\00ED', NULL, ARRAY[]::text[], 'SEP-911', '24MSU0011E', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-sinaloa', 'MX', U&'Universidad Aut\00F3noma de Sinaloa', 'UAS', 'university', 'public', 'Sinaloa', U&'Culiac\00E1n', NULL, ARRAY[]::text[], 'SEP-911', '25MSU0013B', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-tamaulipas', 'MX', U&'Universidad Aut\00F3noma de Tamaulipas', 'UAT', 'university', 'public', 'Tamaulipas', 'Tampico', NULL, ARRAY[]::text[], 'SEP-911', '28MSU0010B', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-tlaxcala', 'MX', U&'Universidad Aut\00F3noma de Tlaxcala', 'UATx', 'university', 'public', 'Tlaxcala', 'Tlaxcala', NULL, ARRAY[]::text[], 'SEP-911', '29MSU0013Y', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-yucatan', 'MX', U&'Universidad Aut\00F3noma de Yucat\00E1n', 'UADY', 'university', 'public', U&'Yucat\00E1n', U&'M\00E9rida', NULL, ARRAY[]::text[], 'SEP-911', '31MSU0098J', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-de-zacatecas', 'MX', U&'Universidad Aut\00F3noma de Zacatecas', 'UAZ', 'university', 'public', 'Zacatecas', 'Zacatecas', NULL, ARRAY[]::text[], 'SEP-911', '32MSU0017H', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-del-carmen', 'MX', U&'Universidad Aut\00F3noma del Carmen', NULL, 'university', 'public', 'Campeche', 'Carmen', NULL, ARRAY[]::text[], 'SEP-911', '04MSU0238W', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-del-estado-de-hidalgo', 'MX', U&'Universidad Aut\00F3noma del Estado de Hidalgo', 'UAEH', 'university', 'public', 'Hidalgo', U&'San Agust\00EDn Tlaxiaca', NULL, ARRAY[]::text[], 'SEP-911', '13MSU0017T', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('uaemex', 'MX', U&'Universidad Aut\00F3noma del Estado de M\00E9xico', U&'UAEM\00E9x', 'university', 'public', U&'Estado de M\00E9xico', 'Toluca', NULL, ARRAY[]::text[], 'SEP-911', '15MSU0012W', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-del-estado-de-morelos', 'MX', U&'Universidad Aut\00F3noma del Estado de Morelos', 'UAEM', 'university', 'public', 'Morelos', 'Cuernavaca', NULL, ARRAY[]::text[], 'SEP-911', '17MSU0017P', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-del-estado-de-quintana-roo', 'MX', U&'Universidad Aut\00F3noma del Estado de Quintana Roo', NULL, 'university', 'public', 'Quintana Roo', U&'Oth\00F3n P. Blanco', NULL, ARRAY[]::text[], 'SEP-911', '23MSU0140Z', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-autonoma-del-noreste', 'MX', U&'Universidad Aut\00F3noma del Noreste', NULL, 'university', 'private', 'Coahuila', 'Saltillo', NULL, ARRAY[]::text[], 'SEP-911', '05MSU0652K', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('uam', 'MX', U&'Universidad Aut\00F3noma Metropolitana', 'UAM', 'university', 'public', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, ARRAY[]::text[], 'SEP-911', '09MSU0084E', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-britanica-de-mexico', 'MX', U&'Universidad Brit\00E1nica de M\00E9xico', NULL, 'university', 'private', 'Aguascalientes', 'Aguascalientes', NULL, ARRAY[]::text[], 'SEP-911', '01MSU0028U', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-cristobal-colon', 'MX', U&'Universidad Crist\00F3bal Col\00F3n', NULL, 'university', 'private', 'Veracruz', 'Veracruz', NULL, ARRAY[]::text[], 'SEP-911', '30MSU0832U', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-cuauhtemoc', 'MX', U&'Universidad Cuauht\00E9moc', NULL, 'university', 'private', 'Aguascalientes', U&'Jes\00FAs Mar\00EDa', NULL, ARRAY[]::text[], 'SEP-911', '01MSU0060C', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-cultural', 'MX', 'Universidad Cultural', NULL, 'university', 'private', 'Chihuahua', U&'Ju\00E1rez', NULL, ARRAY[]::text[], 'SEP-911', '08MSU0684Z', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-de-ciencias-y-artes-de-chiapas', 'MX', 'Universidad de Ciencias y Artes de Chiapas', NULL, 'university', 'public', 'Chiapas', U&'Tuxtla Guti\00E9rrez', NULL, ARRAY[]::text[], 'SEP-911', '07MSU0002G', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-de-colima', 'MX', 'Universidad de Colima', 'UdeC', 'university', 'public', 'Colima', 'Colima', NULL, ARRAY[]::text[], 'SEP-911', '06MSU0012O', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('udg', 'MX', 'Universidad de Guadalajara', 'UdeG', 'university', 'public', 'Jalisco', 'Guadalajara', 'https://www.udg.mx', ARRAY[]::text[], 'SEP-911', '14MSU0010Z', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-de-guanajuato', 'MX', 'Universidad de Guanajuato', 'UG', 'university', 'public', 'Guanajuato', 'Guanajuato', NULL, ARRAY[]::text[], 'SEP-911', '11MSU0013Z', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-de-la-salud', 'MX', 'Universidad de la Salud', NULL, 'university', 'public', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, ARRAY[]::text[], 'SEP-911', '09MSU0349W', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('udlap', 'MX', U&'Universidad de las Am\00E9ricas Puebla', 'UDLAP', 'university', 'private', 'Puebla', U&'San Andr\00E9s Cholula', NULL, ARRAY[]::text[], 'SEP-911', '21MSU0649O', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-de-leon', 'MX', U&'Universidad de Le\00F3n', NULL, 'university', 'private', 'Guanajuato', U&'Le\00F3n', NULL, ARRAY[]::text[], 'SEP-911', '11MSU0047P', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-de-los-mochis', 'MX', 'Universidad de Los Mochis', NULL, 'university', 'private', 'Sinaloa', 'Ahome', NULL, ARRAY[]::text[], 'SEP-911', '25MSU0058Y', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-de-monterrey', 'MX', 'Universidad de Monterrey', 'UDEM', 'university', 'private', U&'Nuevo Le\00F3n', U&'San Pedro Garza Garc\00EDa', NULL, ARRAY[]::text[], 'SEP-911', '19MSU0037A', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-de-oriente-veracruz', 'MX', 'Universidad de Oriente - Veracruz', NULL, 'university', 'private', 'Veracruz', 'Veracruz', NULL, ARRAY[]::text[], 'SEP-911', '30MSU0250P', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-de-sonora', 'MX', 'Universidad de Sonora', 'Unison', 'university', 'public', 'Sonora', 'Hermosillo', NULL, ARRAY[]::text[], 'SEP-911', '26MSU0015Z', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-del-atlantico', 'MX', U&'Universidad del Atl\00E1ntico', NULL, 'university', 'private', 'Tamaulipas', 'Reynosa', NULL, ARRAY[]::text[], 'SEP-911', '28MSU0011A', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-del-caribe', 'MX', 'Universidad del Caribe', NULL, 'university', 'public', 'Quintana Roo', U&'Benito Ju\00E1rez', NULL, ARRAY[]::text[], 'SEP-911', '23MSU0012E', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-del-desarrollo-profesional', 'MX', 'Universidad del Desarrollo Profesional', NULL, 'university', 'private', 'Sonora', 'Hermosillo', NULL, ARRAY[]::text[], 'SEP-911', '26MSU0011C', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-del-golfo-de-california', 'MX', 'Universidad del Golfo de California', 'UGC', 'university', 'private', 'Baja California Sur', 'Los Cabos', NULL, ARRAY[]::text[], 'SEP-911', '03MSU0009D', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-del-valle-de-cuernavaca', 'MX', 'Universidad del Valle de Cuernavaca', NULL, 'university', 'private', 'Morelos', 'Cuernavaca', NULL, ARRAY[]::text[], 'SEP-911', '17MSU0333D', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-del-valle-de-mexico', 'MX', U&'Universidad del Valle de M\00E9xico', 'UVM', 'university', 'private', U&'Estado de M\00E9xico', U&'Coacalco de Berrioz\00E1bal', NULL, ARRAY[]::text[], 'SEP-911', '15MSU0100Q', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-estatal-de-sonora', 'MX', 'Universidad Estatal de Sonora', NULL, 'university', 'public', 'Sonora', 'Hermosillo', NULL, ARRAY[]::text[], 'SEP-911', '26MSU0430N', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-hipocrates', 'MX', U&'Universidad Hip\00F3crates', NULL, 'university', 'private', 'Guerrero', U&'Acapulco de Ju\00E1rez', NULL, ARRAY[]::text[], 'SEP-911', '12MSU0026B', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('ibero', 'MX', 'Universidad Iberoamericana', 'Ibero', 'university', 'private', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, ARRAY[]::text[], 'SEP-911', '09MSU0035W', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-iberoamericana-puebla', 'MX', 'Universidad Iberoamericana Puebla', NULL, 'university', 'private', 'Puebla', U&'San Andr\00E9s Cholula', NULL, ARRAY[]::text[], 'SEP-911', '21MSU0989M', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-internacional', 'MX', 'Universidad Internacional', NULL, 'university', 'private', 'Morelos', 'Cuernavaca', NULL, ARRAY[]::text[], 'SEP-911', '17MSU0332E', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-juarez-autonoma-de-tabasco', 'MX', U&'Universidad Ju\00E1rez Aut\00F3noma de Tabasco', 'UJAT', 'university', 'public', 'Tabasco', 'Centro', NULL, ARRAY[]::text[], 'SEP-911', '27MSU0018V', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-juarez-del-estado-de-durango', 'MX', U&'Universidad Ju\00E1rez del Estado de Durango', 'UJED', 'university', 'public', 'Durango', 'Durango', NULL, ARRAY[]::text[], 'SEP-911', '10MSU0010C', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-la-salle-cancun', 'MX', U&'Universidad La Salle Canc\00FAn', NULL, 'university', 'private', 'Quintana Roo', U&'Benito Ju\00E1rez', NULL, ARRAY[]::text[], 'SEP-911', '23MSU0135O', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-la-salle-chihuahua', 'MX', 'Universidad La Salle Chihuahua', NULL, 'university', 'private', 'Chihuahua', 'Chihuahua', NULL, ARRAY[]::text[], 'SEP-911', '08MSU0029M', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-la-salle-laguna', 'MX', 'Universidad La Salle Laguna', NULL, 'university', 'private', 'Durango', U&'G\00F3mez Palacio', NULL, ARRAY[]::text[], 'SEP-911', '10MSU0182V', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-la-salle-noroeste', 'MX', 'Universidad La Salle Noroeste', NULL, 'university', 'private', 'Sonora', 'Cajeme', NULL, ARRAY[]::text[], 'SEP-911', '26MSU0090F', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-la-salle-oaxaca', 'MX', 'Universidad La Salle Oaxaca', NULL, 'university', 'private', 'Oaxaca', U&'Santa Cruz Xoxocotl\00E1n', NULL, ARRAY[]::text[], 'SEP-911', '20MSU0059B', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-marista-de-merida', 'MX', U&'Universidad Marista de M\00E9rida', NULL, 'university', 'private', U&'Yucat\00E1n', U&'M\00E9rida', NULL, ARRAY[]::text[], 'SEP-911', '31MSU0008A', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-metropolitana-de-monterrey', 'MX', 'Universidad Metropolitana de Monterrey', NULL, 'university', 'private', U&'Nuevo Le\00F3n', 'Monterrey', NULL, ARRAY[]::text[], 'SEP-911', '19MSU0110T', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-mexiquense-del-bicentenario', 'MX', 'Universidad Mexiquense del Bicentenario', NULL, 'university', 'public', U&'Estado de M\00E9xico', 'Ecatepec de Morelos', NULL, ARRAY[]::text[], 'SEP-911', '15MSU0945E', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-michoacana-de-san-nicolas-de-hidalgo', 'MX', U&'Universidad Michoacana de San Nicol\00E1s de Hidalgo', 'UMSNH', 'university', 'public', U&'Michoac\00E1n', 'Morelia', NULL, ARRAY[]::text[], 'SEP-911', '16MSU0014T', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-montrer', 'MX', 'Universidad Montrer', NULL, 'university', 'private', U&'Michoac\00E1n', 'Morelia', NULL, ARRAY[]::text[], 'SEP-911', '16MSU0047K', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-mundo-maya', 'MX', 'Universidad Mundo Maya', NULL, 'university', 'private', 'Tabasco', 'Centro', NULL, ARRAY[]::text[], 'SEP-911', '27MSU0003T', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('unam', 'MX', U&'Universidad Nacional Aut\00F3noma de M\00E9xico', 'UNAM', 'university', 'public', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', 'https://www.unam.mx', ARRAY[]::text[], 'SEP-911', '09MSU0019E', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-olmeca', 'MX', 'Universidad Olmeca', NULL, 'university', 'private', 'Tabasco', 'Centro', NULL, ARRAY[]::text[], 'SEP-911', '27MSU0002U', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-pablo-guardado-chavez', 'MX', U&'Universidad Pablo Guardado Ch\00E1vez', NULL, 'university', 'private', 'Chiapas', U&'Tuxtla Guti\00E9rrez', NULL, ARRAY[]::text[], 'SEP-911', '07MSU0019G', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('up', 'MX', 'Universidad Panamericana', 'UP', 'university', 'private', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, ARRAY[]::text[], 'SEP-911', '09MSU2515R', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-politecnica-de-san-luis-potosi', 'MX', U&'Universidad Polit\00E9cnica de San Luis Potos\00ED', NULL, 'polytechnic_university', 'public', U&'San Luis Potos\00ED', U&'San Luis Potos\00ED', NULL, ARRAY[]::text[], 'SEP-911', '24MSU0240Y', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-politecnica-de-tlaxcala', 'MX', U&'Universidad Polit\00E9cnica de Tlaxcala', NULL, 'polytechnic_university', 'public', 'Tlaxcala', 'Tepeyanco', NULL, ARRAY[]::text[], 'SEP-911', '29MSU0029Z', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-popular-autonoma-del-estado-de-puebla', 'MX', U&'Universidad Popular Aut\00F3noma del Estado de Puebla', 'UPAEP', 'university', 'private', 'Puebla', 'Puebla', NULL, ARRAY[]::text[], 'SEP-911', '21MSU0931M', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-popular-de-la-chontalpa', 'MX', 'Universidad Popular de la Chontalpa', NULL, 'university', 'public', 'Tabasco', U&'C\00E1rdenas', NULL, ARRAY[]::text[], 'SEP-911', '27MSU0025E', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-potosina', 'MX', 'Universidad Potosina', NULL, 'university', 'private', U&'San Luis Potos\00ED', U&'San Luis Potos\00ED', NULL, ARRAY[]::text[], 'SEP-911', '24MSU0021L', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-regional-del-sureste', 'MX', 'Universidad Regional del Sureste', NULL, 'university', 'private', 'Oaxaca', U&'San Sebasti\00E1n Tutla', NULL, ARRAY[]::text[], 'SEP-911', '20MSU0549Q', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-tangamanga', 'MX', 'Universidad Tangamanga', NULL, 'university', 'private', U&'San Luis Potos\00ED', U&'San Luis Potos\00ED', NULL, ARRAY[]::text[], 'SEP-911', '24MSU0150F', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-tec-milenio-a-c', 'MX', 'Universidad Tec Milenio A.c', NULL, 'university', 'private', 'Sinaloa', U&'Culiac\00E1n', NULL, ARRAY[]::text[], 'SEP-911', '25MSU0085V', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-tecnologica-de-aguascalientes', 'MX', U&'Universidad Tecnol\00F3gica de Aguascalientes', NULL, 'technological_university', 'public', 'Aguascalientes', 'Aguascalientes', NULL, ARRAY[]::text[], 'SEP-911', '01MSU0050W', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-tecnologica-de-ciudad-juarez', 'MX', U&'Universidad Tecnol\00F3gica de Ciudad Ju\00E1rez', NULL, 'technological_university', 'public', 'Chihuahua', U&'Ju\00E1rez', NULL, ARRAY[]::text[], 'SEP-911', '08MSU0016I', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-tecnologica-de-jalisco', 'MX', U&'Universidad Tecnol\00F3gica de Jalisco', NULL, 'technological_university', 'public', 'Jalisco', 'Guadalajara', NULL, ARRAY[]::text[], 'SEP-911', '14MSU0021E', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-tecnologica-de-leon', 'MX', U&'Universidad Tecnol\00F3gica de Le\00F3n', NULL, 'technological_university', 'public', 'Guanajuato', U&'Le\00F3n', NULL, ARRAY[]::text[], 'SEP-911', '11MSU0034L', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-tecnologica-de-manzanillo', 'MX', U&'Universidad Tecnol\00F3gica de Manzanillo', NULL, 'technological_university', 'public', 'Colima', 'Manzanillo', NULL, ARRAY[]::text[], 'SEP-911', '06MSU0010Q', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-tecnologica-de-mexico', 'MX', U&'Universidad Tecnol\00F3gica de M\00E9xico', 'UNITEC', 'university', 'private', U&'Estado de M\00E9xico', U&'Atizap\00E1n de Zaragoza', NULL, ARRAY[]::text[], 'SEP-911', '15MSU2012J', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-tecnologica-de-nayarit', 'MX', U&'Universidad Tecnol\00F3gica de Nayarit', NULL, 'technological_university', 'public', 'Nayarit', 'Xalisco', NULL, ARRAY[]::text[], 'SEP-911', '18MSU8888C', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-tecnologica-de-puebla', 'MX', U&'Universidad Tecnol\00F3gica de Puebla', NULL, 'technological_university', 'public', 'Puebla', 'Puebla', NULL, ARRAY[]::text[], 'SEP-911', '21MSU1001H', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-tecnologica-de-queretaro', 'MX', U&'Universidad Tecnol\00F3gica de Quer\00E9taro', NULL, 'technological_university', 'public', U&'Quer\00E9taro', U&'Quer\00E9taro', NULL, ARRAY[]::text[], 'SEP-911', '22MSU0003Y', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-tecnologica-de-tijuana', 'MX', U&'Universidad Tecnol\00F3gica de Tijuana', NULL, 'technological_university', 'public', 'Baja California', 'Tijuana', NULL, ARRAY[]::text[], 'SEP-911', '02MSU0045J', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-tecnologica-del-centro-de-veracruz', 'MX', U&'Universidad Tecnol\00F3gica del Centro de Veracruz', NULL, 'technological_university', 'public', 'Veracruz', U&'Cuitl\00E1huac', NULL, ARRAY[]::text[], 'SEP-911', '30MSU9027Z', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-tecnologica-del-estado-de-zacatecas', 'MX', U&'Universidad Tecnol\00F3gica del Estado de Zacatecas', NULL, 'technological_university', 'public', 'Zacatecas', 'Guadalupe', NULL, ARRAY[]::text[], 'SEP-911', '32MSU0003E', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-tecnologica-emiliano-zapata-del-estado-de-morelos', 'MX', U&'Universidad Tecnol\00F3gica Emiliano Zapata del Estado de Morelos', NULL, 'technological_university', 'public', 'Morelos', 'Emiliano Zapata', NULL, ARRAY[]::text[], 'SEP-911', '17MSU0024Z', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-tecnologica-metropolitana', 'MX', U&'Universidad Tecnol\00F3gica Metropolitana', NULL, 'technological_university', 'public', U&'Yucat\00E1n', U&'M\00E9rida', NULL, ARRAY[]::text[], 'SEP-911', '31MSU0026Q', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-tecnologica-santa-catarina', 'MX', U&'Universidad Tecnol\00F3gica Santa Catarina', NULL, 'technological_university', 'public', U&'Nuevo Le\00F3n', 'Santa Catarina', NULL, ARRAY[]::text[], 'SEP-911', '19MSU0025W', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-tecnologica-tula-tepeji', 'MX', U&'Universidad Tecnol\00F3gica Tula-Tepeji', NULL, 'technological_university', 'public', 'Hidalgo', 'Tula de Allende', NULL, ARRAY[]::text[], 'SEP-911', '13MSU0006N', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-univer-milenium', 'MX', 'Universidad Univer Milenium', NULL, 'university', 'private', U&'Estado de M\00E9xico', 'Toluca', NULL, ARRAY[]::text[], 'SEP-911', '15MSU0979V', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-vasco-de-quiroga', 'MX', 'Universidad Vasco de Quiroga', NULL, 'university', 'private', U&'Michoac\00E1n', 'Morelia', NULL, ARRAY[]::text[], 'SEP-911', '16MSU0567T', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-veracruzana', 'MX', 'Universidad Veracruzana', 'UV', 'university', 'public', 'Veracruz', 'Xalapa', NULL, ARRAY[]::text[], 'SEP-911', '30MSU0940B', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('universidad-vizcaya-de-las-americas', 'MX', U&'Universidad Vizcaya de las Am\00E9ricas', NULL, 'university', 'private', U&'Yucat\00E1n', U&'M\00E9rida', NULL, ARRAY[]::text[], 'SEP-911', '31MSU0660R', 'https://www.datos.gob.mx/dataset/registro_alumnado_personal_docente_educacion_basica_media_superior_formato_911', '2026-09-14', false),
  ('american-river-college', 'US', 'American River College', NULL, 'community_college', 'public', 'California', 'Sacramento', 'https://www.arc.losrios.edu', ARRAY['American River', 'ARC']::text[], 'IPEDS', '109208', 'https://nces.ed.gov/collegenavigator/?id=109208', '2026-09-14', false),
  ('anderson-university', 'US', 'Anderson University', NULL, 'university', 'private', 'South Carolina', 'Anderson', 'https://www.andersonuniversity.edu', ARRAY['AU']::text[], 'IPEDS', '217633', 'https://nces.ed.gov/collegenavigator/?id=217633', '2026-09-14', false),
  ('anne-arundel-community-college', 'US', 'Anne Arundel Community College', NULL, 'community_college', 'public', 'Maryland', 'Arnold', 'https://www.aacc.edu', ARRAY['AACC']::text[], 'IPEDS', '161767', 'https://nces.ed.gov/collegenavigator/?id=161767', '2026-09-14', false),
  ('anoka-ramsey-community-college', 'US', 'Anoka-Ramsey Community College', NULL, 'community_college', 'public', 'Minnesota', 'Coon Rapids', 'https://www.anokaramsey.edu', ARRAY['Anoka-Ramsey Community College-Coon Rapids Campus', 'Anoka-Ramsey Community College-Cambridge Campus', 'ARCC', 'AR', 'Anoka Ramsey']::text[], 'IPEDS', '172963', 'https://nces.ed.gov/collegenavigator/?id=172963', '2026-09-14', false),
  ('arizona-christian-university', 'US', 'Arizona Christian University', NULL, 'university', 'private', 'Arizona', 'Glendale', 'https://arizonachristian.edu', ARRAY[]::text[], 'IPEDS', '105899', 'https://nces.ed.gov/collegenavigator/?id=105899', '2026-09-14', false),
  ('arizona-state-university', 'US', 'Arizona State University', NULL, 'university', 'public', 'Arizona', 'Tempe', 'https://www.asu.edu', ARRAY['ASU Tempe']::text[], 'IPEDS', '104151', 'https://nces.ed.gov/collegenavigator/?id=104151', '2026-09-14', false),
  ('arkansas-state-university', 'US', 'Arkansas State University', NULL, 'university', 'public', 'Arkansas', 'Jonesboro', 'https://www.astate.edu', ARRAY['A-State', 'AState']::text[], 'IPEDS', '106458', 'https://nces.ed.gov/collegenavigator/?id=106458', '2026-09-14', false),
  ('auburn-university', 'US', 'Auburn University', NULL, 'university', 'public', 'Alabama', 'Auburn', 'https://www.auburn.edu', ARRAY[]::text[], 'IPEDS', '100858', 'https://nces.ed.gov/collegenavigator/?id=100858', '2026-09-14', false),
  ('augustana-university', 'US', 'Augustana University', NULL, 'university', 'private', 'South Dakota', 'Sioux Falls', 'https://www.augie.edu', ARRAY['Augie  Augustana College(SD)  Augustana University']::text[], 'IPEDS', '219000', 'https://nces.ed.gov/collegenavigator/?id=219000', '2026-09-14', false),
  ('baker-university', 'US', 'Baker University', NULL, 'university', 'private', 'Kansas', 'Baldwin City', 'https://www.bakeru.edu', ARRAY['Baker', 'BU', 'Baker U']::text[], 'IPEDS', '154688', 'https://nces.ed.gov/collegenavigator/?id=154688', '2026-09-14', false),
  ('ball-state-university', 'US', 'Ball State University', NULL, 'university', 'public', 'Indiana', 'Muncie', 'https://www.bsu.edu', ARRAY['BSU', 'Ball U']::text[], 'IPEDS', '150136', 'https://nces.ed.gov/collegenavigator/?id=150136', '2026-09-14', false),
  ('bates-technical-college', 'US', 'Bates Technical College', NULL, 'community_college', 'public', 'Washington', 'Tacoma', 'https://www.batestech.edu', ARRAY[]::text[], 'IPEDS', '235671', 'https://nces.ed.gov/collegenavigator/?id=235671', '2026-09-14', false),
  ('baton-rouge-community-college', 'US', 'Baton Rouge Community College', NULL, 'community_college', 'public', 'Louisiana', 'Baton Rouge', 'https://www.mybrcc.edu', ARRAY['BRCC']::text[], 'IPEDS', '437103', 'https://nces.ed.gov/collegenavigator/?id=437103', '2026-09-14', false),
  ('baylor-university', 'US', 'Baylor University', NULL, 'university', 'private', 'Texas', 'Waco', 'https://www.baylor.edu', ARRAY[]::text[], 'IPEDS', '223232', 'https://nces.ed.gov/collegenavigator/?id=223232', '2026-09-14', false),
  ('bellevue-university', 'US', 'Bellevue University', NULL, 'university', 'private', 'Nebraska', 'Bellevue', 'https://www.bellevue.edu', ARRAY[]::text[], 'IPEDS', '180814', 'https://nces.ed.gov/collegenavigator/?id=180814', '2026-09-14', false),
  ('bergen-community-college', 'US', 'Bergen Community College', NULL, 'community_college', 'public', 'New Jersey', 'Paramus', 'https://www.bergen.edu', ARRAY[]::text[], 'IPEDS', '183743', 'https://nces.ed.gov/collegenavigator/?id=183743', '2026-09-14', false),
  ('blue-ridge-community-and-technical-college', 'US', 'Blue Ridge Community and Technical College', NULL, 'community_college', 'public', 'West Virginia', 'Martinsburg', 'https://www.blueridgectc.edu', ARRAY[]::text[], 'IPEDS', '446774', 'https://nces.ed.gov/collegenavigator/?id=446774', '2026-09-14', false),
  ('bluegrass-community-and-technical-college', 'US', 'Bluegrass Community and Technical College', NULL, 'community_college', 'public', 'Kentucky', 'Lexington', 'https://bluegrass.kctcs.edu', ARRAY[]::text[], 'IPEDS', '156392', 'https://nces.ed.gov/collegenavigator/?id=156392', '2026-09-14', false),
  ('boise-state-university', 'US', 'Boise State University', NULL, 'university', 'public', 'Idaho', 'Boise', 'https://www.boisestate.edu', ARRAY['Boise State']::text[], 'IPEDS', '142115', 'https://nces.ed.gov/collegenavigator/?id=142115', '2026-09-14', false),
  ('boston-university', 'US', 'Boston University', NULL, 'university', 'private', 'Massachusetts', 'Boston', 'https://www.bu.edu', ARRAY['BU', 'Boston U']::text[], 'IPEDS', '164988', 'https://nces.ed.gov/collegenavigator/?id=164988', '2026-09-14', false),
  ('brigham-young-university', 'US', 'Brigham Young University', NULL, 'university', 'private', 'Utah', 'Provo', 'https://byu.edu', ARRAY['BYU']::text[], 'IPEDS', '230038', 'https://nces.ed.gov/collegenavigator/?id=230038', '2026-09-14', false),
  ('brigham-young-university-hawaii', 'US', 'Brigham Young University-Hawaii', NULL, 'university', 'private', 'Hawaii', 'Laie', 'https://www.byuh.edu', ARRAY[]::text[], 'IPEDS', '230047', 'https://nces.ed.gov/collegenavigator/?id=230047', '2026-09-14', false),
  ('brigham-young-university-idaho', 'US', 'Brigham Young University-Idaho', NULL, 'university', 'private', 'Idaho', 'Rexburg', 'https://www.byui.edu', ARRAY['BYU-I']::text[], 'IPEDS', '142522', 'https://nces.ed.gov/collegenavigator/?id=142522', '2026-09-14', false),
  ('bristol-community-college', 'US', 'Bristol Community College', NULL, 'community_college', 'public', 'Massachusetts', 'Fall River', 'https://www.bristolcc.edu', ARRAY['Bristol']::text[], 'IPEDS', '165033', 'https://nces.ed.gov/collegenavigator/?id=165033', '2026-09-14', false),
  ('brown-university', 'US', 'Brown University', NULL, 'university', 'private', 'Rhode Island', 'Providence', 'https://www.brown.edu', ARRAY[]::text[], 'IPEDS', '217156', 'https://nces.ed.gov/collegenavigator/?id=217156', '2026-09-14', false),
  ('buena-vista-university', 'US', 'Buena Vista University', NULL, 'university', 'private', 'Iowa', 'Storm Lake', 'https://www.bvu.edu', ARRAY[]::text[], 'IPEDS', '153001', 'https://nces.ed.gov/collegenavigator/?id=153001', '2026-09-14', false),
  ('carroll-college', 'US', 'Carroll College', NULL, 'college', 'private', 'Montana', 'Helena', 'https://www.carroll.edu', ARRAY['Carroll Montana  CC']::text[], 'IPEDS', '180106', 'https://nces.ed.gov/collegenavigator/?id=180106', '2026-09-14', false),
  ('case-western-reserve-university', 'US', 'Case Western Reserve University', NULL, 'university', 'private', 'Ohio', 'Cleveland', 'https://www.case.edu', ARRAY['CWRU', 'Case', 'Case Western Reserve']::text[], 'IPEDS', '201645', 'https://nces.ed.gov/collegenavigator/?id=201645', '2026-09-14', false),
  ('casper-college', 'US', 'Casper College', NULL, 'community_college', 'public', 'Wyoming', 'Casper', 'https://www.caspercollege.edu', ARRAY[]::text[], 'IPEDS', '240505', 'https://nces.ed.gov/collegenavigator/?id=240505', '2026-09-14', false),
  ('central-connecticut-state-university', 'US', 'Central Connecticut State University', NULL, 'university', 'public', 'Connecticut', 'New Britain', 'https://www.ccsu.edu', ARRAY['CCSU']::text[], 'IPEDS', '128771', 'https://nces.ed.gov/collegenavigator/?id=128771', '2026-09-14', false),
  ('central-georgia-technical-college', 'US', 'Central Georgia Technical College', NULL, 'community_college', 'public', 'Georgia', 'Warner Robins', 'https://www.centralgatech.edu', ARRAY['CGTC']::text[], 'IPEDS', '483045', 'https://nces.ed.gov/collegenavigator/?id=483045', '2026-09-14', false),
  ('central-new-mexico-community-college', 'US', 'Central New Mexico Community College', NULL, 'community_college', 'public', 'New Mexico', 'Albuquerque', 'https://www.cnm.edu', ARRAY['CNM']::text[], 'IPEDS', '187532', 'https://nces.ed.gov/collegenavigator/?id=187532', '2026-09-14', false),
  ('central-wyoming-college', 'US', 'Central Wyoming College', NULL, 'college', 'public', 'Wyoming', 'Riverton', 'https://www.cwc.edu', ARRAY['CWC', 'Central Wyoming Community College', 'Central']::text[], 'IPEDS', '240514', 'https://nces.ed.gov/collegenavigator/?id=240514', '2026-09-14', false),
  ('champlain-college', 'US', 'Champlain College', NULL, 'college', 'private', 'Vermont', 'Burlington', 'https://www.champlain.edu', ARRAY[]::text[], 'IPEDS', '230852', 'https://nces.ed.gov/collegenavigator/?id=230852', '2026-09-14', false),
  ('chandler-gilbert-community-college', 'US', 'Chandler-Gilbert Community College', NULL, 'community_college', 'public', 'Arizona', 'Chandler', 'https://www.cgc.maricopa.edu', ARRAY[]::text[], 'IPEDS', '364025', 'https://nces.ed.gov/collegenavigator/?id=364025', '2026-09-14', false),
  ('chattanooga-state-community-college', 'US', 'Chattanooga State Community College', NULL, 'community_college', 'public', 'Tennessee', 'Chattanooga', 'https://www.chattanoogastate.edu', ARRAY[]::text[], 'IPEDS', '219824', 'https://nces.ed.gov/collegenavigator/?id=219824', '2026-09-14', false),
  ('clemson-university', 'US', 'Clemson University', NULL, 'university', 'public', 'South Carolina', 'Clemson', 'https://www.clemson.edu', ARRAY[]::text[], 'IPEDS', '217882', 'https://nces.ed.gov/collegenavigator/?id=217882', '2026-09-14', false),
  ('coastal-alabama-community-college', 'US', 'Coastal Alabama Community College', NULL, 'community_college', 'public', 'Alabama', 'Bay Minette', 'https://www.coastalalabama.edu', ARRAY[]::text[], 'IPEDS', '101161', 'https://nces.ed.gov/collegenavigator/?id=101161', '2026-09-14', false),
  ('college-of-dupage', 'US', 'College of DuPage', NULL, 'community_college', 'public', 'Illinois', 'Glen Ellyn', 'https://www.cod.edu', ARRAY['COD']::text[], 'IPEDS', '144865', 'https://nces.ed.gov/collegenavigator/?id=144865', '2026-09-14', false),
  ('college-of-western-idaho', 'US', 'College of Western Idaho', NULL, 'community_college', 'public', 'Idaho', 'Nampa', 'https://cwi.edu', ARRAY['CWI']::text[], 'IPEDS', '455114', 'https://nces.ed.gov/collegenavigator/?id=455114', '2026-09-14', false),
  ('colorado-state-university-fort-collins', 'US', 'Colorado State University-Fort Collins', NULL, 'university', 'public', 'Colorado', 'Fort Collins', 'https://colostate.edu', ARRAY[]::text[], 'IPEDS', '126818', 'https://nces.ed.gov/collegenavigator/?id=126818', '2026-09-14', false),
  ('columbus-state-community-college', 'US', 'Columbus State Community College', NULL, 'community_college', 'public', 'Ohio', 'Columbus', 'https://www.cscc.edu', ARRAY['Columbus State', 'CSCC', 'C-State']::text[], 'IPEDS', '202222', 'https://nces.ed.gov/collegenavigator/?id=202222', '2026-09-14', false),
  ('community-college-of-allegheny-county', 'US', 'Community College of Allegheny County', NULL, 'community_college', 'public', 'Pennsylvania', 'Pittsburgh', 'https://www.ccac.edu', ARRAY['CCAC']::text[], 'IPEDS', '210605', 'https://nces.ed.gov/collegenavigator/?id=210605', '2026-09-14', false),
  ('community-college-of-aurora', 'US', 'Community College of Aurora', NULL, 'community_college', 'public', 'Colorado', 'Aurora', 'https://www.ccaurora.edu', ARRAY[]::text[], 'IPEDS', '126863', 'https://nces.ed.gov/collegenavigator/?id=126863', '2026-09-14', false),
  ('community-college-of-rhode-island', 'US', 'Community College of Rhode Island', NULL, 'community_college', 'public', 'Rhode Island', 'Warwick', 'https://www.ccri.edu', ARRAY['CCRI']::text[], 'IPEDS', '217475', 'https://nces.ed.gov/collegenavigator/?id=217475', '2026-09-14', false),
  ('community-college-of-vermont', 'US', 'Community College of Vermont', NULL, 'community_college', 'public', 'Vermont', 'Montpelier', 'https://www.ccv.edu', ARRAY['CCV']::text[], 'IPEDS', '230861', 'https://nces.ed.gov/collegenavigator/?id=230861', '2026-09-14', false),
  ('concordia-university-saint-paul', 'US', 'Concordia University-Saint Paul', NULL, 'university', 'private', 'Minnesota', 'Saint Paul', 'https://www.csp.edu', ARRAY['Concordia-St. Paul']::text[], 'IPEDS', '173328', 'https://nces.ed.gov/collegenavigator/?id=173328', '2026-09-14', false),
  ('connecticut-state-community-college', 'US', 'Connecticut State Community College', NULL, 'community_college', 'public', 'Connecticut', 'Hartford', 'https://ctstate.edu', ARRAY['CT State']::text[], 'IPEDS', '129367', 'https://nces.ed.gov/collegenavigator/?id=129367', '2026-09-14', false),
  ('cornell-university', 'US', 'Cornell University', NULL, 'university', 'private', 'New York', 'Ithaca', 'https://www.cornell.edu', ARRAY[]::text[], 'IPEDS', '190415', 'https://nces.ed.gov/collegenavigator/?id=190415', '2026-09-14', false),
  ('dakota-college-at-bottineau', 'US', 'Dakota College at Bottineau', NULL, 'community_college', 'public', 'North Dakota', 'Bottineau', 'https://www.dakotacollege.edu', ARRAY['MSU-Bottineau']::text[], 'IPEDS', '200314', 'https://nces.ed.gov/collegenavigator/?id=200314', '2026-09-14', false),
  ('delaware-technical-community-college-terry', 'US', 'Delaware Technical Community College-Terry', NULL, 'college', 'public', 'Delaware', 'Dover', 'https://www.dtcc.edu', ARRAY['Delaware Tech']::text[], 'IPEDS', '130907', 'https://nces.ed.gov/collegenavigator/?id=130907', '2026-09-14', false),
  ('des-moines-area-community-college', 'US', 'Des Moines Area Community College', NULL, 'community_college', 'public', 'Iowa', 'Ankeny', 'https://www.dmacc.edu', ARRAY['DMACC']::text[], 'IPEDS', '153214', 'https://nces.ed.gov/collegenavigator/?id=153214', '2026-09-14', false),
  ('drexel-university', 'US', 'Drexel University', NULL, 'university', 'private', 'Pennsylvania', 'Philadelphia', 'https://drexel.edu', ARRAY['Drexel']::text[], 'IPEDS', '212054', 'https://nces.ed.gov/collegenavigator/?id=212054', '2026-09-14', false),
  ('duke-university', 'US', 'Duke University', NULL, 'university', 'private', 'North Carolina', 'Durham', 'https://www.duke.edu', ARRAY[]::text[], 'IPEDS', '198419', 'https://nces.ed.gov/collegenavigator/?id=198419', '2026-09-14', false),
  ('el-paso-community-college', 'US', 'El Paso Community College', NULL, 'community_college', 'public', 'Texas', 'El Paso', 'https://www.epcc.edu', ARRAY[]::text[], 'IPEDS', '224642', 'https://nces.ed.gov/collegenavigator/?id=224642', '2026-09-14', false),
  ('emory-university', 'US', 'Emory University', NULL, 'university', 'private', 'Georgia', 'Atlanta', 'https://www.emory.edu', ARRAY[]::text[], 'IPEDS', '139658', 'https://nces.ed.gov/collegenavigator/?id=139658', '2026-09-14', false),
  ('flathead-valley-community-college', 'US', 'Flathead Valley Community College', NULL, 'community_college', 'public', 'Montana', 'Kalispell', 'https://www.fvcc.edu', ARRAY[]::text[], 'IPEDS', '180197', 'https://nces.ed.gov/collegenavigator/?id=180197', '2026-09-14', false),
  ('florida-international-university', 'US', 'Florida International University', NULL, 'university', 'public', 'Florida', 'Miami', 'https://www.fiu.edu', ARRAY['FIU']::text[], 'IPEDS', '133951', 'https://nces.ed.gov/collegenavigator/?id=133951', '2026-09-14', false),
  ('florida-state', 'US', 'Florida State University', 'FSU', 'university', 'public', 'Florida', 'Tallahassee', 'https://www.fsu.edu', ARRAY['Florida State', 'F.S.U.', 'FSU', 'F. S. U.', 'Fla. State University']::text[], 'IPEDS', '134097', 'https://nces.ed.gov/collegenavigator/?id=134097', '2026-09-14', true),
  ('fox-valley-technical-college', 'US', 'Fox Valley Technical College', NULL, 'community_college', 'public', 'Wisconsin', 'Appleton', 'https://www.fvtc.edu', ARRAY['FVTC']::text[], 'IPEDS', '238722', 'https://nces.ed.gov/collegenavigator/?id=238722', '2026-09-14', false),
  ('george-fox-university', 'US', 'George Fox University', NULL, 'university', 'private', 'Oregon', 'Newberg', 'https://www.georgefox.edu', ARRAY['GFU']::text[], 'IPEDS', '208822', 'https://nces.ed.gov/collegenavigator/?id=208822', '2026-09-14', false),
  ('george-mason-university', 'US', 'George Mason University', NULL, 'university', 'public', 'Virginia', 'Fairfax', 'https://www2.gmu.edu', ARRAY['Mason']::text[], 'IPEDS', '232186', 'https://nces.ed.gov/collegenavigator/?id=232186', '2026-09-14', false),
  ('george-washington-university', 'US', 'George Washington University', NULL, 'university', 'private', 'District of Columbia', 'Washington', 'https://www.gwu.edu', ARRAY['GWU', 'GW']::text[], 'IPEDS', '131469', 'https://nces.ed.gov/collegenavigator/?id=131469', '2026-09-14', false),
  ('georgia-institute-of-technology', 'US', 'Georgia Institute of Technology', NULL, 'university', 'public', 'Georgia', 'Atlanta', 'https://www.gatech.edu', ARRAY['Georgia Tech']::text[], 'IPEDS', '139755', 'https://nces.ed.gov/collegenavigator/?id=139755', '2026-09-14', false),
  ('gonzaga-university', 'US', 'Gonzaga University', NULL, 'university', 'private', 'Washington', 'Spokane', 'https://www.gonzaga.edu', ARRAY[]::text[], 'IPEDS', '235316', 'https://nces.ed.gov/collegenavigator/?id=235316', '2026-09-14', false),
  ('grand-rapids-community-college', 'US', 'Grand Rapids Community College', NULL, 'community_college', 'public', 'Michigan', 'Grand Rapids', 'https://www.grcc.edu', ARRAY[]::text[], 'IPEDS', '170055', 'https://nces.ed.gov/collegenavigator/?id=170055', '2026-09-14', false),
  ('great-bay-community-college', 'US', 'Great Bay Community College', NULL, 'community_college', 'public', 'New Hampshire', 'Portsmouth', 'https://www.greatbay.edu', ARRAY['Great Bay Community College']::text[], 'IPEDS', '183150', 'https://nces.ed.gov/collegenavigator/?id=183150', '2026-09-14', false),
  ('harding-university', 'US', 'Harding University', NULL, 'university', 'private', 'Arkansas', 'Searcy', 'https://www.harding.edu', ARRAY[]::text[], 'IPEDS', '107044', 'https://nces.ed.gov/collegenavigator/?id=107044', '2026-09-14', false),
  ('hinds-community-college', 'US', 'Hinds Community College', NULL, 'community_college', 'public', 'Mississippi', 'Raymond', 'https://www.hindscc.edu', ARRAY[]::text[], 'IPEDS', '175786', 'https://nces.ed.gov/collegenavigator/?id=175786', '2026-09-14', false),
  ('indiana-university-bloomington', 'US', 'Indiana University-Bloomington', NULL, 'university', 'public', 'Indiana', 'Bloomington', 'https://www.indiana.edu', ARRAY['IUB', 'IU Bloomington']::text[], 'IPEDS', '151351', 'https://nces.ed.gov/collegenavigator/?id=151351', '2026-09-14', false),
  ('iowa-state-university', 'US', 'Iowa State University', NULL, 'university', 'public', 'Iowa', 'Ames', 'https://www.iastate.edu', ARRAY['ISU']::text[], 'IPEDS', '153603', 'https://nces.ed.gov/collegenavigator/?id=153603', '2026-09-14', false),
  ('ivy-tech-community-college', 'US', 'Ivy Tech Community College', NULL, 'community_college', 'public', 'Indiana', 'Indianapolis', 'https://www.ivytech.edu', ARRAY[]::text[], 'IPEDS', '150987', 'https://nces.ed.gov/collegenavigator/?id=150987', '2026-09-14', false),
  ('johns-hopkins-university', 'US', 'Johns Hopkins University', NULL, 'university', 'private', 'Maryland', 'Baltimore', 'https://www.jhu.edu', ARRAY['Johns Hopkins']::text[], 'IPEDS', '162928', 'https://nces.ed.gov/collegenavigator/?id=162928', '2026-09-14', false),
  ('johnson-county-community-college', 'US', 'Johnson County Community College', NULL, 'community_college', 'public', 'Kansas', 'Overland Park', 'https://www.jccc.edu', ARRAY['JCCC']::text[], 'IPEDS', '155210', 'https://nces.ed.gov/collegenavigator/?id=155210', '2026-09-14', false),
  ('kansas-state-university', 'US', 'Kansas State University', NULL, 'university', 'public', 'Kansas', 'Manhattan', 'https://www.k-state.edu', ARRAY['K-State']::text[], 'IPEDS', '155399', 'https://nces.ed.gov/collegenavigator/?id=155399', '2026-09-14', false),
  ('kapiolani-community-college', 'US', 'Kapiolani Community College', NULL, 'community_college', 'public', 'Hawaii', 'Honolulu', 'https://www.kapiolani.hawaii.edu', ARRAY['Kapiolani CC / KCC']::text[], 'IPEDS', '141796', 'https://nces.ed.gov/collegenavigator/?id=141796', '2026-09-14', false),
  ('keene-state-college', 'US', 'Keene State College', NULL, 'college', 'public', 'New Hampshire', 'Keene', 'https://www.keene.edu', ARRAY['KSC']::text[], 'IPEDS', '183062', 'https://nces.ed.gov/collegenavigator/?id=183062', '2026-09-14', false),
  ('kent-state-university-at-kent', 'US', 'Kent State University at Kent', NULL, 'university', 'public', 'Ohio', 'Kent', 'https://www.kent.edu', ARRAY[]::text[], 'IPEDS', '203517', 'https://nces.ed.gov/collegenavigator/?id=203517', '2026-09-14', false),
  ('lake-area-technical-college', 'US', 'Lake Area Technical College', NULL, 'community_college', 'public', 'South Dakota', 'Watertown', 'https://www.lakeareatech.edu', ARRAY['LATC/Lake Area Tech']::text[], 'IPEDS', '219143', 'https://nces.ed.gov/collegenavigator/?id=219143', '2026-09-14', false),
  ('liberty-university', 'US', 'Liberty University', NULL, 'university', 'private', 'Virginia', 'Lynchburg', 'https://www.liberty.edu', ARRAY[]::text[], 'IPEDS', '232557', 'https://nces.ed.gov/collegenavigator/?id=232557', '2026-09-14', false),
  ('louisiana-state-university-and-agricultural-mechanical-college', 'US', 'Louisiana State University and Agricultural & Mechanical College', NULL, 'university', 'public', 'Louisiana', 'Baton Rouge', 'https://www.lsu.edu', ARRAY['Louisiana State University', 'LSU']::text[], 'IPEDS', '159391', 'https://nces.ed.gov/collegenavigator/?id=159391', '2026-09-14', false),
  ('marquette-university', 'US', 'Marquette University', NULL, 'university', 'private', 'Wisconsin', 'Milwaukee', 'https://www.marquette.edu', ARRAY[]::text[], 'IPEDS', '239105', 'https://nces.ed.gov/collegenavigator/?id=239105', '2026-09-14', false),
  ('marshall-university', 'US', 'Marshall University', NULL, 'university', 'public', 'West Virginia', 'Huntington', 'https://www.marshall.edu', ARRAY[]::text[], 'IPEDS', '237525', 'https://nces.ed.gov/collegenavigator/?id=237525', '2026-09-14', false),
  ('metropolitan-community-college-area', 'US', 'Metropolitan Community College Area', NULL, 'community_college', 'public', 'Nebraska', 'Omaha', 'https://www.mccneb.edu', ARRAY[]::text[], 'IPEDS', '181303', 'https://nces.ed.gov/collegenavigator/?id=181303', '2026-09-14', false),
  ('metropolitan-community-college-kansas-city', 'US', 'Metropolitan Community College-Kansas City', NULL, 'community_college', 'public', 'Missouri', 'Kansas City', 'https://www.mcckc.edu', ARRAY['MCC-KC']::text[], 'IPEDS', '177995', 'https://nces.ed.gov/collegenavigator/?id=177995', '2026-09-14', false),
  ('michigan-state-university', 'US', 'Michigan State University', NULL, 'university', 'public', 'Michigan', 'East Lansing', 'https://www.msu.edu', ARRAY['MSU', 'Spartans', 'MI State University', 'State', 'MI State U']::text[], 'IPEDS', '171100', 'https://nces.ed.gov/collegenavigator/?id=171100', '2026-09-14', false),
  ('minnesota-state-university-mankato', 'US', 'Minnesota State University-Mankato', NULL, 'university', 'public', 'Minnesota', 'Mankato', 'https://mnsu.edu', ARRAY[]::text[], 'IPEDS', '173920', 'https://nces.ed.gov/collegenavigator/?id=173920', '2026-09-14', false),
  ('mississippi-state-university', 'US', 'Mississippi State University', NULL, 'university', 'public', 'Mississippi', 'Mississippi State', 'https://www.msstate.edu', ARRAY[]::text[], 'IPEDS', '176080', 'https://nces.ed.gov/collegenavigator/?id=176080', '2026-09-14', false),
  ('missouri-state-university-springfield', 'US', 'Missouri State University-Springfield', NULL, 'university', 'public', 'Missouri', 'Springfield', 'https://www.missouristate.edu', ARRAY[]::text[], 'IPEDS', '179566', 'https://nces.ed.gov/collegenavigator/?id=179566', '2026-09-14', false),
  ('montana-state-university', 'US', 'Montana State University', NULL, 'university', 'public', 'Montana', 'Bozeman', 'https://www.montana.edu', ARRAY['MSU']::text[], 'IPEDS', '180461', 'https://nces.ed.gov/collegenavigator/?id=180461', '2026-09-14', false),
  ('montclair-state-university', 'US', 'Montclair State University', NULL, 'university', 'public', 'New Jersey', 'Montclair', 'https://www.montclair.edu', ARRAY[]::text[], 'IPEDS', '185590', 'https://nces.ed.gov/collegenavigator/?id=185590', '2026-09-14', false),
  ('new-mexico-state-university', 'US', 'New Mexico State University', NULL, 'university', 'public', 'New Mexico', 'Las Cruces', 'https://www.nmsu.edu', ARRAY['NMSU']::text[], 'IPEDS', '188030', 'https://nces.ed.gov/collegenavigator/?id=188030', '2026-09-14', false),
  ('north-carolina-state-university-at-raleigh', 'US', 'North Carolina State University at Raleigh', NULL, 'university', 'public', 'North Carolina', 'Raleigh', 'https://www.ncsu.edu', ARRAY['NC State University', 'NC State', 'N C State University', 'N C State', 'NCSU']::text[], 'IPEDS', '199193', 'https://nces.ed.gov/collegenavigator/?id=199193', '2026-09-14', false),
  ('north-dakota-state-university', 'US', 'North Dakota State University', NULL, 'university', 'public', 'North Dakota', 'Fargo', 'https://www.ndsu.edu', ARRAY['North Dakota State University', 'NDSU']::text[], 'IPEDS', '200332', 'https://nces.ed.gov/collegenavigator/?id=200332', '2026-09-14', false),
  ('northern-virginia-community-college', 'US', 'Northern Virginia Community College', NULL, 'community_college', 'public', 'Virginia', 'Annandale', 'https://www.nvcc.edu', ARRAY[]::text[], 'IPEDS', '232946', 'https://nces.ed.gov/collegenavigator/?id=232946', '2026-09-14', false),
  ('northwest-arkansas-community-college', 'US', 'NorthWest Arkansas Community College', NULL, 'community_college', 'public', 'Arkansas', 'Bentonville', 'https://www.nwacc.edu', ARRAY['NWACC']::text[], 'IPEDS', '367459', 'https://nces.ed.gov/collegenavigator/?id=367459', '2026-09-14', false),
  ('northwestern-university', 'US', 'Northwestern University', NULL, 'university', 'private', 'Illinois', 'Evanston', 'https://www.northwestern.edu', ARRAY[]::text[], 'IPEDS', '147767', 'https://nces.ed.gov/collegenavigator/?id=147767', '2026-09-14', false),
  ('nova-southeastern-university', 'US', 'Nova Southeastern University', NULL, 'university', 'private', 'Florida', 'Fort Lauderdale', 'https://www.nova.edu', ARRAY[]::text[], 'IPEDS', '136215', 'https://nces.ed.gov/collegenavigator/?id=136215', '2026-09-14', false),
  ('ohio-state-university', 'US', 'Ohio State University', NULL, 'university', 'public', 'Ohio', 'Columbus', 'https://www.osu.edu', ARRAY[]::text[], 'IPEDS', '204796', 'https://nces.ed.gov/collegenavigator/?id=204796', '2026-09-14', false),
  ('oklahoma-city-community-college', 'US', 'Oklahoma City Community College', NULL, 'community_college', 'public', 'Oklahoma', 'Oklahoma City', 'https://www.occc.edu', ARRAY['OCCC', 'O Triple C', 'O Trip', 'O Trip C']::text[], 'IPEDS', '207449', 'https://nces.ed.gov/collegenavigator/?id=207449', '2026-09-14', false),
  ('oklahoma-state-university', 'US', 'Oklahoma State University', NULL, 'university', 'public', 'Oklahoma', 'Stillwater', 'https://www.okstate.edu', ARRAY[]::text[], 'IPEDS', '207388', 'https://nces.ed.gov/collegenavigator/?id=207388', '2026-09-14', false),
  ('oral-roberts-university', 'US', 'Oral Roberts University', NULL, 'university', 'private', 'Oklahoma', 'Tulsa', 'https://oru.edu', ARRAY['ORU']::text[], 'IPEDS', '207582', 'https://nces.ed.gov/collegenavigator/?id=207582', '2026-09-14', false),
  ('oregon-state-university', 'US', 'Oregon State University', NULL, 'university', 'public', 'Oregon', 'Corvallis', 'https://oregonstate.edu', ARRAY[]::text[], 'IPEDS', '209542', 'https://nces.ed.gov/collegenavigator/?id=209542', '2026-09-14', false),
  ('pennsylvania-state-university', 'US', 'Pennsylvania State University', NULL, 'university', 'public', 'Pennsylvania', 'University Park', 'https://www.psu.edu', ARRAY[]::text[], 'IPEDS', '214777', 'https://nces.ed.gov/collegenavigator/?id=214777', '2026-09-14', false),
  ('portland-community-college', 'US', 'Portland Community College', NULL, 'community_college', 'public', 'Oregon', 'Portland', 'https://www.pcc.edu', ARRAY[]::text[], 'IPEDS', '209746', 'https://nces.ed.gov/collegenavigator/?id=209746', '2026-09-14', false),
  ('princeton-university', 'US', 'Princeton University', NULL, 'university', 'private', 'New Jersey', 'Princeton', 'https://www.princeton.edu', ARRAY[]::text[], 'IPEDS', '186131', 'https://nces.ed.gov/collegenavigator/?id=186131', '2026-09-14', false),
  ('purdue', 'US', 'Purdue University', 'Purdue', 'university', 'public', 'Indiana', 'West Lafayette', 'https://www.purdue.edu', ARRAY['Purdue-West Lafayette', 'Purdue', 'PU', 'Purdue-WL']::text[], 'IPEDS', '243780', 'https://nces.ed.gov/collegenavigator/?id=243780', '2026-09-14', true),
  ('rhode-island-college', 'US', 'Rhode Island College', NULL, 'college', 'public', 'Rhode Island', 'Providence', 'https://www.ric.edu', ARRAY['RIC', 'RI College', 'R.I. College']::text[], 'IPEDS', '217420', 'https://nces.ed.gov/collegenavigator/?id=217420', '2026-09-14', false),
  ('roseman-university-of-health-sciences', 'US', 'Roseman University of Health Sciences', NULL, 'university', 'private', 'Nevada', 'Henderson', 'https://www.roseman.edu', ARRAY[]::text[], 'IPEDS', '445735', 'https://nces.ed.gov/collegenavigator/?id=445735', '2026-09-14', false),
  ('rutgers-university-new-brunswick', 'US', 'Rutgers University-New Brunswick', NULL, 'university', 'public', 'New Jersey', 'New Brunswick', 'https://newbrunswick.rutgers.edu', ARRAY['Rutgers', 'The State University of New Jersey', 'Rutgers', 'The State University', 'Rutgers University']::text[], 'IPEDS', '186380', 'https://nces.ed.gov/collegenavigator/?id=186380', '2026-09-14', false),
  ('salt-lake-community-college', 'US', 'Salt Lake Community College', NULL, 'community_college', 'public', 'Utah', 'Salt Lake City', 'https://www.slcc.edu', ARRAY[]::text[], 'IPEDS', '230746', 'https://nces.ed.gov/collegenavigator/?id=230746', '2026-09-14', false),
  ('samford-university', 'US', 'Samford University', NULL, 'university', 'private', 'Alabama', 'Birmingham', 'https://www.samford.edu', ARRAY[]::text[], 'IPEDS', '102049', 'https://nces.ed.gov/collegenavigator/?id=102049', '2026-09-14', false),
  ('south-dakota-state-university', 'US', 'South Dakota State University', NULL, 'university', 'public', 'South Dakota', 'Brookings', 'https://www.sdstate.edu', ARRAY[]::text[], 'IPEDS', '219356', 'https://nces.ed.gov/collegenavigator/?id=219356', '2026-09-14', false),
  ('southern-maine-community-college', 'US', 'Southern Maine Community College', NULL, 'community_college', 'public', 'Maine', 'South Portland', 'https://www.smccme.edu', ARRAY['SMCC']::text[], 'IPEDS', '161545', 'https://nces.ed.gov/collegenavigator/?id=161545', '2026-09-14', false),
  ('southern-new-hampshire-university', 'US', 'Southern New Hampshire University', NULL, 'university', 'private', 'New Hampshire', 'Manchester', 'https://www.snhu.edu', ARRAY['SNHU']::text[], 'IPEDS', '183026', 'https://nces.ed.gov/collegenavigator/?id=183026', '2026-09-14', false),
  ('stony-brook-university', 'US', 'Stony Brook University', NULL, 'university', 'public', 'New York', 'Stony Brook', 'https://www.stonybrook.edu', ARRAY['SUNY Stony Brook State University of New York at Stony Brook']::text[], 'IPEDS', '196097', 'https://nces.ed.gov/collegenavigator/?id=196097', '2026-09-14', false),
  ('suffolk-county-community-college', 'US', 'Suffolk County Community College', NULL, 'community_college', 'public', 'New York', 'Selden', 'https://www.sunysuffolk.edu', ARRAY[]::text[], 'IPEDS', '366395', 'https://nces.ed.gov/collegenavigator/?id=366395', '2026-09-14', false),
  ('temple-university', 'US', 'Temple University', NULL, 'university', 'public', 'Pennsylvania', 'Philadelphia', 'https://www.temple.edu', ARRAY['Temple']::text[], 'IPEDS', '216339', 'https://nces.ed.gov/collegenavigator/?id=216339', '2026-09-14', false),
  ('texas-a-m-university-college-station', 'US', 'Texas A&M University-College Station', NULL, 'university', 'public', 'Texas', 'College Station', 'https://www.tamu.edu', ARRAY['Texas A&M University']::text[], 'IPEDS', '228723', 'https://nces.ed.gov/collegenavigator/?id=228723', '2026-09-14', false),
  ('texas-tech-university', 'US', 'Texas Tech University', NULL, 'university', 'public', 'Texas', 'Lubbock', 'https://www.ttu.edu', ARRAY[]::text[], 'IPEDS', '229115', 'https://nces.ed.gov/collegenavigator/?id=229115', '2026-09-14', false),
  ('the-university-of-alabama', 'US', 'The University of Alabama', NULL, 'university', 'public', 'Alabama', 'Tuscaloosa', 'https://www.ua.edu', ARRAY[]::text[], 'IPEDS', '100751', 'https://nces.ed.gov/collegenavigator/?id=100751', '2026-09-14', false),
  ('the-university-of-montana', 'US', 'The University of Montana', NULL, 'university', 'public', 'Montana', 'Missoula', 'https://www.umt.edu', ARRAY['University of Montana']::text[], 'IPEDS', '180489', 'https://nces.ed.gov/collegenavigator/?id=180489', '2026-09-14', false),
  ('the-university-of-tennessee-knoxville', 'US', 'The University of Tennessee-Knoxville', NULL, 'university', 'public', 'Tennessee', 'Knoxville', 'https://www.utk.edu', ARRAY[]::text[], 'IPEDS', '221759', 'https://nces.ed.gov/collegenavigator/?id=221759', '2026-09-14', false),
  ('trident-technical-college', 'US', 'Trident Technical College', NULL, 'community_college', 'public', 'South Carolina', 'Charleston', 'https://www.tridenttech.edu', ARRAY[]::text[], 'IPEDS', '218894', 'https://nces.ed.gov/collegenavigator/?id=218894', '2026-09-14', false),
  ('tulane-university-of-louisiana', 'US', 'Tulane University of Louisiana', NULL, 'university', 'private', 'Louisiana', 'New Orleans', 'https://tulane.edu', ARRAY['Tulane University']::text[], 'IPEDS', '160755', 'https://nces.ed.gov/collegenavigator/?id=160755', '2026-09-14', false),
  ('university-at-buffalo', 'US', 'University at Buffalo', NULL, 'university', 'public', 'New York', 'Buffalo', 'https://www.buffalo.edu', ARRAY['University at Buffalo', 'UB', 'State University of New York at Buffalo', 'SUNY Buffalo', 'University of Buffalo']::text[], 'IPEDS', '196088', 'https://nces.ed.gov/collegenavigator/?id=196088', '2026-09-14', false),
  ('university-of-alaska-anchorage', 'US', 'University of Alaska Anchorage', NULL, 'university', 'public', 'Alaska', 'Anchorage', 'https://www.uaa.alaska.edu', ARRAY['UAA']::text[], 'IPEDS', '102553', 'https://nces.ed.gov/collegenavigator/?id=102553', '2026-09-14', false),
  ('university-of-alaska-fairbanks', 'US', 'University of Alaska Fairbanks', NULL, 'university', 'public', 'Alaska', 'Fairbanks', 'https://www.uaf.edu', ARRAY['UAF']::text[], 'IPEDS', '102614', 'https://nces.ed.gov/collegenavigator/?id=102614', '2026-09-14', false),
  ('university-of-arizona', 'US', 'University of Arizona', NULL, 'university', 'public', 'Arizona', 'Tucson', 'https://www.arizona.edu', ARRAY['The University of Arizona', 'UArizona', 'U of A', 'UofA', 'UA']::text[], 'IPEDS', '104179', 'https://nces.ed.gov/collegenavigator/?id=104179', '2026-09-14', false),
  ('university-of-arkansas', 'US', 'University of Arkansas', NULL, 'university', 'public', 'Arkansas', 'Fayetteville', 'https://www.uark.edu', ARRAY['University of Arkansas', 'Arkansas']::text[], 'IPEDS', '106397', 'https://nces.ed.gov/collegenavigator/?id=106397', '2026-09-14', false),
  ('university-of-california-berkeley', 'US', 'University of California-Berkeley', NULL, 'university', 'public', 'California', 'Berkeley', 'https://www.berkeley.edu', ARRAY['UC Berkeley']::text[], 'IPEDS', '110635', 'https://nces.ed.gov/collegenavigator/?id=110635', '2026-09-14', false),
  ('university-of-california-davis', 'US', 'University of California-Davis', NULL, 'university', 'public', 'California', 'Davis', 'https://ucdavis.edu', ARRAY['UC Davis']::text[], 'IPEDS', '110644', 'https://nces.ed.gov/collegenavigator/?id=110644', '2026-09-14', false),
  ('university-of-charleston', 'US', 'University of Charleston', NULL, 'university', 'private', 'West Virginia', 'Charleston', 'https://www.ucwv.edu', ARRAY[]::text[], 'IPEDS', '237312', 'https://nces.ed.gov/collegenavigator/?id=237312', '2026-09-14', false),
  ('university-of-colorado-boulder', 'US', 'University of Colorado Boulder', NULL, 'university', 'public', 'Colorado', 'Boulder', 'https://www.colorado.edu', ARRAY['U of Colorado', 'Univ of Colorado', 'University of Colorado', 'U of CO', 'Univ of CO']::text[], 'IPEDS', '126614', 'https://nces.ed.gov/collegenavigator/?id=126614', '2026-09-14', false),
  ('university-of-connecticut', 'US', 'University of Connecticut', NULL, 'university', 'public', 'Connecticut', 'Storrs', 'https://uconn.edu', ARRAY[]::text[], 'IPEDS', '129020', 'https://nces.ed.gov/collegenavigator/?id=129020', '2026-09-14', false),
  ('university-of-delaware', 'US', 'University of Delaware', NULL, 'university', 'public', 'Delaware', 'Newark', 'https://www.udel.edu', ARRAY['UD']::text[], 'IPEDS', '130943', 'https://nces.ed.gov/collegenavigator/?id=130943', '2026-09-14', false),
  ('university-of-denver', 'US', 'University of Denver', NULL, 'university', 'private', 'Colorado', 'Denver', 'https://www.du.edu', ARRAY['DU', 'Colorado Seminary']::text[], 'IPEDS', '127060', 'https://nces.ed.gov/collegenavigator/?id=127060', '2026-09-14', false),
  ('university-of-detroit-mercy', 'US', 'University of Detroit Mercy', NULL, 'university', 'private', 'Michigan', 'Detroit', 'https://www.udmercy.edu', ARRAY['Detroit Mercy', 'UDM', 'U of D', 'University of Detroit']::text[], 'IPEDS', '169716', 'https://nces.ed.gov/collegenavigator/?id=169716', '2026-09-14', false),
  ('university-of-florida', 'US', 'University of Florida', NULL, 'university', 'public', 'Florida', 'Gainesville', 'https://www.ufl.edu', ARRAY[]::text[], 'IPEDS', '134130', 'https://nces.ed.gov/collegenavigator/?id=134130', '2026-09-14', false),
  ('university-of-georgia', 'US', 'University of Georgia', NULL, 'university', 'public', 'Georgia', 'Athens', 'https://www.uga.edu', ARRAY[]::text[], 'IPEDS', '139959', 'https://nces.ed.gov/collegenavigator/?id=139959', '2026-09-14', false),
  ('university-of-hawaii-at-hilo', 'US', 'University of Hawaii at Hilo', NULL, 'university', 'public', 'Hawaii', 'Hilo', 'https://hilo.hawaii.edu', ARRAY['UH Hilo / UHH']::text[], 'IPEDS', '141565', 'https://nces.ed.gov/collegenavigator/?id=141565', '2026-09-14', false),
  ('university-of-hawaii-at-manoa', 'US', 'University of Hawaii at Manoa', NULL, 'university', 'public', 'Hawaii', 'Honolulu', 'https://manoa.hawaii.edu', ARRAY['UH Manoa / UHM']::text[], 'IPEDS', '141574', 'https://nces.ed.gov/collegenavigator/?id=141574', '2026-09-14', false),
  ('university-of-idaho', 'US', 'University of Idaho', NULL, 'university', 'public', 'Idaho', 'Moscow', 'https://www.uidaho.edu', ARRAY['UIdaho']::text[], 'IPEDS', '142285', 'https://nces.ed.gov/collegenavigator/?id=142285', '2026-09-14', false),
  ('university-of-illinois-chicago', 'US', 'University of Illinois Chicago', NULL, 'university', 'public', 'Illinois', 'Chicago', 'https://www.uic.edu', ARRAY['UIC', 'U of I-Chicago', 'Illinois-Chicago', 'U of I-Medical Center', 'University of Illinois-Medical Center']::text[], 'IPEDS', '145600', 'https://nces.ed.gov/collegenavigator/?id=145600', '2026-09-14', false),
  ('university-of-illinois-urbana-champaign', 'US', 'University of Illinois Urbana-Champaign', NULL, 'university', 'public', 'Illinois', 'Champaign', 'https://www.illinois.edu', ARRAY['Illinois', 'Illinios', 'Ilinois', 'Ilinios', 'Urbana']::text[], 'IPEDS', '145637', 'https://nces.ed.gov/collegenavigator/?id=145637', '2026-09-14', false),
  ('university-of-iowa', 'US', 'University of Iowa', NULL, 'university', 'public', 'Iowa', 'Iowa City', 'https://uiowa.edu', ARRAY['Iowa']::text[], 'IPEDS', '153658', 'https://nces.ed.gov/collegenavigator/?id=153658', '2026-09-14', false),
  ('university-of-jamestown', 'US', 'University of Jamestown', NULL, 'university', 'private', 'North Dakota', 'Jamestown', 'https://www.uj.edu', ARRAY['UJ Jimmies']::text[], 'IPEDS', '200156', 'https://nces.ed.gov/collegenavigator/?id=200156', '2026-09-14', false),
  ('university-of-kansas', 'US', 'University of Kansas', NULL, 'university', 'public', 'Kansas', 'Lawrence', 'https://ku.edu', ARRAY['University of Kansas', 'Univ of Kansas', 'Kansas University', 'KU', 'Kansas Jayhawks']::text[], 'IPEDS', '155317', 'https://nces.ed.gov/collegenavigator/?id=155317', '2026-09-14', false),
  ('university-of-kentucky', 'US', 'University of Kentucky', NULL, 'university', 'public', 'Kentucky', 'Lexington', 'https://www.uky.edu', ARRAY[]::text[], 'IPEDS', '157085', 'https://nces.ed.gov/collegenavigator/?id=157085', '2026-09-14', false),
  ('university-of-louisiana-at-lafayette', 'US', 'University of Louisiana at Lafayette', NULL, 'university', 'public', 'Louisiana', 'Lafayette', 'https://www.louisiana.edu', ARRAY['UL Lafayette']::text[], 'IPEDS', '160658', 'https://nces.ed.gov/collegenavigator/?id=160658', '2026-09-14', false),
  ('university-of-louisville', 'US', 'University of Louisville', NULL, 'university', 'public', 'Kentucky', 'Louisville', 'https://www.louisville.edu', ARRAY[]::text[], 'IPEDS', '157289', 'https://nces.ed.gov/collegenavigator/?id=157289', '2026-09-14', false),
  ('university-of-maine', 'US', 'University of Maine', NULL, 'university', 'public', 'Maine', 'Orono', 'https://www.umaine.edu', ARRAY[]::text[], 'IPEDS', '161253', 'https://nces.ed.gov/collegenavigator/?id=161253', '2026-09-14', false),
  ('university-of-maryland-global-campus', 'US', 'University of Maryland Global Campus', NULL, 'university', 'public', 'Maryland', 'Adelphi', 'https://www.umgc.edu', ARRAY['UMGC']::text[], 'IPEDS', '163204', 'https://nces.ed.gov/collegenavigator/?id=163204', '2026-09-14', false),
  ('university-of-maryland-college-park', 'US', 'University of Maryland-College Park', NULL, 'university', 'public', 'Maryland', 'College Park', 'https://www.umd.edu', ARRAY[]::text[], 'IPEDS', '163286', 'https://nces.ed.gov/collegenavigator/?id=163286', '2026-09-14', false),
  ('university-of-massachusetts-amherst', 'US', 'University of Massachusetts-Amherst', NULL, 'university', 'public', 'Massachusetts', 'Amherst', 'https://www.umass.edu', ARRAY['UMass Amherst']::text[], 'IPEDS', '166629', 'https://nces.ed.gov/collegenavigator/?id=166629', '2026-09-14', false),
  ('university-of-massachusetts-boston', 'US', 'University of Massachusetts-Boston', NULL, 'university', 'public', 'Massachusetts', 'Boston', 'https://www.umb.edu', ARRAY[]::text[], 'IPEDS', '166638', 'https://nces.ed.gov/collegenavigator/?id=166638', '2026-09-14', false),
  ('university-of-memphis', 'US', 'University of Memphis', NULL, 'university', 'public', 'Tennessee', 'Memphis', 'https://www.memphis.edu', ARRAY[]::text[], 'IPEDS', '220862', 'https://nces.ed.gov/collegenavigator/?id=220862', '2026-09-14', false),
  ('university-of-michigan-ann-arbor', 'US', 'University of Michigan-Ann Arbor', NULL, 'university', 'public', 'Michigan', 'Ann Arbor', 'https://umich.edu', ARRAY['U of Michigan', 'U of M', 'Univ of Michigan', 'U Michigan Ann Arbor', 'University of Michigan Ann Arbor']::text[], 'IPEDS', '170976', 'https://nces.ed.gov/collegenavigator/?id=170976', '2026-09-14', false),
  ('university-of-minnesota-twin-cities', 'US', 'University of Minnesota-Twin Cities', NULL, 'university', 'public', 'Minnesota', 'Minneapolis', 'https://twin-cities.umn.edu', ARRAY[]::text[], 'IPEDS', '174066', 'https://nces.ed.gov/collegenavigator/?id=174066', '2026-09-14', false),
  ('university-of-mississippi', 'US', 'University of Mississippi', NULL, 'university', 'public', 'Mississippi', 'University', 'https://www.olemiss.edu', ARRAY['Ole Miss']::text[], 'IPEDS', '176017', 'https://nces.ed.gov/collegenavigator/?id=176017', '2026-09-14', false),
  ('university-of-missouri-columbia', 'US', 'University of Missouri-Columbia', NULL, 'university', 'public', 'Missouri', 'Columbia', 'https://missouri.edu', ARRAY[]::text[], 'IPEDS', '178396', 'https://nces.ed.gov/collegenavigator/?id=178396', '2026-09-14', false),
  ('university-of-nebraska-at-omaha', 'US', 'University of Nebraska at Omaha', NULL, 'university', 'public', 'Nebraska', 'Omaha', 'https://www.unomaha.edu', ARRAY['UNOMAHA']::text[], 'IPEDS', '181394', 'https://nces.ed.gov/collegenavigator/?id=181394', '2026-09-14', false),
  ('university-of-nebraska-lincoln', 'US', 'University of Nebraska-Lincoln', NULL, 'university', 'public', 'Nebraska', 'Lincoln', 'https://www.unl.edu', ARRAY[]::text[], 'IPEDS', '181464', 'https://nces.ed.gov/collegenavigator/?id=181464', '2026-09-14', false),
  ('university-of-nevada-las-vegas', 'US', 'University of Nevada-Las Vegas', NULL, 'university', 'public', 'Nevada', 'Las Vegas', 'https://www.unlv.edu', ARRAY['UNLV']::text[], 'IPEDS', '182281', 'https://nces.ed.gov/collegenavigator/?id=182281', '2026-09-14', false),
  ('university-of-nevada-reno', 'US', 'University of Nevada-Reno', NULL, 'university', 'public', 'Nevada', 'Reno', 'https://www.unr.edu', ARRAY[]::text[], 'IPEDS', '182290', 'https://nces.ed.gov/collegenavigator/?id=182290', '2026-09-14', false),
  ('university-of-new-england', 'US', 'University of New England', NULL, 'university', 'private', 'Maine', 'Biddeford', 'https://www.une.edu', ARRAY['UNE']::text[], 'IPEDS', '161457', 'https://nces.ed.gov/collegenavigator/?id=161457', '2026-09-14', false),
  ('university-of-new-hampshire', 'US', 'University of New Hampshire', NULL, 'university', 'public', 'New Hampshire', 'Durham', 'https://www.unh.edu', ARRAY[]::text[], 'IPEDS', '183044', 'https://nces.ed.gov/collegenavigator/?id=183044', '2026-09-14', false),
  ('university-of-new-mexico', 'US', 'University of New Mexico', NULL, 'university', 'public', 'New Mexico', 'Albuquerque', 'https://www.unm.edu', ARRAY['UNM']::text[], 'IPEDS', '187985', 'https://nces.ed.gov/collegenavigator/?id=187985', '2026-09-14', false),
  ('university-of-north-carolina-at-chapel-hill', 'US', 'University of North Carolina at Chapel Hill', NULL, 'university', 'public', 'North Carolina', 'Chapel Hill', 'https://www.unc.edu', ARRAY[]::text[], 'IPEDS', '199120', 'https://nces.ed.gov/collegenavigator/?id=199120', '2026-09-14', false),
  ('university-of-north-dakota', 'US', 'University of North Dakota', NULL, 'university', 'public', 'North Dakota', 'Grand Forks', 'https://und.edu', ARRAY[]::text[], 'IPEDS', '200280', 'https://nces.ed.gov/collegenavigator/?id=200280', '2026-09-14', false),
  ('university-of-notre-dame', 'US', 'University of Notre Dame', NULL, 'university', 'private', 'Indiana', 'Notre Dame', 'https://www.nd.edu', ARRAY['Notre Dame', 'Fighting Irish', 'ND']::text[], 'IPEDS', '152080', 'https://nces.ed.gov/collegenavigator/?id=152080', '2026-09-14', false),
  ('university-of-oklahoma', 'US', 'University of Oklahoma', NULL, 'university', 'public', 'Oklahoma', 'Norman', 'https://www.ou.edu', ARRAY['University of Oklahoma', 'Oklahoma University', 'OU', 'Oklahoma']::text[], 'IPEDS', '207500', 'https://nces.ed.gov/collegenavigator/?id=207500', '2026-09-14', false),
  ('university-of-oregon', 'US', 'University of Oregon', NULL, 'university', 'public', 'Oregon', 'Eugene', 'https://www.uoregon.edu', ARRAY['UO']::text[], 'IPEDS', '209551', 'https://nces.ed.gov/collegenavigator/?id=209551', '2026-09-14', false),
  ('university-of-rhode-island', 'US', 'University of Rhode Island', NULL, 'university', 'public', 'Rhode Island', 'Kingston', 'https://web.uri.edu', ARRAY['URI']::text[], 'IPEDS', '217484', 'https://nces.ed.gov/collegenavigator/?id=217484', '2026-09-14', false),
  ('university-of-south-carolina-columbia', 'US', 'University of South Carolina-Columbia', NULL, 'university', 'public', 'South Carolina', 'Columbia', 'https://www.sc.edu', ARRAY[]::text[], 'IPEDS', '218663', 'https://nces.ed.gov/collegenavigator/?id=218663', '2026-09-14', false),
  ('university-of-south-dakota', 'US', 'University of South Dakota', NULL, 'university', 'public', 'South Dakota', 'Vermillion', 'https://www.usd.edu', ARRAY['USD']::text[], 'IPEDS', '219471', 'https://nces.ed.gov/collegenavigator/?id=219471', '2026-09-14', false),
  ('university-of-southern-california', 'US', 'University of Southern California', NULL, 'university', 'private', 'California', 'Los Angeles', 'https://www.usc.edu', ARRAY['USC']::text[], 'IPEDS', '123961', 'https://nces.ed.gov/collegenavigator/?id=123961', '2026-09-14', false),
  ('university-of-southern-maine', 'US', 'University of Southern Maine', NULL, 'university', 'public', 'Maine', 'Portland', 'https://usm.maine.edu', ARRAY[]::text[], 'IPEDS', '161554', 'https://nces.ed.gov/collegenavigator/?id=161554', '2026-09-14', false),
  ('university-of-the-cumberlands', 'US', 'University of the Cumberlands', NULL, 'university', 'private', 'Kentucky', 'Williamsburg', 'https://www.ucumberlands.edu', ARRAY['Cumberland College']::text[], 'IPEDS', '156541', 'https://nces.ed.gov/collegenavigator/?id=156541', '2026-09-14', false),
  ('university-of-the-district-of-columbia', 'US', 'University of the District of Columbia', NULL, 'university', 'public', 'District of Columbia', 'Washington', 'https://www.udc.edu', ARRAY[]::text[], 'IPEDS', '131399', 'https://nces.ed.gov/collegenavigator/?id=131399', '2026-09-14', false),
  ('university-of-the-southwest', 'US', 'University of the Southwest', NULL, 'university', 'private', 'New Mexico', 'Hobbs', 'https://www.usw.edu', ARRAY['USW']::text[], 'IPEDS', '188182', 'https://nces.ed.gov/collegenavigator/?id=188182', '2026-09-14', false),
  ('university-of-utah', 'US', 'University of Utah', NULL, 'university', 'public', 'Utah', 'Salt Lake City', 'https://www.utah.edu', ARRAY['The U']::text[], 'IPEDS', '230764', 'https://nces.ed.gov/collegenavigator/?id=230764', '2026-09-14', false),
  ('university-of-vermont', 'US', 'University of Vermont', NULL, 'university', 'public', 'Vermont', 'Burlington', 'https://www.uvm.edu', ARRAY['UVM']::text[], 'IPEDS', '231174', 'https://nces.ed.gov/collegenavigator/?id=231174', '2026-09-14', false),
  ('university-of-washington', 'US', 'University of Washington', NULL, 'university', 'public', 'Washington', 'Seattle', 'https://www.washington.edu', ARRAY['UW-Seattle', 'UDub', 'UW', 'Washington']::text[], 'IPEDS', '236948', 'https://nces.ed.gov/collegenavigator/?id=236948', '2026-09-14', false),
  ('university-of-wisconsin-madison', 'US', 'University of Wisconsin-Madison', NULL, 'university', 'public', 'Wisconsin', 'Madison', 'https://www.wisc.edu', ARRAY[]::text[], 'IPEDS', '240444', 'https://nces.ed.gov/collegenavigator/?id=240444', '2026-09-14', false),
  ('university-of-wisconsin-milwaukee', 'US', 'University of Wisconsin-Milwaukee', NULL, 'university', 'public', 'Wisconsin', 'Milwaukee', 'https://uwm.edu', ARRAY['UWM']::text[], 'IPEDS', '240453', 'https://nces.ed.gov/collegenavigator/?id=240453', '2026-09-14', false),
  ('university-of-wyoming', 'US', 'University of Wyoming', NULL, 'university', 'public', 'Wyoming', 'Laramie', 'https://www.uwyo.edu', ARRAY['UW']::text[], 'IPEDS', '240727', 'https://nces.ed.gov/collegenavigator/?id=240727', '2026-09-14', false),
  ('utah-state-university', 'US', 'Utah State University', NULL, 'university', 'public', 'Utah', 'Logan', 'https://www.usu.edu', ARRAY[]::text[], 'IPEDS', '230728', 'https://nces.ed.gov/collegenavigator/?id=230728', '2026-09-14', false),
  ('vanderbilt-university', 'US', 'Vanderbilt University', NULL, 'university', 'private', 'Tennessee', 'Nashville', 'https://www.vanderbilt.edu', ARRAY[]::text[], 'IPEDS', '221999', 'https://nces.ed.gov/collegenavigator/?id=221999', '2026-09-14', false),
  ('vermont-state-university', 'US', 'Vermont State University', NULL, 'university', 'public', 'Vermont', 'Randolph', 'https://vermontstate.edu', ARRAY[]::text[], 'IPEDS', '231165', 'https://nces.ed.gov/collegenavigator/?id=231165', '2026-09-14', false),
  ('virginia-polytechnic-institute-and-state-university', 'US', 'Virginia Polytechnic Institute and State University', NULL, 'university', 'public', 'Virginia', 'Blacksburg', 'https://www.vt.edu', ARRAY['Virginia Tech']::text[], 'IPEDS', '233921', 'https://nces.ed.gov/collegenavigator/?id=233921', '2026-09-14', false),
  ('wake-technical-community-college', 'US', 'Wake Technical Community College', NULL, 'community_college', 'public', 'North Carolina', 'Raleigh', 'https://www.waketech.edu', ARRAY[]::text[], 'IPEDS', '199856', 'https://nces.ed.gov/collegenavigator/?id=199856', '2026-09-14', false),
  ('washington-state-university', 'US', 'Washington State University', NULL, 'university', 'public', 'Washington', 'Pullman', 'https://wsu.edu', ARRAY[]::text[], 'IPEDS', '236939', 'https://nces.ed.gov/collegenavigator/?id=236939', '2026-09-14', false),
  ('washington-university-in-st-louis', 'US', 'Washington University in St Louis', NULL, 'university', 'private', 'Missouri', 'Saint Louis', 'https://wustl.edu', ARRAY['WashU']::text[], 'IPEDS', '179867', 'https://nces.ed.gov/collegenavigator/?id=179867', '2026-09-14', false),
  ('west-virginia-university', 'US', 'West Virginia University', NULL, 'university', 'public', 'West Virginia', 'Morgantown', 'https://www.wvu.edu', ARRAY[]::text[], 'IPEDS', '238032', 'https://nces.ed.gov/collegenavigator/?id=238032', '2026-09-14', false),
  ('william-carey-university', 'US', 'William Carey University', NULL, 'university', 'private', 'Mississippi', 'Hattiesburg', 'https://www.wmcarey.edu', ARRAY[]::text[], 'IPEDS', '176479', 'https://nces.ed.gov/collegenavigator/?id=176479', '2026-09-14', false),
  ('wilmington-university', 'US', 'Wilmington University', NULL, 'university', 'private', 'Delaware', 'New Castle', 'https://www.wilmu.edu', ARRAY[]::text[], 'IPEDS', '131113', 'https://nces.ed.gov/collegenavigator/?id=131113', '2026-09-14', false),
  ('yale-university', 'US', 'Yale University', NULL, 'university', 'private', 'Connecticut', 'New Haven', 'https://www.yale.edu', ARRAY[]::text[], 'IPEDS', '130794', 'https://nces.ed.gov/collegenavigator/?id=130794', '2026-09-14', false);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM _u JOIN public.universities u USING (slug) WHERE u.country_code <> _u.country_code) THEN
    RAISE EXCEPTION 'SLUG_COUNTRY_CONFLICT';
  END IF;
END $$;

CREATE TEMP TABLE _report (entity text, action text, n integer) ON COMMIT DROP;

WITH upd AS (
  UPDATE public.universities u SET
    name             = CASE WHEN s.preserve THEN u.name ELSE s.name END,
    short_name       = CASE WHEN s.preserve THEN coalesce(u.short_name, s.short_name) ELSE s.short_name END,
    institution_type = s.institution_type,
    control          = coalesce(u.control, s.control),
    state_region     = CASE WHEN s.preserve THEN coalesce(u.state_region, s.state_region) ELSE s.state_region END,
    city             = CASE WHEN s.preserve THEN coalesce(u.city, s.city) ELSE s.city END,
    website_url      = coalesce(u.website_url, s.website_url),
    aliases          = ARRAY(SELECT DISTINCT a FROM unnest(u.aliases || s.aliases) a ORDER BY a),
    source_name = s.source_name, source_ref = s.source_ref, source_url = s.source_url,
    source_checked_at = s.source_checked_at
  FROM _u s
  WHERE u.slug = s.slug
    AND (u.name, u.short_name, u.institution_type, u.control, u.state_region, u.city, u.website_url, u.source_ref, u.source_checked_at)
        IS DISTINCT FROM
        (CASE WHEN s.preserve THEN u.name ELSE s.name END,
         CASE WHEN s.preserve THEN coalesce(u.short_name, s.short_name) ELSE s.short_name END,
         s.institution_type, coalesce(u.control, s.control),
         CASE WHEN s.preserve THEN coalesce(u.state_region, s.state_region) ELSE s.state_region END,
         CASE WHEN s.preserve THEN coalesce(u.city, s.city) ELSE s.city END,
         coalesce(u.website_url, s.website_url), s.source_ref, s.source_checked_at)
  RETURNING 1
) INSERT INTO _report SELECT 'universities', 'updated', count(*) FROM upd;

WITH ins AS (
  INSERT INTO public.universities (slug, country_code, name, short_name, institution_type, control, state_region, city,
    website_url, aliases, source_name, source_ref, source_url, source_checked_at, email_domains, is_active)
  SELECT s.slug, s.country_code, s.name, s.short_name, s.institution_type, s.control, s.state_region, s.city,
    s.website_url, s.aliases, s.source_name, s.source_ref, s.source_url, s.source_checked_at, '{}', true
  FROM _u s
  WHERE NOT EXISTS (SELECT 1 FROM public.universities u WHERE u.slug = s.slug)
  RETURNING 1
) INSERT INTO _report SELECT 'universities', 'inserted', count(*) FROM ins;
INSERT INTO _report SELECT 'universities', 'in_catalog', count(*) FROM _u;

-- 3. Campus
CREATE TEMP TABLE _c (slug text, university_slug text, campus_slug text, name text, campus_name text, city text,
  state_region text, lat double precision, lng double precision, preserve boolean) ON COMMIT DROP;
INSERT INTO _c VALUES
  ('colegio-bolivar', 'colegio-bolivar', 'principal', U&'Colegio Bol\00EDvar', NULL, 'Cali', 'Valle del Cauca', NULL, NULL, false),
  ('cesa', 'cesa', 'principal', U&'CESA \2014 Colegio de Estudios Superiores de Administraci\00F3n', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, true),
  ('colegio-mayor-de-antioquia', 'colegio-mayor-de-antioquia', 'principal', 'Colegio Mayor de Antioquia', NULL, U&'Medell\00EDn', 'Antioquia', NULL, NULL, false),
  ('escuela-colombiana-de-ingenieria-julio-garavito', 'escuela-colombiana-de-ingenieria-julio-garavito', 'principal', U&'Escuela Colombiana de Ingenier\00EDa Julio Garavito', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('fundacion-universidad-autonoma-de-colombia', 'fundacion-universidad-autonoma-de-colombia', 'principal', U&'Fundaci\00F3n Universidad Aut\00F3noma de Colombia', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('fundacion-universidad-de-america', 'fundacion-universidad-de-america', 'principal', U&'Fundaci\00F3n Universidad de Am\00E9rica', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('fundacion-universitaria-antonio-de-arevalo', 'fundacion-universitaria-antonio-de-arevalo', 'principal', U&'Fundaci\00F3n Universitaria Antonio de Ar\00E9valo', NULL, 'Cartagena de Indias', U&'Bol\00EDvar', NULL, NULL, false),
  ('fundacion-universitaria-ceipa', 'fundacion-universitaria-ceipa', 'principal', U&'Fundaci\00F3n Universitaria CEIPA', NULL, 'Sabaneta', 'Antioquia', NULL, NULL, false),
  ('fundacion-universitaria-de-ciencias-de-la-salud', 'fundacion-universitaria-de-ciencias-de-la-salud', 'principal', U&'Fundaci\00F3n Universitaria de Ciencias de la Salud', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('fundacion-universitaria-del-area-andina-bogota', 'fundacion-universitaria-del-area-andina', 'bogota', U&'Fundaci\00F3n Universitaria del \00C1rea Andina, Campus Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('fundacion-universitaria-del-area-andina-pereira', 'fundacion-universitaria-del-area-andina', 'pereira', U&'Fundaci\00F3n Universitaria del \00C1rea Andina, Campus Pereira', 'Pereira', 'Pereira', 'Risaralda', NULL, NULL, false),
  ('fundacion-universitaria-juan-n-corpas', 'fundacion-universitaria-juan-n-corpas', 'principal', U&'Fundaci\00F3n Universitaria Juan N. Corpas', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('fundacion-universitaria-konrad-lorenz', 'fundacion-universitaria-konrad-lorenz', 'principal', U&'Fundaci\00F3n Universitaria Konrad Lorenz', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('instituto-tecnologico-metropolitano', 'instituto-tecnologico-metropolitano', 'principal', U&'Instituto Tecnol\00F3gico Metropolitano', NULL, U&'Medell\00EDn', 'Antioquia', NULL, NULL, false),
  ('javeriana', 'javeriana', 'principal', 'Pontificia Universidad Javeriana', U&'Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, true),
  ('javeriana-cali', 'javeriana', 'cali', 'Pontificia Universidad Javeriana, Campus Cali', 'Cali', 'Cali', 'Valle del Cauca', NULL, NULL, false),
  ('tecnologico-de-antioquia', 'tecnologico-de-antioquia', 'principal', U&'Tecnol\00F3gico de Antioquia', NULL, U&'Medell\00EDn', 'Antioquia', NULL, NULL, false),
  ('universidad-antonio-narino-bogota', 'universidad-antonio-narino', 'bogota', U&'Universidad Antonio Nari\00F1o, Campus Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-antonio-narino-neiva', 'universidad-antonio-narino', 'neiva', U&'Universidad Antonio Nari\00F1o, Campus Neiva', 'Neiva', 'Neiva', 'Huila', NULL, NULL, false),
  ('universidad-autonoma-de-bucaramanga', 'universidad-autonoma-de-bucaramanga', 'principal', U&'Universidad Aut\00F3noma de Bucaramanga', NULL, 'Bucaramanga', 'Santander', NULL, NULL, false),
  ('universidad-autonoma-de-manizales', 'universidad-autonoma-de-manizales', 'principal', U&'Universidad Aut\00F3noma de Manizales', NULL, 'Manizales', 'Caldas', NULL, NULL, false),
  ('universidad-autonoma-de-occidente-co', 'universidad-autonoma-de-occidente-co', 'principal', U&'Universidad Aut\00F3noma de Occidente (CO)', NULL, 'Cali', 'Valle del Cauca', NULL, NULL, false),
  ('universidad-autonoma-del-caribe', 'universidad-autonoma-del-caribe', 'principal', U&'Universidad Aut\00F3noma del Caribe', NULL, 'Barranquilla', U&'Atl\00E1ntico', NULL, NULL, false),
  ('universidad-autonoma-indigena-intercultural', 'universidad-autonoma-indigena-intercultural', 'principal', U&'Universidad Aut\00F3noma Ind\00EDgena Intercultural', NULL, U&'Popay\00E1n', 'Cauca', NULL, NULL, false),
  ('universidad-autonoma-latinoamericana', 'universidad-autonoma-latinoamericana', 'principal', U&'Universidad Aut\00F3noma Latinoamericana', NULL, U&'Medell\00EDn', 'Antioquia', NULL, NULL, false),
  ('universidad-catolica-de-colombia-bogota', 'universidad-catolica-de-colombia', 'bogota', U&'Universidad Cat\00F3lica de Colombia, Campus Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-catolica-de-colombia-chia', 'universidad-catolica-de-colombia', 'chia', U&'Universidad Cat\00F3lica de Colombia, Campus Ch\00EDa', U&'Ch\00EDa', U&'Ch\00EDa', 'Cundinamarca', NULL, NULL, false),
  ('universidad-catolica-de-manizales', 'universidad-catolica-de-manizales', 'principal', U&'Universidad Cat\00F3lica de Manizales', NULL, 'Manizales', 'Caldas', NULL, NULL, false),
  ('universidad-catolica-de-oriente', 'universidad-catolica-de-oriente', 'principal', U&'Universidad Cat\00F3lica de Oriente', NULL, 'Rionegro', 'Antioquia', NULL, NULL, false),
  ('universidad-catolica-de-pereira', 'universidad-catolica-de-pereira', 'principal', U&'Universidad Cat\00F3lica de Pereira', NULL, 'Pereira', 'Risaralda', NULL, NULL, false),
  ('universidad-catolica-luis-amigo', 'universidad-catolica-luis-amigo', 'principal', U&'Universidad Cat\00F3lica Luis Amig\00F3', NULL, U&'Medell\00EDn', 'Antioquia', NULL, NULL, false),
  ('universidad-central', 'universidad-central', 'principal', 'Universidad Central', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-ces', 'universidad-ces', 'principal', 'Universidad CES', NULL, U&'Medell\00EDn', 'Antioquia', NULL, NULL, false),
  ('universidad-cesmag', 'universidad-cesmag', 'principal', 'Universidad CESMAG', NULL, 'Pasto', U&'Nari\00F1o', NULL, NULL, false),
  ('universidad-colegio-mayor-de-cundinamarca', 'universidad-colegio-mayor-de-cundinamarca', 'principal', 'Universidad Colegio Mayor de Cundinamarca', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-cooperativa-de-colombia-bogota', 'universidad-cooperativa-de-colombia', 'bogota', U&'Universidad Cooperativa de Colombia, Campus Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-cooperativa-de-colombia-medellin', 'universidad-cooperativa-de-colombia', 'medellin', U&'Universidad Cooperativa de Colombia, Campus Medell\00EDn', U&'Medell\00EDn', U&'Medell\00EDn', 'Antioquia', NULL, NULL, false),
  ('universidad-cooperativa-de-colombia-bucaramanga', 'universidad-cooperativa-de-colombia', 'bucaramanga', 'Universidad Cooperativa de Colombia, Campus Bucaramanga', 'Bucaramanga', 'Bucaramanga', 'Santander', NULL, NULL, false),
  ('universidad-cooperativa-de-colombia-barrancabermeja', 'universidad-cooperativa-de-colombia', 'barrancabermeja', 'Universidad Cooperativa de Colombia, Campus Barrancabermeja', 'Barrancabermeja', 'Barrancabermeja', 'Santander', NULL, NULL, false),
  ('universidad-cooperativa-de-colombia-santa-marta', 'universidad-cooperativa-de-colombia', 'santa-marta', 'Universidad Cooperativa de Colombia, Campus Santa Marta', 'Santa Marta', 'Santa Marta', 'Magdalena', NULL, NULL, false),
  ('universidad-de-antioquia-medellin', 'universidad-de-antioquia', 'medellin', U&'Universidad de Antioquia, Campus Medell\00EDn', U&'Medell\00EDn', U&'Medell\00EDn', 'Antioquia', NULL, NULL, false),
  ('universidad-de-antioquia-andes', 'universidad-de-antioquia', 'andes', 'Universidad de Antioquia, Campus Andes', 'Andes', 'Andes', 'Antioquia', NULL, NULL, false),
  ('universidad-de-antioquia-el-carmen-de-viboral', 'universidad-de-antioquia', 'el-carmen-de-viboral', 'Universidad de Antioquia, Campus El Carmen de Viboral', 'El Carmen de Viboral', 'El Carmen de Viboral', 'Antioquia', NULL, NULL, false),
  ('universidad-de-antioquia-caucasia', 'universidad-de-antioquia', 'caucasia', 'Universidad de Antioquia, Campus Caucasia', 'Caucasia', 'Caucasia', 'Antioquia', NULL, NULL, false),
  ('universidad-de-antioquia-puerto-berrio', 'universidad-de-antioquia', 'puerto-berrio', U&'Universidad de Antioquia, Campus Puerto Berr\00EDo', U&'Puerto Berr\00EDo', U&'Puerto Berr\00EDo', 'Antioquia', NULL, NULL, false),
  ('universidad-de-antioquia-turbo', 'universidad-de-antioquia', 'turbo', 'Universidad de Antioquia, Campus Turbo', 'Turbo', 'Turbo', 'Antioquia', NULL, NULL, false),
  ('universidad-de-antioquia-santa-fe-de-antioquia', 'universidad-de-antioquia', 'santa-fe-de-antioquia', U&'Universidad de Antioquia, Campus Santa F\00E9 de Antioquia', U&'Santa F\00E9 de Antioquia', U&'Santa F\00E9 de Antioquia', 'Antioquia', NULL, NULL, false),
  ('universidad-de-bogota-jorge-tadeo-lozano-bogota', 'universidad-de-bogota-jorge-tadeo-lozano', 'bogota', U&'Universidad de Bogot\00E1 Jorge Tadeo Lozano, Campus Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-de-bogota-jorge-tadeo-lozano-cartagena-de-indias', 'universidad-de-bogota-jorge-tadeo-lozano', 'cartagena-de-indias', U&'Universidad de Bogot\00E1 Jorge Tadeo Lozano, Campus Cartagena de Indias', 'Cartagena de Indias', 'Cartagena de Indias', U&'Bol\00EDvar', NULL, NULL, false),
  ('universidad-de-boyaca', 'universidad-de-boyaca', 'principal', U&'Universidad de Boyac\00E1', NULL, 'Tunja', U&'Boyac\00E1', NULL, NULL, false),
  ('universidad-de-caldas', 'universidad-de-caldas', 'principal', 'Universidad de Caldas', NULL, 'Manizales', 'Caldas', NULL, NULL, false),
  ('universidad-de-cartagena', 'universidad-de-cartagena', 'principal', 'Universidad de Cartagena', NULL, 'Cartagena de Indias', U&'Bol\00EDvar', NULL, NULL, false),
  ('universidad-de-ciencias-aplicadas-y-ambientales', 'universidad-de-ciencias-aplicadas-y-ambientales', 'principal', 'Universidad de Ciencias Aplicadas y Ambientales', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-de-cordoba', 'universidad-de-cordoba', 'principal', U&'Universidad de C\00F3rdoba', NULL, U&'Monter\00EDa', U&'C\00F3rdoba', NULL, NULL, false),
  ('universidad-de-cundinamarca-fusagasuga', 'universidad-de-cundinamarca', 'fusagasuga', U&'Universidad de Cundinamarca, Campus Fusagasug\00E1', U&'Fusagasug\00E1', U&'Fusagasug\00E1', 'Cundinamarca', NULL, NULL, false),
  ('universidad-de-cundinamarca-girardot', 'universidad-de-cundinamarca', 'girardot', 'Universidad de Cundinamarca, Campus Girardot', 'Girardot', 'Girardot', 'Cundinamarca', NULL, NULL, false),
  ('universidad-de-cundinamarca-villa-de-san-diego-de-ubate', 'universidad-de-cundinamarca', 'villa-de-san-diego-de-ubate', U&'Universidad de Cundinamarca, Campus Villa de San Diego de Ubat\00E9', U&'Villa de San Diego de Ubat\00E9', U&'Villa de San Diego de Ubat\00E9', 'Cundinamarca', NULL, NULL, false),
  ('universidad-de-ibague', 'universidad-de-ibague', 'principal', U&'Universidad de Ibagu\00E9', NULL, U&'Ibagu\00E9', 'Tolima', NULL, NULL, false),
  ('universidad-de-investigacion-y-desarrollo', 'universidad-de-investigacion-y-desarrollo', 'principal', U&'Universidad de Investigaci\00F3n y Desarrollo', NULL, 'Bucaramanga', 'Santander', NULL, NULL, false),
  ('universidad-de-la-amazonia', 'universidad-de-la-amazonia', 'principal', 'Universidad de la Amazonia', NULL, 'Florencia', U&'Caquet\00E1', NULL, NULL, false),
  ('universidad-de-la-costa', 'universidad-de-la-costa', 'principal', 'Universidad de la Costa', NULL, 'Barranquilla', U&'Atl\00E1ntico', NULL, NULL, false),
  ('universidad-de-la-guajira', 'universidad-de-la-guajira', 'principal', 'Universidad de la Guajira', NULL, 'Riohacha', 'La Guajira', NULL, NULL, false),
  ('universidad-de-la-sabana', 'universidad-de-la-sabana', 'principal', 'Universidad de la Sabana', NULL, U&'Ch\00EDa', 'Cundinamarca', NULL, NULL, false),
  ('universidad-de-la-salle', 'universidad-de-la-salle', 'principal', 'Universidad de La Salle', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-de-los-andes', 'universidad-de-los-andes', 'principal', 'Universidad de los Andes', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-de-los-llanos', 'universidad-de-los-llanos', 'principal', 'Universidad de los Llanos', NULL, 'Villavicencio', 'Meta', NULL, NULL, false),
  ('universidad-de-manizales', 'universidad-de-manizales', 'principal', 'Universidad de Manizales', NULL, 'Manizales', 'Caldas', NULL, NULL, false),
  ('universidad-de-medellin', 'universidad-de-medellin', 'principal', U&'Universidad de Medell\00EDn', NULL, U&'Medell\00EDn', 'Antioquia', NULL, NULL, false),
  ('universidad-de-narino', 'universidad-de-narino', 'principal', U&'Universidad de Nari\00F1o', NULL, 'Pasto', U&'Nari\00F1o', NULL, NULL, false),
  ('universidad-de-pamplona', 'universidad-de-pamplona', 'principal', 'Universidad de Pamplona', NULL, 'Pamplona', 'Norte de Santander', NULL, NULL, false),
  ('universidad-de-san-buenaventura-bogota', 'universidad-de-san-buenaventura', 'bogota', U&'Universidad de San Buenaventura, Campus Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-de-san-buenaventura-cali', 'universidad-de-san-buenaventura', 'cali', 'Universidad de San Buenaventura, Campus Cali', 'Cali', 'Cali', 'Valle del Cauca', NULL, NULL, false),
  ('universidad-de-san-buenaventura-medellin', 'universidad-de-san-buenaventura', 'medellin', U&'Universidad de San Buenaventura, Campus Medell\00EDn', U&'Medell\00EDn', U&'Medell\00EDn', 'Antioquia', NULL, NULL, false),
  ('universidad-de-san-buenaventura-cartagena-de-indias', 'universidad-de-san-buenaventura', 'cartagena-de-indias', 'Universidad de San Buenaventura, Campus Cartagena de Indias', 'Cartagena de Indias', 'Cartagena de Indias', U&'Bol\00EDvar', NULL, NULL, false),
  ('universidad-de-santander', 'universidad-de-santander', 'principal', 'Universidad de Santander', NULL, 'Bucaramanga', 'Santander', NULL, NULL, false),
  ('universidad-de-sucre', 'universidad-de-sucre', 'principal', 'Universidad de Sucre', NULL, 'Sincelejo', 'Sucre', NULL, NULL, false),
  ('universidad-del-atlantico-co', 'universidad-del-atlantico-co', 'principal', U&'Universidad del Atl\00E1ntico (CO)', NULL, 'Puerto Colombia', U&'Atl\00E1ntico', NULL, NULL, false),
  ('universidad-del-cauca', 'universidad-del-cauca', 'principal', 'Universidad del Cauca', NULL, U&'Popay\00E1n', 'Cauca', NULL, NULL, false),
  ('universidad-del-magdalena', 'universidad-del-magdalena', 'principal', 'Universidad del Magdalena', NULL, 'Santa Marta', 'Magdalena', NULL, NULL, false),
  ('universidad-del-norte', 'universidad-del-norte', 'principal', 'Universidad del Norte', NULL, 'Barranquilla', U&'Atl\00E1ntico', NULL, NULL, false),
  ('universidad-del-pacifico', 'universidad-del-pacifico', 'principal', U&'Universidad del Pac\00EDfico', NULL, 'Buenaventura', 'Valle del Cauca', NULL, NULL, false),
  ('universidad-del-quindio', 'universidad-del-quindio', 'principal', U&'Universidad del Quind\00EDo', NULL, 'Armenia', U&'Quind\00EDo', NULL, NULL, false),
  ('universidad-del-rosario', 'universidad-del-rosario', 'principal', 'Universidad del Rosario', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-del-sinu-elias-bechara-zainum-monteria', 'universidad-del-sinu-elias-bechara-zainum', 'monteria', U&'Universidad del Sin\00FA El\00EDas Bechara Zainum, Campus Monter\00EDa', U&'Monter\00EDa', U&'Monter\00EDa', U&'C\00F3rdoba', NULL, NULL, false),
  ('universidad-del-sinu-elias-bechara-zainum-cartagena-de-indias', 'universidad-del-sinu-elias-bechara-zainum', 'cartagena-de-indias', U&'Universidad del Sin\00FA El\00EDas Bechara Zainum, Campus Cartagena de Indias', 'Cartagena de Indias', 'Cartagena de Indias', U&'Bol\00EDvar', NULL, NULL, false),
  ('universidad-del-tolima', 'universidad-del-tolima', 'principal', 'Universidad del Tolima', NULL, U&'Ibagu\00E9', 'Tolima', NULL, NULL, false),
  ('universidad-del-valle-cali', 'universidad-del-valle', 'cali', 'Universidad del Valle, Campus Cali', 'Cali', 'Cali', 'Valle del Cauca', NULL, NULL, false),
  ('universidad-del-valle-guadalajara-de-buga', 'universidad-del-valle', 'guadalajara-de-buga', 'Universidad del Valle, Campus Guadalajara de Buga', 'Guadalajara de Buga', 'Guadalajara de Buga', 'Valle del Cauca', NULL, NULL, false),
  ('universidad-del-valle-zarzal', 'universidad-del-valle', 'zarzal', 'Universidad del Valle, Campus Zarzal', 'Zarzal', 'Zarzal', 'Valle del Cauca', NULL, NULL, false),
  ('universidad-del-valle-buenaventura', 'universidad-del-valle', 'buenaventura', 'Universidad del Valle, Campus Buenaventura', 'Buenaventura', 'Buenaventura', 'Valle del Cauca', NULL, NULL, false),
  ('universidad-del-valle-palmira', 'universidad-del-valle', 'palmira', 'Universidad del Valle, Campus Palmira', 'Palmira', 'Palmira', 'Valle del Cauca', NULL, NULL, false),
  ('universidad-distrital-francisco-jose-de-caldas', 'universidad-distrital-francisco-jose-de-caldas', 'principal', U&'Universidad Distrital Francisco Jos\00E9 de Caldas', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-eafit', 'universidad-eafit', 'principal', 'Universidad EAFIT', NULL, U&'Medell\00EDn', 'Antioquia', NULL, NULL, false),
  ('universidad-ean', 'universidad-ean', 'principal', 'Universidad EAN', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-ecci', 'universidad-ecci', 'principal', 'Universidad ECCI', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-eia', 'universidad-eia', 'principal', 'Universidad EIA', NULL, 'Envigado', 'Antioquia', NULL, NULL, false),
  ('universidad-el-bosque', 'universidad-el-bosque', 'principal', 'Universidad El Bosque', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-externado-de-colombia', 'universidad-externado-de-colombia', 'principal', 'Universidad Externado de Colombia', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-francisco-de-paula-santander-san-jose-de-cucuta', 'universidad-francisco-de-paula-santander', 'san-jose-de-cucuta', U&'Universidad Francisco de Paula Santander, Campus San Jos\00E9 de C\00FAcuta', U&'San Jos\00E9 de C\00FAcuta', U&'San Jos\00E9 de C\00FAcuta', 'Norte de Santander', NULL, NULL, false),
  ('universidad-francisco-de-paula-santander-ocana', 'universidad-francisco-de-paula-santander', 'ocana', U&'Universidad Francisco de Paula Santander, Campus Oca\00F1a', U&'Oca\00F1a', U&'Oca\00F1a', 'Norte de Santander', NULL, NULL, false),
  ('icesi', 'icesi', 'principal', 'Universidad Icesi', NULL, 'Cali', 'Valle del Cauca', NULL, NULL, true),
  ('universidad-incca-de-colombia', 'universidad-incca-de-colombia', 'principal', 'Universidad INCCA de Colombia', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-industrial-de-santander', 'universidad-industrial-de-santander', 'principal', 'Universidad Industrial de Santander', NULL, 'Bucaramanga', 'Santander', NULL, NULL, false),
  ('universidad-internacional-del-tropico-americano', 'universidad-internacional-del-tropico-americano', 'principal', U&'Universidad Internacional del Tr\00F3pico Americano', NULL, 'Yopal', 'Casanare', NULL, NULL, false),
  ('universidad-la-gran-colombia-bogota', 'universidad-la-gran-colombia', 'bogota', U&'Universidad La Gran Colombia, Campus Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-la-gran-colombia-armenia', 'universidad-la-gran-colombia', 'armenia', 'Universidad La Gran Colombia, Campus Armenia', 'Armenia', 'Armenia', U&'Quind\00EDo', NULL, NULL, false),
  ('universidad-libre-bogota', 'universidad-libre', 'bogota', U&'Universidad Libre, Campus Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-libre-cali', 'universidad-libre', 'cali', 'Universidad Libre, Campus Cali', 'Cali', 'Cali', 'Valle del Cauca', NULL, NULL, false),
  ('universidad-libre-barranquilla', 'universidad-libre', 'barranquilla', 'Universidad Libre, Campus Barranquilla', 'Barranquilla', 'Barranquilla', U&'Atl\00E1ntico', NULL, NULL, false),
  ('universidad-libre-pereira', 'universidad-libre', 'pereira', 'Universidad Libre, Campus Pereira', 'Pereira', 'Pereira', 'Risaralda', NULL, NULL, false),
  ('universidad-libre-san-jose-de-cucuta', 'universidad-libre', 'san-jose-de-cucuta', U&'Universidad Libre, Campus San Jos\00E9 de C\00FAcuta', U&'San Jos\00E9 de C\00FAcuta', U&'San Jos\00E9 de C\00FAcuta', 'Norte de Santander', NULL, NULL, false),
  ('universidad-libre-socorro', 'universidad-libre', 'socorro', 'Universidad Libre, Campus Socorro', 'Socorro', 'Socorro', 'Santander', NULL, NULL, false),
  ('universidad-manuela-beltran-bogota', 'universidad-manuela-beltran', 'bogota', U&'Universidad Manuela Beltr\00E1n, Campus Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-manuela-beltran-bucaramanga', 'universidad-manuela-beltran', 'bucaramanga', U&'Universidad Manuela Beltr\00E1n, Campus Bucaramanga', 'Bucaramanga', 'Bucaramanga', 'Santander', NULL, NULL, false),
  ('universidad-mariana', 'universidad-mariana', 'principal', 'Universidad Mariana', NULL, 'Pasto', U&'Nari\00F1o', NULL, NULL, false),
  ('universidad-metropolitana', 'universidad-metropolitana', 'principal', 'Universidad Metropolitana', NULL, 'Barranquilla', U&'Atl\00E1ntico', NULL, NULL, false),
  ('universidad-militar-nueva-granada', 'universidad-militar-nueva-granada', 'principal', 'Universidad Militar Nueva Granada', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-nacional-abierta-y-a-distancia', 'universidad-nacional-abierta-y-a-distancia', 'principal', 'Universidad Nacional Abierta y a Distancia', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-nacional-de-colombia-bogota', 'universidad-nacional-de-colombia', 'bogota', U&'Universidad Nacional de Colombia, Campus Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-nacional-de-colombia-medellin', 'universidad-nacional-de-colombia', 'medellin', U&'Universidad Nacional de Colombia, Campus Medell\00EDn', U&'Medell\00EDn', U&'Medell\00EDn', 'Antioquia', NULL, NULL, false),
  ('universidad-nacional-de-colombia-manizales', 'universidad-nacional-de-colombia', 'manizales', 'Universidad Nacional de Colombia, Campus Manizales', 'Manizales', 'Manizales', 'Caldas', NULL, NULL, false),
  ('universidad-nacional-de-colombia-palmira', 'universidad-nacional-de-colombia', 'palmira', 'Universidad Nacional de Colombia, Campus Palmira', 'Palmira', 'Palmira', 'Valle del Cauca', NULL, NULL, false),
  ('universidad-nacional-de-colombia-arauca', 'universidad-nacional-de-colombia', 'arauca', 'Universidad Nacional de Colombia, Campus Arauca', 'Arauca', 'Arauca', 'Arauca', NULL, NULL, false),
  ('universidad-nacional-de-colombia-leticia', 'universidad-nacional-de-colombia', 'leticia', 'Universidad Nacional de Colombia, Campus Leticia', 'Leticia', 'Leticia', 'Amazonas', NULL, NULL, false),
  ('universidad-nacional-de-colombia-san-andres', 'universidad-nacional-de-colombia', 'san-andres', U&'Universidad Nacional de Colombia, Campus San Andr\00E9s', U&'San Andr\00E9s', U&'San Andr\00E9s', U&'Archipi\00E9lago de San Andr\00E9s, Providencia y Santa Catalina', NULL, NULL, false),
  ('universidad-nacional-de-colombia-san-andres-de-tumaco', 'universidad-nacional-de-colombia', 'san-andres-de-tumaco', U&'Universidad Nacional de Colombia, Campus San Andr\00E9s de Tumaco', U&'San Andr\00E9s de Tumaco', U&'San Andr\00E9s de Tumaco', U&'Nari\00F1o', NULL, NULL, false),
  ('universidad-nacional-de-colombia-la-paz', 'universidad-nacional-de-colombia', 'la-paz', 'Universidad Nacional de Colombia, Campus La Paz', 'La Paz', 'La Paz', 'Cesar', NULL, NULL, false),
  ('universidad-pedagogica-nacional', 'universidad-pedagogica-nacional', 'principal', U&'Universidad Pedag\00F3gica Nacional', NULL, U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-pedagogica-y-tecnologica-de-colombia-tunja', 'universidad-pedagogica-y-tecnologica-de-colombia', 'tunja', U&'Universidad Pedag\00F3gica y Tecnol\00F3gica de Colombia, Campus Tunja', 'Tunja', 'Tunja', U&'Boyac\00E1', NULL, NULL, false),
  ('universidad-pedagogica-y-tecnologica-de-colombia-duitama', 'universidad-pedagogica-y-tecnologica-de-colombia', 'duitama', U&'Universidad Pedag\00F3gica y Tecnol\00F3gica de Colombia, Campus Duitama', 'Duitama', 'Duitama', U&'Boyac\00E1', NULL, NULL, false),
  ('universidad-pedagogica-y-tecnologica-de-colombia-sogamoso', 'universidad-pedagogica-y-tecnologica-de-colombia', 'sogamoso', U&'Universidad Pedag\00F3gica y Tecnol\00F3gica de Colombia, Campus Sogamoso', 'Sogamoso', 'Sogamoso', U&'Boyac\00E1', NULL, NULL, false),
  ('universidad-pedagogica-y-tecnologica-de-colombia-chiquinquira', 'universidad-pedagogica-y-tecnologica-de-colombia', 'chiquinquira', U&'Universidad Pedag\00F3gica y Tecnol\00F3gica de Colombia, Campus Chiquinquir\00E1', U&'Chiquinquir\00E1', U&'Chiquinquir\00E1', U&'Boyac\00E1', NULL, NULL, false),
  ('universidad-piloto-de-colombia-bogota', 'universidad-piloto-de-colombia', 'bogota', U&'Universidad Piloto de Colombia, Campus Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-piloto-de-colombia-girardot', 'universidad-piloto-de-colombia', 'girardot', 'Universidad Piloto de Colombia, Campus Girardot', 'Girardot', 'Girardot', 'Cundinamarca', NULL, NULL, false),
  ('universidad-pontificia-bolivariana-medellin', 'universidad-pontificia-bolivariana', 'medellin', U&'Universidad Pontificia Bolivariana, Campus Medell\00EDn', U&'Medell\00EDn', U&'Medell\00EDn', 'Antioquia', NULL, NULL, false),
  ('universidad-pontificia-bolivariana-bucaramanga', 'universidad-pontificia-bolivariana', 'bucaramanga', 'Universidad Pontificia Bolivariana, Campus Bucaramanga', 'Bucaramanga', 'Bucaramanga', 'Santander', NULL, NULL, false),
  ('universidad-pontificia-bolivariana-monteria', 'universidad-pontificia-bolivariana', 'monteria', U&'Universidad Pontificia Bolivariana, Campus Monter\00EDa', U&'Monter\00EDa', U&'Monter\00EDa', U&'C\00F3rdoba', NULL, NULL, false),
  ('universidad-pontificia-bolivariana-palmira', 'universidad-pontificia-bolivariana', 'palmira', 'Universidad Pontificia Bolivariana, Campus Palmira', 'Palmira', 'Palmira', 'Valle del Cauca', NULL, NULL, false),
  ('universidad-popular-del-cesar-valledupar', 'universidad-popular-del-cesar', 'valledupar', 'Universidad Popular del Cesar, Campus Valledupar', 'Valledupar', 'Valledupar', 'Cesar', NULL, NULL, false),
  ('universidad-popular-del-cesar-aguachica', 'universidad-popular-del-cesar', 'aguachica', 'Universidad Popular del Cesar, Campus Aguachica', 'Aguachica', 'Aguachica', 'Cesar', NULL, NULL, false),
  ('universidad-santiago-de-cali-cali', 'universidad-santiago-de-cali', 'cali', 'Universidad Santiago de Cali, Campus Cali', 'Cali', 'Cali', 'Valle del Cauca', NULL, NULL, false),
  ('universidad-santiago-de-cali-palmira', 'universidad-santiago-de-cali', 'palmira', 'Universidad Santiago de Cali, Campus Palmira', 'Palmira', 'Palmira', 'Valle del Cauca', NULL, NULL, false),
  ('universidad-santo-tomas-bogota', 'universidad-santo-tomas', 'bogota', U&'Universidad Santo Tom\00E1s, Campus Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-santo-tomas-bucaramanga', 'universidad-santo-tomas', 'bucaramanga', U&'Universidad Santo Tom\00E1s, Campus Bucaramanga', 'Bucaramanga', 'Bucaramanga', 'Santander', NULL, NULL, false),
  ('universidad-santo-tomas-tunja', 'universidad-santo-tomas', 'tunja', U&'Universidad Santo Tom\00E1s, Campus Tunja', 'Tunja', 'Tunja', U&'Boyac\00E1', NULL, NULL, false),
  ('universidad-sergio-arboleda-bogota', 'universidad-sergio-arboleda', 'bogota', U&'Universidad Sergio Arboleda, Campus Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1', U&'Bogot\00E1 D.C.', NULL, NULL, false),
  ('universidad-sergio-arboleda-santa-marta', 'universidad-sergio-arboleda', 'santa-marta', 'Universidad Sergio Arboleda, Campus Santa Marta', 'Santa Marta', 'Santa Marta', 'Magdalena', NULL, NULL, false),
  ('universidad-simon-bolivar', 'universidad-simon-bolivar', 'principal', U&'Universidad Sim\00F3n Bol\00EDvar', NULL, 'Barranquilla', U&'Atl\00E1ntico', NULL, NULL, false),
  ('universidad-surcolombiana', 'universidad-surcolombiana', 'principal', 'Universidad Surcolombiana', NULL, 'Neiva', 'Huila', NULL, NULL, false),
  ('universidad-tecnologica-de-bolivar', 'universidad-tecnologica-de-bolivar', 'principal', U&'Universidad Tecnol\00F3gica de Bol\00EDvar', NULL, 'Cartagena de Indias', U&'Bol\00EDvar', NULL, NULL, false),
  ('universidad-tecnologica-de-pereira', 'universidad-tecnologica-de-pereira', 'principal', U&'Universidad Tecnol\00F3gica de Pereira', NULL, 'Pereira', 'Risaralda', NULL, NULL, false),
  ('universidad-tecnologica-del-choco-diego-luis-cordoba', 'universidad-tecnologica-del-choco-diego-luis-cordoba', 'principal', U&'Universidad Tecnol\00F3gica del Choc\00F3 Diego Luis C\00F3rdoba', NULL, U&'Quibd\00F3', U&'Choc\00F3', NULL, NULL, false),
  ('buap', 'buap', 'principal', U&'Benem\00E9rita Universidad Aut\00F3noma de Puebla', NULL, 'Puebla', 'Puebla', NULL, NULL, true),
  ('centro-de-ensenanza-tecnica-y-superior', 'centro-de-ensenanza-tecnica-y-superior', 'principal', U&'Centro de Ense\00F1anza T\00E9cnica y Superior', NULL, 'Mexicali', 'Baja California', NULL, NULL, false),
  ('centro-de-estudios-del-mayab', 'centro-de-estudios-del-mayab', 'principal', 'Centro de Estudios del Mayab', NULL, U&'M\00E9rida', U&'Yucat\00E1n', NULL, NULL, false),
  ('centro-de-estudios-superiores-del-bajio', 'centro-de-estudios-superiores-del-bajio', 'principal', U&'Centro de Estudios Superiores del Baj\00EDo', NULL, U&'Quer\00E9taro', U&'Quer\00E9taro', NULL, NULL, false),
  ('centro-de-estudios-superiores-en-ciencias-juridicas-y-criminologicas', 'centro-de-estudios-superiores-en-ciencias-juridicas-y-criminologicas', 'principal', U&'Centro de Estudios Superiores en Ciencias Jur\00EDdicas y Criminol\00F3gicas', NULL, U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, NULL, false),
  ('cide', 'cide', 'principal', U&'Centro de Investigaci\00F3n y Docencia Econ\00F3micas', NULL, U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, NULL, true),
  ('centro-universitario-de-tijuana', 'centro-universitario-de-tijuana', 'principal', 'Centro Universitario de Tijuana', NULL, 'Tijuana', 'Baja California', NULL, NULL, false),
  ('centro-universitario-metropolitano-hidalgo', 'centro-universitario-metropolitano-hidalgo', 'principal', 'Centro Universitario Metropolitano Hidalgo', NULL, 'Mineral de la Reforma', 'Hidalgo', NULL, NULL, false),
  ('centro-universitario-siglo-xxi-pachuca-de-soto', 'centro-universitario-siglo-xxi', 'pachuca-de-soto', 'Centro Universitario Siglo XXI, Campus Pachuca de Soto', 'Pachuca de Soto', 'Pachuca de Soto', 'Hidalgo', NULL, NULL, false),
  ('centro-universitario-siglo-xxi-merida', 'centro-universitario-siglo-xxi', 'merida', U&'Centro Universitario Siglo XXI, Campus M\00E9rida', U&'M\00E9rida', U&'M\00E9rida', U&'Yucat\00E1n', NULL, NULL, false),
  ('colmex', 'colmex', 'principal', U&'El Colegio de M\00E9xico', NULL, U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, NULL, true),
  ('instituto-de-ciencias-y-estudios-superiores-de-tamaulipas', 'instituto-de-ciencias-y-estudios-superiores-de-tamaulipas', 'principal', 'Instituto de Ciencias y Estudios Superiores de Tamaulipas', NULL, 'Tampico', 'Tamaulipas', NULL, NULL, false),
  ('instituto-de-estudios-superiores-isima-queretaro', 'instituto-de-estudios-superiores-isima', 'queretaro', U&'Instituto de Estudios Superiores ISIMA, Campus Quer\00E9taro', U&'Quer\00E9taro', U&'Quer\00E9taro', U&'Quer\00E9taro', NULL, NULL, false),
  ('instituto-de-estudios-superiores-isima-toluca', 'instituto-de-estudios-superiores-isima', 'toluca', 'Instituto de Estudios Superiores ISIMA, Campus Toluca', 'Toluca', 'Toluca', U&'Estado de M\00E9xico', NULL, NULL, false),
  ('ipn', 'ipn', 'principal', U&'Instituto Polit\00E9cnico Nacional', NULL, U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, NULL, true),
  ('instituto-profesional-de-emprendedores', 'instituto-profesional-de-emprendedores', 'principal', 'Instituto Profesional de Emprendedores', NULL, U&'Tuxtla Guti\00E9rrez', 'Chiapas', NULL, NULL, false),
  ('itam', 'itam', 'principal', U&'Instituto Tecnol\00F3gico Aut\00F3nomo de M\00E9xico', NULL, U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, NULL, true),
  ('instituto-tecnologico-de-acapulco', 'instituto-tecnologico-de-acapulco', 'principal', U&'Instituto Tecnol\00F3gico de Acapulco', NULL, U&'Acapulco de Ju\00E1rez', 'Guerrero', NULL, NULL, false),
  ('instituto-tecnologico-de-aguascalientes', 'instituto-tecnologico-de-aguascalientes', 'principal', U&'Instituto Tecnol\00F3gico de Aguascalientes', NULL, 'Aguascalientes', 'Aguascalientes', NULL, NULL, false),
  ('instituto-tecnologico-de-apizaco', 'instituto-tecnologico-de-apizaco', 'principal', U&'Instituto Tecnol\00F3gico de Apizaco', NULL, 'Tzompantepec', 'Tlaxcala', NULL, NULL, false),
  ('instituto-tecnologico-de-campeche', 'instituto-tecnologico-de-campeche', 'principal', U&'Instituto Tecnol\00F3gico de Campeche', NULL, 'Campeche', 'Campeche', NULL, NULL, false),
  ('instituto-tecnologico-de-cancun', 'instituto-tecnologico-de-cancun', 'principal', U&'Instituto Tecnol\00F3gico de Canc\00FAn', NULL, U&'Benito Ju\00E1rez', 'Quintana Roo', NULL, NULL, false),
  ('instituto-tecnologico-de-chilpancingo', 'instituto-tecnologico-de-chilpancingo', 'principal', U&'Instituto Tecnol\00F3gico de Chilpancingo', NULL, 'Chilpancingo de los Bravo', 'Guerrero', NULL, NULL, false),
  ('instituto-tecnologico-de-ciudad-juarez', 'instituto-tecnologico-de-ciudad-juarez', 'principal', U&'Instituto Tecnol\00F3gico de Ciudad Ju\00E1rez', NULL, U&'Ju\00E1rez', 'Chihuahua', NULL, NULL, false),
  ('instituto-tecnologico-de-ciudad-madero', 'instituto-tecnologico-de-ciudad-madero', 'principal', U&'Instituto Tecnol\00F3gico de Ciudad Madero', NULL, 'Ciudad Madero', 'Tamaulipas', NULL, NULL, false),
  ('instituto-tecnologico-de-colima', 'instituto-tecnologico-de-colima', 'principal', U&'Instituto Tecnol\00F3gico de Colima', NULL, U&'Villa de \00C1lvarez', 'Colima', NULL, NULL, false),
  ('instituto-tecnologico-de-culiacan', 'instituto-tecnologico-de-culiacan', 'principal', U&'Instituto Tecnol\00F3gico de Culiac\00E1n', NULL, U&'Culiac\00E1n', 'Sinaloa', NULL, NULL, false),
  ('instituto-tecnologico-de-durango', 'instituto-tecnologico-de-durango', 'principal', U&'Instituto Tecnol\00F3gico de Durango', NULL, 'Durango', 'Durango', NULL, NULL, false),
  ('instituto-tecnologico-de-estudios-superiores-de-zamora', 'instituto-tecnologico-de-estudios-superiores-de-zamora', 'principal', U&'Instituto Tecnol\00F3gico de Estudios Superiores de Zamora', NULL, 'Zamora', U&'Michoac\00E1n', NULL, NULL, false),
  ('instituto-tecnologico-de-estudios-superiores-los-cabos', 'instituto-tecnologico-de-estudios-superiores-los-cabos', 'principal', U&'Instituto Tecnol\00F3gico de Estudios Superiores Los Cabos', NULL, 'Los Cabos', 'Baja California Sur', NULL, NULL, false),
  ('instituto-tecnologico-de-hermosillo', 'instituto-tecnologico-de-hermosillo', 'principal', U&'Instituto Tecnol\00F3gico de Hermosillo', NULL, 'Hermosillo', 'Sonora', NULL, NULL, false),
  ('instituto-tecnologico-de-la-laguna', 'instituto-tecnologico-de-la-laguna', 'principal', U&'Instituto Tecnol\00F3gico de La Laguna', NULL, U&'Torre\00F3n', 'Coahuila', NULL, NULL, false),
  ('instituto-tecnologico-de-la-paz', 'instituto-tecnologico-de-la-paz', 'principal', U&'Instituto Tecnol\00F3gico de La Paz', NULL, 'La Paz', 'Baja California Sur', NULL, NULL, false),
  ('instituto-tecnologico-de-los-mochis', 'instituto-tecnologico-de-los-mochis', 'principal', U&'Instituto Tecnol\00F3gico de Los Mochis', NULL, 'Ahome', 'Sinaloa', NULL, NULL, false),
  ('instituto-tecnologico-de-matamoros', 'instituto-tecnologico-de-matamoros', 'principal', U&'Instituto Tecnol\00F3gico de Matamoros', NULL, 'Matamoros', 'Tamaulipas', NULL, NULL, false),
  ('instituto-tecnologico-de-merida', 'instituto-tecnologico-de-merida', 'principal', U&'Instituto Tecnol\00F3gico de M\00E9rida', NULL, U&'M\00E9rida', U&'Yucat\00E1n', NULL, NULL, false),
  ('instituto-tecnologico-de-morelia', 'instituto-tecnologico-de-morelia', 'principal', U&'Instituto Tecnol\00F3gico de Morelia', NULL, 'Morelia', U&'Michoac\00E1n', NULL, NULL, false),
  ('instituto-tecnologico-de-nuevo-leon', 'instituto-tecnologico-de-nuevo-leon', 'principal', U&'Instituto Tecnol\00F3gico de Nuevo Le\00F3n', NULL, 'Guadalupe', U&'Nuevo Le\00F3n', NULL, NULL, false),
  ('instituto-tecnologico-de-oaxaca', 'instituto-tecnologico-de-oaxaca', 'principal', U&'Instituto Tecnol\00F3gico de Oaxaca', NULL, U&'Oaxaca de Ju\00E1rez', 'Oaxaca', NULL, NULL, false),
  ('instituto-tecnologico-de-pachuca', 'instituto-tecnologico-de-pachuca', 'principal', U&'Instituto Tecnol\00F3gico de Pachuca', NULL, 'Pachuca de Soto', 'Hidalgo', NULL, NULL, false),
  ('instituto-tecnologico-de-puebla', 'instituto-tecnologico-de-puebla', 'principal', U&'Instituto Tecnol\00F3gico de Puebla', NULL, 'Puebla', 'Puebla', NULL, NULL, false),
  ('instituto-tecnologico-de-queretaro', 'instituto-tecnologico-de-queretaro', 'principal', U&'Instituto Tecnol\00F3gico de Quer\00E9taro', NULL, U&'Quer\00E9taro', U&'Quer\00E9taro', NULL, NULL, false),
  ('instituto-tecnologico-de-saltillo', 'instituto-tecnologico-de-saltillo', 'principal', U&'Instituto Tecnol\00F3gico de Saltillo', NULL, 'Saltillo', 'Coahuila', NULL, NULL, false),
  ('instituto-tecnologico-de-san-luis-potosi', 'instituto-tecnologico-de-san-luis-potosi', 'principal', U&'Instituto Tecnol\00F3gico de San Luis Potos\00ED', NULL, U&'Soledad de Graciano S\00E1nchez', U&'San Luis Potos\00ED', NULL, NULL, false),
  ('instituto-tecnologico-de-sonora', 'instituto-tecnologico-de-sonora', 'principal', U&'Instituto Tecnol\00F3gico de Sonora', NULL, 'Cajeme', 'Sonora', NULL, NULL, false),
  ('instituto-tecnologico-de-tepic', 'instituto-tecnologico-de-tepic', 'principal', U&'Instituto Tecnol\00F3gico de Tepic', NULL, 'Tepic', 'Nayarit', NULL, NULL, false),
  ('instituto-tecnologico-de-tijuana', 'instituto-tecnologico-de-tijuana', 'principal', U&'Instituto Tecnol\00F3gico de Tijuana', NULL, 'Tijuana', 'Baja California', NULL, NULL, false),
  ('instituto-tecnologico-de-tuxtla-gutierrez', 'instituto-tecnologico-de-tuxtla-gutierrez', 'principal', U&'Instituto Tecnol\00F3gico de Tuxtla Guti\00E9rrez', NULL, U&'Tuxtla Guti\00E9rrez', 'Chiapas', NULL, NULL, false),
  ('instituto-tecnologico-de-villahermosa', 'instituto-tecnologico-de-villahermosa', 'principal', U&'Instituto Tecnol\00F3gico de Villahermosa', NULL, 'Centro', 'Tabasco', NULL, NULL, false),
  ('instituto-tecnologico-de-zacatecas', 'instituto-tecnologico-de-zacatecas', 'principal', U&'Instituto Tecnol\00F3gico de Zacatecas', NULL, 'Zacatecas', 'Zacatecas', NULL, NULL, false),
  ('instituto-tecnologico-de-zacatepec', 'instituto-tecnologico-de-zacatepec', 'principal', U&'Instituto Tecnol\00F3gico de Zacatepec', NULL, 'Zacatepec', 'Morelos', NULL, NULL, false),
  ('instituto-tecnologico-del-istmo', 'instituto-tecnologico-del-istmo', 'principal', U&'Instituto Tecnol\00F3gico del Istmo', NULL, U&'Juchit\00E1n de Zaragoza', 'Oaxaca', NULL, NULL, false),
  ('instituto-tecnologico-mario-molina', 'instituto-tecnologico-mario-molina', 'principal', U&'Instituto Tecnol\00F3gico Mario Molina', NULL, 'Zapopan', 'Jalisco', NULL, NULL, false),
  ('instituto-tecnologico-superior-de-calkini-en-el-estado-de-campeche', 'instituto-tecnologico-superior-de-calkini-en-el-estado-de-campeche', 'principal', U&'Instituto Tecnol\00F3gico Superior de Calkin\00ED en el Estado de Campeche', NULL, U&'Calkin\00ED', 'Campeche', NULL, NULL, false),
  ('instituto-tecnologico-superior-de-irapuato', 'instituto-tecnologico-superior-de-irapuato', 'principal', U&'Instituto Tecnol\00F3gico Superior de Irapuato', NULL, 'Irapuato', 'Guanajuato', NULL, NULL, false),
  ('instituto-tecnologico-superior-de-lerdo', 'instituto-tecnologico-superior-de-lerdo', 'principal', U&'Instituto Tecnol\00F3gico Superior de Lerdo', NULL, 'Lerdo', 'Durango', NULL, NULL, false),
  ('instituto-tecnologico-superior-de-xalapa', 'instituto-tecnologico-superior-de-xalapa', 'principal', U&'Instituto Tecnol\00F3gico Superior de Xalapa', NULL, 'Xalapa', 'Veracruz', NULL, NULL, false),
  ('instituto-universitario-del-centro-de-mexico', 'instituto-universitario-del-centro-de-mexico', 'principal', U&'Instituto Universitario del Centro de M\00E9xico', NULL, U&'Le\00F3n', 'Guanajuato', NULL, NULL, false),
  ('instituto-universitario-del-norte', 'instituto-universitario-del-norte', 'principal', 'Instituto Universitario del Norte', NULL, 'Saltillo', 'Coahuila', NULL, NULL, false),
  ('ites-rene-descartes', 'ites-rene-descartes', 'principal', U&'ITES Ren\00E9 Descartes', NULL, 'Campeche', 'Campeche', NULL, NULL, false),
  ('iteso-universidad-jesuita-de-guadalajara', 'iteso-universidad-jesuita-de-guadalajara', 'principal', 'ITESO, Universidad Jesuita de Guadalajara', NULL, 'San Pedro Tlaquepaque', 'Jalisco', NULL, NULL, false),
  ('tecnologico-de-estudios-superiores-de-ecatepec', 'tecnologico-de-estudios-superiores-de-ecatepec', 'principal', U&'Tecnol\00F3gico de Estudios Superiores de Ecatepec', NULL, 'Ecatepec de Morelos', U&'Estado de M\00E9xico', NULL, NULL, false),
  ('tec-monterrey', 'tec', 'monterrey', U&'Tecnol\00F3gico de Monterrey, Campus Monterrey', 'Monterrey', 'Monterrey', U&'Nuevo Le\00F3n', NULL, NULL, true),
  ('tec-guadalajara', 'tec', 'guadalajara', U&'Tecnol\00F3gico de Monterrey, Campus Guadalajara', 'Guadalajara', 'Zapopan', 'Jalisco', NULL, NULL, true),
  ('tec-ciudad-de-mexico', 'tec', 'ciudad-de-mexico', U&'Tecnol\00F3gico de Monterrey, Campus Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, NULL, true),
  ('tec-estado-de-mexico', 'tec', 'estado-de-mexico', U&'Tecnol\00F3gico de Monterrey, Campus Estado de M\00E9xico', U&'Estado de M\00E9xico', U&'Atizap\00E1n de Zaragoza', U&'Estado de M\00E9xico', NULL, NULL, false),
  ('tec-queretaro', 'tec', 'queretaro', U&'Tecnol\00F3gico de Monterrey, Campus Quer\00E9taro', U&'Quer\00E9taro', U&'Quer\00E9taro', U&'Quer\00E9taro', NULL, NULL, true),
  ('tec-puebla', 'tec', 'puebla', U&'Tecnol\00F3gico de Monterrey, Campus Puebla', 'Puebla', 'Puebla', 'Puebla', NULL, NULL, false),
  ('tec-santa-fe', 'tec', 'santa-fe', U&'Tecnol\00F3gico de Monterrey, Campus Santa Fe', 'Santa Fe', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, NULL, false),
  ('tec-toluca', 'tec', 'toluca', U&'Tecnol\00F3gico de Monterrey, Campus Toluca', 'Toluca', 'Toluca', U&'Estado de M\00E9xico', NULL, NULL, false),
  ('tec-chihuahua', 'tec', 'chihuahua', U&'Tecnol\00F3gico de Monterrey, Campus Chihuahua', 'Chihuahua', 'Chihuahua', 'Chihuahua', NULL, NULL, false),
  ('tec-sonora-norte', 'tec', 'sonora-norte', U&'Tecnol\00F3gico de Monterrey, Campus Sonora Norte', 'Sonora Norte', 'Hermosillo', 'Sonora', NULL, NULL, false),
  ('tec-leon', 'tec', 'leon', U&'Tecnol\00F3gico de Monterrey, Campus Le\00F3n', U&'Le\00F3n', U&'Le\00F3n', 'Guanajuato', NULL, NULL, false),
  ('tec-san-luis-potosi', 'tec', 'san-luis-potosi', U&'Tecnol\00F3gico de Monterrey, Campus San Luis Potos\00ED', U&'San Luis Potos\00ED', U&'San Luis Potos\00ED', U&'San Luis Potos\00ED', NULL, NULL, false),
  ('tec-hidalgo', 'tec', 'hidalgo', U&'Tecnol\00F3gico de Monterrey, Campus Hidalgo', 'Hidalgo', 'Pachuca de Soto', 'Hidalgo', NULL, NULL, false),
  ('tec-laguna', 'tec', 'laguna', U&'Tecnol\00F3gico de Monterrey, Campus Laguna', 'Laguna', U&'Torre\00F3n', 'Coahuila', NULL, NULL, false),
  ('universidad-alfa-y-omega', 'universidad-alfa-y-omega', 'principal', 'Universidad Alfa y Omega', NULL, 'Centro', 'Tabasco', NULL, NULL, false),
  ('anahuac', 'anahuac', 'huixquilucan', U&'Universidad An\00E1huac', 'Huixquilucan', 'Huixquilucan', U&'Estado de M\00E9xico', NULL, NULL, true),
  ('anahuac-el-marques', 'anahuac', 'el-marques', U&'Universidad An\00E1huac, Campus El Marqu\00E9s', U&'El Marqu\00E9s', U&'El Marqu\00E9s', U&'Quer\00E9taro', NULL, NULL, false),
  ('anahuac-xalapa', 'anahuac', 'xalapa', U&'Universidad An\00E1huac, Campus Xalapa', 'Xalapa', 'Xalapa', 'Veracruz', NULL, NULL, false),
  ('anahuac-san-andres-cholula', 'anahuac', 'san-andres-cholula', U&'Universidad An\00E1huac, Campus San Andr\00E9s Cholula', U&'San Andr\00E9s Cholula', U&'San Andr\00E9s Cholula', 'Puebla', NULL, NULL, false),
  ('universidad-anahuac-de-cancun', 'universidad-anahuac-de-cancun', 'principal', U&'Universidad An\00E1huac de Canc\00FAn', NULL, U&'Benito Ju\00E1rez', 'Quintana Roo', NULL, NULL, false),
  ('universidad-autonoma-agraria-antonio-narro', 'universidad-autonoma-agraria-antonio-narro', 'principal', U&'Universidad Aut\00F3noma Agraria Antonio Narro', NULL, 'Saltillo', 'Coahuila', NULL, NULL, false),
  ('universidad-autonoma-benito-juarez-de-oaxaca', 'universidad-autonoma-benito-juarez-de-oaxaca', 'principal', U&'Universidad Aut\00F3noma Benito Ju\00E1rez de Oaxaca', NULL, U&'Oaxaca de Ju\00E1rez', 'Oaxaca', NULL, NULL, false),
  ('universidad-autonoma-chapingo', 'universidad-autonoma-chapingo', 'principal', U&'Universidad Aut\00F3noma Chapingo', NULL, 'Texcoco', U&'Estado de M\00E9xico', NULL, NULL, false),
  ('universidad-autonoma-de-aguascalientes', 'universidad-autonoma-de-aguascalientes', 'principal', U&'Universidad Aut\00F3noma de Aguascalientes', NULL, 'Aguascalientes', 'Aguascalientes', NULL, NULL, false),
  ('universidad-autonoma-de-baja-california', 'universidad-autonoma-de-baja-california', 'principal', U&'Universidad Aut\00F3noma de Baja California', NULL, 'Tijuana', 'Baja California', NULL, NULL, false),
  ('universidad-autonoma-de-baja-california-sur', 'universidad-autonoma-de-baja-california-sur', 'principal', U&'Universidad Aut\00F3noma de Baja California Sur', NULL, 'La Paz', 'Baja California Sur', NULL, NULL, false),
  ('universidad-autonoma-de-campeche', 'universidad-autonoma-de-campeche', 'principal', U&'Universidad Aut\00F3noma de Campeche', NULL, 'Campeche', 'Campeche', NULL, NULL, false),
  ('universidad-autonoma-de-chiapas', 'universidad-autonoma-de-chiapas', 'principal', U&'Universidad Aut\00F3noma de Chiapas', NULL, U&'Tuxtla Guti\00E9rrez', 'Chiapas', NULL, NULL, false),
  ('universidad-autonoma-de-chihuahua', 'universidad-autonoma-de-chihuahua', 'principal', U&'Universidad Aut\00F3noma de Chihuahua', NULL, 'Chihuahua', 'Chihuahua', NULL, NULL, false),
  ('universidad-autonoma-de-ciudad-juarez', 'universidad-autonoma-de-ciudad-juarez', 'principal', U&'Universidad Aut\00F3noma de Ciudad Ju\00E1rez', NULL, U&'Ju\00E1rez', 'Chihuahua', NULL, NULL, false),
  ('universidad-autonoma-de-coahuila', 'universidad-autonoma-de-coahuila', 'principal', U&'Universidad Aut\00F3noma de Coahuila', NULL, U&'Torre\00F3n', 'Coahuila', NULL, NULL, false),
  ('universidad-autonoma-de-durango-durango', 'universidad-autonoma-de-durango', 'durango', U&'Universidad Aut\00F3noma de Durango, Campus Durango', 'Durango', 'Durango', 'Durango', NULL, NULL, false),
  ('universidad-autonoma-de-durango-mexicali', 'universidad-autonoma-de-durango', 'mexicali', U&'Universidad Aut\00F3noma de Durango, Campus Mexicali', 'Mexicali', 'Mexicali', 'Baja California', NULL, NULL, false),
  ('universidad-autonoma-de-durango-los-mochis', 'universidad-autonoma-de-durango', 'los-mochis', U&'Universidad Aut\00F3noma de Durango, Campus Los Mochis', 'Los Mochis', 'Ahome', 'Sinaloa', NULL, NULL, false),
  ('universidad-autonoma-de-durango-zacatecas', 'universidad-autonoma-de-durango', 'zacatecas', U&'Universidad Aut\00F3noma de Durango, Campus Zacatecas', 'Zacatecas', 'Zacatecas', 'Zacatecas', NULL, NULL, false),
  ('universidad-autonoma-de-durango-mazatlan', 'universidad-autonoma-de-durango', 'mazatlan', U&'Universidad Aut\00F3noma de Durango, Campus Mazatl\00E1n', U&'Mazatl\00E1n', U&'Mazatl\00E1n', 'Sinaloa', NULL, NULL, false),
  ('universidad-autonoma-de-durango-saltillo', 'universidad-autonoma-de-durango', 'saltillo', U&'Universidad Aut\00F3noma de Durango, Campus Saltillo', 'Saltillo', 'Saltillo', 'Coahuila', NULL, NULL, false),
  ('universidad-autonoma-de-durango-culiacan', 'universidad-autonoma-de-durango', 'culiacan', U&'Universidad Aut\00F3noma de Durango, Campus Culiac\00E1n', U&'Culiac\00E1n', U&'Culiac\00E1n', 'Sinaloa', NULL, NULL, false),
  ('universidad-autonoma-de-guadalajara-zapopan', 'universidad-autonoma-de-guadalajara', 'zapopan', U&'Universidad Aut\00F3noma de Guadalajara, Campus Zapopan', 'Zapopan', 'Zapopan', 'Jalisco', NULL, NULL, false),
  ('universidad-autonoma-de-guadalajara-tabasco', 'universidad-autonoma-de-guadalajara', 'tabasco', U&'Universidad Aut\00F3noma de Guadalajara, Campus Tabasco', 'Tabasco', 'Centro', 'Tabasco', NULL, NULL, false),
  ('universidad-autonoma-de-guerrero', 'universidad-autonoma-de-guerrero', 'principal', U&'Universidad Aut\00F3noma de Guerrero', NULL, U&'Acapulco de Ju\00E1rez', 'Guerrero', NULL, NULL, false),
  ('universidad-autonoma-de-la-ciudad-de-mexico', 'universidad-autonoma-de-la-ciudad-de-mexico', 'principal', U&'Universidad Aut\00F3noma de la Ciudad de M\00E9xico', NULL, U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, NULL, false),
  ('universidad-autonoma-de-nayarit', 'universidad-autonoma-de-nayarit', 'principal', U&'Universidad Aut\00F3noma de Nayarit', NULL, 'Tepic', 'Nayarit', NULL, NULL, false),
  ('uanl', 'uanl', 'principal', U&'Universidad Aut\00F3noma de Nuevo Le\00F3n', NULL, U&'San Nicol\00E1s de los Garza', U&'Nuevo Le\00F3n', NULL, NULL, true),
  ('universidad-autonoma-de-occidente', 'universidad-autonoma-de-occidente', 'principal', U&'Universidad Aut\00F3noma de Occidente', NULL, U&'Culiac\00E1n', 'Sinaloa', NULL, NULL, false),
  ('uaq', 'uaq', 'principal', U&'Universidad Aut\00F3noma de Quer\00E9taro', NULL, U&'Quer\00E9taro', U&'Quer\00E9taro', NULL, NULL, true),
  ('uaslp', 'uaslp', 'principal', U&'Universidad Aut\00F3noma de San Luis Potos\00ED', NULL, U&'San Luis Potos\00ED', U&'San Luis Potos\00ED', NULL, NULL, true),
  ('universidad-autonoma-de-sinaloa', 'universidad-autonoma-de-sinaloa', 'principal', U&'Universidad Aut\00F3noma de Sinaloa', NULL, U&'Culiac\00E1n', 'Sinaloa', NULL, NULL, false),
  ('universidad-autonoma-de-tamaulipas', 'universidad-autonoma-de-tamaulipas', 'principal', U&'Universidad Aut\00F3noma de Tamaulipas', NULL, 'Tampico', 'Tamaulipas', NULL, NULL, false),
  ('universidad-autonoma-de-tlaxcala', 'universidad-autonoma-de-tlaxcala', 'principal', U&'Universidad Aut\00F3noma de Tlaxcala', NULL, 'Tlaxcala', 'Tlaxcala', NULL, NULL, false),
  ('universidad-autonoma-de-yucatan', 'universidad-autonoma-de-yucatan', 'principal', U&'Universidad Aut\00F3noma de Yucat\00E1n', NULL, U&'M\00E9rida', U&'Yucat\00E1n', NULL, NULL, false),
  ('universidad-autonoma-de-zacatecas', 'universidad-autonoma-de-zacatecas', 'principal', U&'Universidad Aut\00F3noma de Zacatecas', NULL, 'Zacatecas', 'Zacatecas', NULL, NULL, false),
  ('universidad-autonoma-del-carmen', 'universidad-autonoma-del-carmen', 'principal', U&'Universidad Aut\00F3noma del Carmen', NULL, 'Carmen', 'Campeche', NULL, NULL, false),
  ('universidad-autonoma-del-estado-de-hidalgo', 'universidad-autonoma-del-estado-de-hidalgo', 'principal', U&'Universidad Aut\00F3noma del Estado de Hidalgo', NULL, U&'San Agust\00EDn Tlaxiaca', 'Hidalgo', NULL, NULL, false),
  ('uaemex', 'uaemex', 'principal', U&'Universidad Aut\00F3noma del Estado de M\00E9xico', NULL, 'Toluca', U&'Estado de M\00E9xico', NULL, NULL, true),
  ('universidad-autonoma-del-estado-de-morelos', 'universidad-autonoma-del-estado-de-morelos', 'principal', U&'Universidad Aut\00F3noma del Estado de Morelos', NULL, 'Cuernavaca', 'Morelos', NULL, NULL, false),
  ('universidad-autonoma-del-estado-de-quintana-roo', 'universidad-autonoma-del-estado-de-quintana-roo', 'principal', U&'Universidad Aut\00F3noma del Estado de Quintana Roo', NULL, U&'Oth\00F3n P. Blanco', 'Quintana Roo', NULL, NULL, false),
  ('universidad-autonoma-del-noreste', 'universidad-autonoma-del-noreste', 'principal', U&'Universidad Aut\00F3noma del Noreste', NULL, 'Saltillo', 'Coahuila', NULL, NULL, false),
  ('uam', 'uam', 'ciudad-de-mexico', U&'Universidad Aut\00F3noma Metropolitana', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, NULL, true),
  ('uam-lerma', 'uam', 'lerma', U&'Universidad Aut\00F3noma Metropolitana, Campus Lerma', 'Lerma', 'Lerma', U&'Estado de M\00E9xico', NULL, NULL, false),
  ('universidad-britanica-de-mexico', 'universidad-britanica-de-mexico', 'principal', U&'Universidad Brit\00E1nica de M\00E9xico', NULL, 'Aguascalientes', 'Aguascalientes', NULL, NULL, false),
  ('universidad-cristobal-colon', 'universidad-cristobal-colon', 'principal', U&'Universidad Crist\00F3bal Col\00F3n', NULL, 'Veracruz', 'Veracruz', NULL, NULL, false),
  ('universidad-cuauhtemoc-aguascalientes', 'universidad-cuauhtemoc', 'aguascalientes', U&'Universidad Cuauht\00E9moc, Campus Aguascalientes', 'Aguascalientes', U&'Jes\00FAs Mar\00EDa', 'Aguascalientes', NULL, NULL, false),
  ('universidad-cuauhtemoc-queretaro', 'universidad-cuauhtemoc', 'queretaro', U&'Universidad Cuauht\00E9moc, Campus Quer\00E9taro', U&'Quer\00E9taro', U&'Quer\00E9taro', U&'Quer\00E9taro', NULL, NULL, false),
  ('universidad-cuauhtemoc-san-luis-potosi', 'universidad-cuauhtemoc', 'san-luis-potosi', U&'Universidad Cuauht\00E9moc, Campus San Luis Potos\00ED', U&'San Luis Potos\00ED', U&'San Luis Potos\00ED', U&'San Luis Potos\00ED', NULL, NULL, false),
  ('universidad-cuauhtemoc-guadalajara', 'universidad-cuauhtemoc', 'guadalajara', U&'Universidad Cuauht\00E9moc, Campus Guadalajara', 'Guadalajara', 'Zapopan', 'Jalisco', NULL, NULL, false),
  ('universidad-cuauhtemoc-xalapa', 'universidad-cuauhtemoc', 'xalapa', U&'Universidad Cuauht\00E9moc, Campus Xalapa', 'Xalapa', 'Xalapa', 'Veracruz', NULL, NULL, false),
  ('universidad-cultural', 'universidad-cultural', 'principal', 'Universidad Cultural', NULL, U&'Ju\00E1rez', 'Chihuahua', NULL, NULL, false),
  ('universidad-de-ciencias-y-artes-de-chiapas', 'universidad-de-ciencias-y-artes-de-chiapas', 'principal', 'Universidad de Ciencias y Artes de Chiapas', NULL, U&'Tuxtla Guti\00E9rrez', 'Chiapas', NULL, NULL, false),
  ('universidad-de-colima', 'universidad-de-colima', 'principal', 'Universidad de Colima', NULL, 'Colima', 'Colima', NULL, NULL, false),
  ('udg', 'udg', 'principal', 'Universidad de Guadalajara', NULL, 'Guadalajara', 'Jalisco', NULL, NULL, true),
  ('universidad-de-guanajuato', 'universidad-de-guanajuato', 'principal', 'Universidad de Guanajuato', NULL, 'Guanajuato', 'Guanajuato', NULL, NULL, false),
  ('universidad-de-la-salud-ciudad-de-mexico', 'universidad-de-la-salud', 'ciudad-de-mexico', U&'Universidad de la Salud, Campus Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, NULL, false),
  ('universidad-de-la-salud-puebla', 'universidad-de-la-salud', 'puebla', 'Universidad de la Salud, Campus Puebla', 'Puebla', 'Puebla', 'Puebla', NULL, NULL, false),
  ('udlap', 'udlap', 'principal', U&'Universidad de las Am\00E9ricas Puebla', NULL, U&'San Andr\00E9s Cholula', 'Puebla', NULL, NULL, true),
  ('universidad-de-leon', 'universidad-de-leon', 'principal', U&'Universidad de Le\00F3n', NULL, U&'Le\00F3n', 'Guanajuato', NULL, NULL, false),
  ('universidad-de-los-mochis', 'universidad-de-los-mochis', 'principal', 'Universidad de Los Mochis', NULL, 'Ahome', 'Sinaloa', NULL, NULL, false),
  ('universidad-de-monterrey', 'universidad-de-monterrey', 'principal', 'Universidad de Monterrey', NULL, U&'San Pedro Garza Garc\00EDa', U&'Nuevo Le\00F3n', NULL, NULL, false),
  ('universidad-de-oriente-veracruz', 'universidad-de-oriente-veracruz', 'principal', 'Universidad de Oriente - Veracruz', NULL, 'Veracruz', 'Veracruz', NULL, NULL, false),
  ('universidad-de-sonora', 'universidad-de-sonora', 'principal', 'Universidad de Sonora', NULL, 'Hermosillo', 'Sonora', NULL, NULL, false),
  ('universidad-del-atlantico', 'universidad-del-atlantico', 'principal', U&'Universidad del Atl\00E1ntico', NULL, 'Reynosa', 'Tamaulipas', NULL, NULL, false),
  ('universidad-del-caribe', 'universidad-del-caribe', 'principal', 'Universidad del Caribe', NULL, U&'Benito Ju\00E1rez', 'Quintana Roo', NULL, NULL, false),
  ('universidad-del-desarrollo-profesional-hermosillo', 'universidad-del-desarrollo-profesional', 'hermosillo', 'Universidad del Desarrollo Profesional, Campus Hermosillo', 'Hermosillo', 'Hermosillo', 'Sonora', NULL, NULL, false),
  ('universidad-del-desarrollo-profesional-tijuana', 'universidad-del-desarrollo-profesional', 'tijuana', 'Universidad del Desarrollo Profesional, Campus Tijuana', 'Tijuana', 'Tijuana', 'Baja California', NULL, NULL, false),
  ('universidad-del-golfo-de-california', 'universidad-del-golfo-de-california', 'principal', 'Universidad del Golfo de California', NULL, 'Los Cabos', 'Baja California Sur', NULL, NULL, false),
  ('universidad-del-valle-de-cuernavaca', 'universidad-del-valle-de-cuernavaca', 'principal', 'Universidad del Valle de Cuernavaca', NULL, 'Cuernavaca', 'Morelos', NULL, NULL, false),
  ('universidad-del-valle-de-mexico-lomas-verdes', 'universidad-del-valle-de-mexico', 'lomas-verdes', U&'Universidad del Valle de M\00E9xico, Campus Lomas Verdes', 'Lomas Verdes', U&'Coacalco de Berrioz\00E1bal', U&'Estado de M\00E9xico', NULL, NULL, false),
  ('universidad-del-valle-de-mexico-ciudad-de-mexico', 'universidad-del-valle-de-mexico', 'ciudad-de-mexico', U&'Universidad del Valle de M\00E9xico, Campus Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, NULL, false),
  ('universidad-del-valle-de-mexico-queretaro', 'universidad-del-valle-de-mexico', 'queretaro', U&'Universidad del Valle de M\00E9xico, Campus Quer\00E9taro', U&'Quer\00E9taro', U&'Quer\00E9taro', U&'Quer\00E9taro', NULL, NULL, false),
  ('universidad-del-valle-de-mexico-san-andres-cholula', 'universidad-del-valle-de-mexico', 'san-andres-cholula', U&'Universidad del Valle de M\00E9xico, Campus San Andr\00E9s Cholula', U&'San Andr\00E9s Cholula', U&'San Andr\00E9s Cholula', 'Puebla', NULL, NULL, false),
  ('universidad-del-valle-de-mexico-villahermosa', 'universidad-del-valle-de-mexico', 'villahermosa', U&'Universidad del Valle de M\00E9xico, Campus Villahermosa', 'Villahermosa', 'Centro', 'Tabasco', NULL, NULL, false),
  ('universidad-del-valle-de-mexico-victoria', 'universidad-del-valle-de-mexico', 'victoria', U&'Universidad del Valle de M\00E9xico, Campus Victoria', 'Victoria', 'Victoria', 'Tamaulipas', NULL, NULL, false),
  ('universidad-del-valle-de-mexico-hermosillo', 'universidad-del-valle-de-mexico', 'hermosillo', U&'Universidad del Valle de M\00E9xico, Campus Hermosillo', 'Hermosillo', 'Hermosillo', 'Sonora', NULL, NULL, false),
  ('universidad-del-valle-de-mexico-veracruz', 'universidad-del-valle-de-mexico', 'veracruz', U&'Universidad del Valle de M\00E9xico, Campus Veracruz', 'Veracruz', U&'Boca del R\00EDo', 'Veracruz', NULL, NULL, false),
  ('universidad-del-valle-de-mexico-cumbres', 'universidad-del-valle-de-mexico', 'cumbres', U&'Universidad del Valle de M\00E9xico, Campus Cumbres', 'Cumbres', 'Monterrey', U&'Nuevo Le\00F3n', NULL, NULL, false),
  ('universidad-del-valle-de-mexico-merida-79-uvm-s-c', 'universidad-del-valle-de-mexico', 'merida-79-uvm-s-c', U&'Universidad del Valle de M\00E9xico, Campus M\00E9rida (79 UVM, S.c.)', U&'M\00E9rida (79 UVM, S.c.)', U&'M\00E9rida', U&'Yucat\00E1n', NULL, NULL, false),
  ('universidad-del-valle-de-mexico-monterrey', 'universidad-del-valle-de-mexico', 'monterrey', U&'Universidad del Valle de M\00E9xico, Campus Monterrey', 'Monterrey', U&'San Nicol\00E1s de los Garza', U&'Nuevo Le\00F3n', NULL, NULL, false),
  ('universidad-del-valle-de-mexico-chihuahua', 'universidad-del-valle-de-mexico', 'chihuahua', U&'Universidad del Valle de M\00E9xico, Campus Chihuahua', 'Chihuahua', 'Chihuahua', 'Chihuahua', NULL, NULL, false),
  ('universidad-del-valle-de-mexico-guadalajara', 'universidad-del-valle-de-mexico', 'guadalajara', U&'Universidad del Valle de M\00E9xico, Campus Guadalajara', 'Guadalajara', 'San Pedro Tlaquepaque', 'Jalisco', NULL, NULL, false),
  ('universidad-del-valle-de-mexico-saltillo', 'universidad-del-valle-de-mexico', 'saltillo', U&'Universidad del Valle de M\00E9xico, Campus Saltillo', 'Saltillo', 'Saltillo', 'Coahuila', NULL, NULL, false),
  ('universidad-del-valle-de-mexico-mexicali', 'universidad-del-valle-de-mexico', 'mexicali', U&'Universidad del Valle de M\00E9xico, Campus Mexicali', 'Mexicali', 'Mexicali', 'Baja California', NULL, NULL, false),
  ('universidad-estatal-de-sonora', 'universidad-estatal-de-sonora', 'principal', 'Universidad Estatal de Sonora', NULL, 'Hermosillo', 'Sonora', NULL, NULL, false),
  ('universidad-hipocrates', 'universidad-hipocrates', 'principal', U&'Universidad Hip\00F3crates', NULL, U&'Acapulco de Ju\00E1rez', 'Guerrero', NULL, NULL, false),
  ('ibero', 'ibero', 'ciudad-de-mexico', 'Universidad Iberoamericana', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, NULL, true),
  ('ibero-leon', 'ibero', 'leon', U&'Universidad Iberoamericana, Campus Le\00F3n', U&'Le\00F3n', U&'Le\00F3n', 'Guanajuato', NULL, NULL, false),
  ('universidad-iberoamericana-puebla', 'universidad-iberoamericana-puebla', 'principal', 'Universidad Iberoamericana Puebla', NULL, U&'San Andr\00E9s Cholula', 'Puebla', NULL, NULL, false),
  ('universidad-internacional', 'universidad-internacional', 'principal', 'Universidad Internacional', NULL, 'Cuernavaca', 'Morelos', NULL, NULL, false),
  ('universidad-juarez-autonoma-de-tabasco', 'universidad-juarez-autonoma-de-tabasco', 'principal', U&'Universidad Ju\00E1rez Aut\00F3noma de Tabasco', NULL, 'Centro', 'Tabasco', NULL, NULL, false),
  ('universidad-juarez-del-estado-de-durango', 'universidad-juarez-del-estado-de-durango', 'principal', U&'Universidad Ju\00E1rez del Estado de Durango', NULL, 'Durango', 'Durango', NULL, NULL, false),
  ('universidad-la-salle-cancun', 'universidad-la-salle-cancun', 'principal', U&'Universidad La Salle Canc\00FAn', NULL, U&'Benito Ju\00E1rez', 'Quintana Roo', NULL, NULL, false),
  ('universidad-la-salle-chihuahua', 'universidad-la-salle-chihuahua', 'principal', 'Universidad La Salle Chihuahua', NULL, 'Chihuahua', 'Chihuahua', NULL, NULL, false),
  ('universidad-la-salle-laguna', 'universidad-la-salle-laguna', 'principal', 'Universidad La Salle Laguna', NULL, U&'G\00F3mez Palacio', 'Durango', NULL, NULL, false),
  ('universidad-la-salle-noroeste', 'universidad-la-salle-noroeste', 'principal', 'Universidad La Salle Noroeste', NULL, 'Cajeme', 'Sonora', NULL, NULL, false),
  ('universidad-la-salle-oaxaca', 'universidad-la-salle-oaxaca', 'principal', 'Universidad La Salle Oaxaca', NULL, U&'Santa Cruz Xoxocotl\00E1n', 'Oaxaca', NULL, NULL, false),
  ('universidad-marista-de-merida', 'universidad-marista-de-merida', 'principal', U&'Universidad Marista de M\00E9rida', NULL, U&'M\00E9rida', U&'Yucat\00E1n', NULL, NULL, false),
  ('universidad-metropolitana-de-monterrey', 'universidad-metropolitana-de-monterrey', 'principal', 'Universidad Metropolitana de Monterrey', NULL, 'Monterrey', U&'Nuevo Le\00F3n', NULL, NULL, false),
  ('universidad-mexiquense-del-bicentenario', 'universidad-mexiquense-del-bicentenario', 'principal', 'Universidad Mexiquense del Bicentenario', NULL, 'Ecatepec de Morelos', U&'Estado de M\00E9xico', NULL, NULL, false),
  ('universidad-michoacana-de-san-nicolas-de-hidalgo', 'universidad-michoacana-de-san-nicolas-de-hidalgo', 'principal', U&'Universidad Michoacana de San Nicol\00E1s de Hidalgo', NULL, 'Morelia', U&'Michoac\00E1n', NULL, NULL, false),
  ('universidad-montrer', 'universidad-montrer', 'principal', 'Universidad Montrer', NULL, 'Morelia', U&'Michoac\00E1n', NULL, NULL, false),
  ('universidad-mundo-maya-centro', 'universidad-mundo-maya', 'centro', 'Universidad Mundo Maya, Campus Centro', 'Centro', 'Centro', 'Tabasco', NULL, NULL, false),
  ('universidad-mundo-maya-campeche', 'universidad-mundo-maya', 'campeche', 'Universidad Mundo Maya, Campus Campeche', 'Campeche', 'Campeche', 'Campeche', NULL, NULL, false),
  ('unam', 'unam', 'ciudad-de-mexico', U&'Universidad Nacional Aut\00F3noma de M\00E9xico', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, NULL, true),
  ('unam-naucalpan-de-juarez', 'unam', 'naucalpan-de-juarez', U&'Universidad Nacional Aut\00F3noma de M\00E9xico, Campus Naucalpan de Ju\00E1rez', U&'Naucalpan de Ju\00E1rez', U&'Naucalpan de Ju\00E1rez', U&'Estado de M\00E9xico', NULL, NULL, false),
  ('unam-morelia', 'unam', 'morelia', U&'Universidad Nacional Aut\00F3noma de M\00E9xico, Campus Morelia', 'Morelia', 'Morelia', U&'Michoac\00E1n', NULL, NULL, false),
  ('unam-leon', 'unam', 'leon', U&'Universidad Nacional Aut\00F3noma de M\00E9xico, Campus Le\00F3n', U&'Le\00F3n', U&'Le\00F3n', 'Guanajuato', NULL, NULL, false),
  ('unam-queretaro', 'unam', 'queretaro', U&'Universidad Nacional Aut\00F3noma de M\00E9xico, Campus Quer\00E9taro', U&'Quer\00E9taro', U&'Quer\00E9taro', U&'Quer\00E9taro', NULL, NULL, false),
  ('unam-ucu', 'unam', 'ucu', U&'Universidad Nacional Aut\00F3noma de M\00E9xico, Campus Uc\00FA', U&'Uc\00FA', U&'Uc\00FA', U&'Yucat\00E1n', NULL, NULL, false),
  ('universidad-olmeca', 'universidad-olmeca', 'principal', 'Universidad Olmeca', NULL, 'Centro', 'Tabasco', NULL, NULL, false),
  ('universidad-pablo-guardado-chavez', 'universidad-pablo-guardado-chavez', 'principal', U&'Universidad Pablo Guardado Ch\00E1vez', NULL, U&'Tuxtla Guti\00E9rrez', 'Chiapas', NULL, NULL, false),
  ('up', 'up', 'ciudad-de-mexico', 'Universidad Panamericana', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, NULL, true),
  ('up-guadalajara', 'up', 'guadalajara', 'Universidad Panamericana, Campus Guadalajara', 'Guadalajara', 'Zapopan', 'Jalisco', NULL, NULL, false),
  ('up-bonaterra', 'up', 'bonaterra', 'Universidad Panamericana, Campus Bonaterra', 'Bonaterra', 'Aguascalientes', 'Aguascalientes', NULL, NULL, false),
  ('up-huixquilucan', 'up', 'huixquilucan', 'Universidad Panamericana, Campus Huixquilucan', 'Huixquilucan', 'Huixquilucan', U&'Estado de M\00E9xico', NULL, NULL, false),
  ('universidad-politecnica-de-san-luis-potosi', 'universidad-politecnica-de-san-luis-potosi', 'principal', U&'Universidad Polit\00E9cnica de San Luis Potos\00ED', NULL, U&'San Luis Potos\00ED', U&'San Luis Potos\00ED', NULL, NULL, false),
  ('universidad-politecnica-de-tlaxcala', 'universidad-politecnica-de-tlaxcala', 'principal', U&'Universidad Polit\00E9cnica de Tlaxcala', NULL, 'Tepeyanco', 'Tlaxcala', NULL, NULL, false),
  ('universidad-popular-autonoma-del-estado-de-puebla', 'universidad-popular-autonoma-del-estado-de-puebla', 'principal', U&'Universidad Popular Aut\00F3noma del Estado de Puebla', NULL, 'Puebla', 'Puebla', NULL, NULL, false),
  ('universidad-popular-de-la-chontalpa', 'universidad-popular-de-la-chontalpa', 'principal', 'Universidad Popular de la Chontalpa', NULL, U&'C\00E1rdenas', 'Tabasco', NULL, NULL, false),
  ('universidad-potosina', 'universidad-potosina', 'principal', 'Universidad Potosina', NULL, U&'San Luis Potos\00ED', U&'San Luis Potos\00ED', NULL, NULL, false),
  ('universidad-regional-del-sureste', 'universidad-regional-del-sureste', 'principal', 'Universidad Regional del Sureste', NULL, U&'San Sebasti\00E1n Tutla', 'Oaxaca', NULL, NULL, false),
  ('universidad-tangamanga', 'universidad-tangamanga', 'principal', 'Universidad Tangamanga', NULL, U&'San Luis Potos\00ED', U&'San Luis Potos\00ED', NULL, NULL, false),
  ('universidad-tec-milenio-a-c', 'universidad-tec-milenio-a-c', 'principal', 'Universidad Tec Milenio A.c', NULL, U&'Culiac\00E1n', 'Sinaloa', NULL, NULL, false),
  ('universidad-tecnologica-de-aguascalientes', 'universidad-tecnologica-de-aguascalientes', 'principal', U&'Universidad Tecnol\00F3gica de Aguascalientes', NULL, 'Aguascalientes', 'Aguascalientes', NULL, NULL, false),
  ('universidad-tecnologica-de-ciudad-juarez', 'universidad-tecnologica-de-ciudad-juarez', 'principal', U&'Universidad Tecnol\00F3gica de Ciudad Ju\00E1rez', NULL, U&'Ju\00E1rez', 'Chihuahua', NULL, NULL, false),
  ('universidad-tecnologica-de-jalisco', 'universidad-tecnologica-de-jalisco', 'principal', U&'Universidad Tecnol\00F3gica de Jalisco', NULL, 'Guadalajara', 'Jalisco', NULL, NULL, false),
  ('universidad-tecnologica-de-leon', 'universidad-tecnologica-de-leon', 'principal', U&'Universidad Tecnol\00F3gica de Le\00F3n', NULL, U&'Le\00F3n', 'Guanajuato', NULL, NULL, false),
  ('universidad-tecnologica-de-manzanillo', 'universidad-tecnologica-de-manzanillo', 'principal', U&'Universidad Tecnol\00F3gica de Manzanillo', NULL, 'Manzanillo', 'Colima', NULL, NULL, false),
  ('universidad-tecnologica-de-mexico-atizapan-de-zaragoza', 'universidad-tecnologica-de-mexico', 'atizapan-de-zaragoza', U&'Universidad Tecnol\00F3gica de M\00E9xico, Campus Atizap\00E1n de Zaragoza', U&'Atizap\00E1n de Zaragoza', U&'Atizap\00E1n de Zaragoza', U&'Estado de M\00E9xico', NULL, NULL, false),
  ('universidad-tecnologica-de-mexico-ciudad-de-mexico', 'universidad-tecnologica-de-mexico', 'ciudad-de-mexico', U&'Universidad Tecnol\00F3gica de M\00E9xico, Campus Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', U&'Ciudad de M\00E9xico', NULL, NULL, false),
  ('universidad-tecnologica-de-mexico-leon', 'universidad-tecnologica-de-mexico', 'leon', U&'Universidad Tecnol\00F3gica de M\00E9xico, Campus Le\00F3n', U&'Le\00F3n', U&'Le\00F3n', 'Guanajuato', NULL, NULL, false),
  ('universidad-tecnologica-de-mexico-san-pedro-tlaquepaque', 'universidad-tecnologica-de-mexico', 'san-pedro-tlaquepaque', U&'Universidad Tecnol\00F3gica de M\00E9xico, Campus San Pedro Tlaquepaque', 'San Pedro Tlaquepaque', 'San Pedro Tlaquepaque', 'Jalisco', NULL, NULL, false),
  ('universidad-tecnologica-de-mexico-queretaro', 'universidad-tecnologica-de-mexico', 'queretaro', U&'Universidad Tecnol\00F3gica de M\00E9xico, Campus Quer\00E9taro', U&'Quer\00E9taro', U&'Quer\00E9taro', U&'Quer\00E9taro', NULL, NULL, false),
  ('universidad-tecnologica-de-nayarit', 'universidad-tecnologica-de-nayarit', 'principal', U&'Universidad Tecnol\00F3gica de Nayarit', NULL, 'Xalisco', 'Nayarit', NULL, NULL, false),
  ('universidad-tecnologica-de-puebla', 'universidad-tecnologica-de-puebla', 'principal', U&'Universidad Tecnol\00F3gica de Puebla', NULL, 'Puebla', 'Puebla', NULL, NULL, false),
  ('universidad-tecnologica-de-queretaro', 'universidad-tecnologica-de-queretaro', 'principal', U&'Universidad Tecnol\00F3gica de Quer\00E9taro', NULL, U&'Quer\00E9taro', U&'Quer\00E9taro', NULL, NULL, false),
  ('universidad-tecnologica-de-tijuana', 'universidad-tecnologica-de-tijuana', 'principal', U&'Universidad Tecnol\00F3gica de Tijuana', NULL, 'Tijuana', 'Baja California', NULL, NULL, false),
  ('universidad-tecnologica-del-centro-de-veracruz', 'universidad-tecnologica-del-centro-de-veracruz', 'principal', U&'Universidad Tecnol\00F3gica del Centro de Veracruz', NULL, U&'Cuitl\00E1huac', 'Veracruz', NULL, NULL, false),
  ('universidad-tecnologica-del-estado-de-zacatecas', 'universidad-tecnologica-del-estado-de-zacatecas', 'principal', U&'Universidad Tecnol\00F3gica del Estado de Zacatecas', NULL, 'Guadalupe', 'Zacatecas', NULL, NULL, false),
  ('universidad-tecnologica-emiliano-zapata-del-estado-de-morelos', 'universidad-tecnologica-emiliano-zapata-del-estado-de-morelos', 'principal', U&'Universidad Tecnol\00F3gica Emiliano Zapata del Estado de Morelos', NULL, 'Emiliano Zapata', 'Morelos', NULL, NULL, false),
  ('universidad-tecnologica-metropolitana', 'universidad-tecnologica-metropolitana', 'principal', U&'Universidad Tecnol\00F3gica Metropolitana', NULL, U&'M\00E9rida', U&'Yucat\00E1n', NULL, NULL, false),
  ('universidad-tecnologica-santa-catarina', 'universidad-tecnologica-santa-catarina', 'principal', U&'Universidad Tecnol\00F3gica Santa Catarina', NULL, 'Santa Catarina', U&'Nuevo Le\00F3n', NULL, NULL, false),
  ('universidad-tecnologica-tula-tepeji', 'universidad-tecnologica-tula-tepeji', 'principal', U&'Universidad Tecnol\00F3gica Tula-Tepeji', NULL, 'Tula de Allende', 'Hidalgo', NULL, NULL, false),
  ('universidad-univer-milenium', 'universidad-univer-milenium', 'principal', 'Universidad Univer Milenium', NULL, 'Toluca', U&'Estado de M\00E9xico', NULL, NULL, false),
  ('universidad-vasco-de-quiroga', 'universidad-vasco-de-quiroga', 'principal', 'Universidad Vasco de Quiroga', NULL, 'Morelia', U&'Michoac\00E1n', NULL, NULL, false),
  ('universidad-veracruzana', 'universidad-veracruzana', 'principal', 'Universidad Veracruzana', NULL, 'Xalapa', 'Veracruz', NULL, NULL, false),
  ('universidad-vizcaya-de-las-americas-merida', 'universidad-vizcaya-de-las-americas', 'merida', U&'Universidad Vizcaya de las Am\00E9ricas, Campus M\00E9rida', U&'M\00E9rida', U&'M\00E9rida', U&'Yucat\00E1n', NULL, NULL, false),
  ('universidad-vizcaya-de-las-americas-hermosillo', 'universidad-vizcaya-de-las-americas', 'hermosillo', U&'Universidad Vizcaya de las Am\00E9ricas, Campus Hermosillo', 'Hermosillo', 'Hermosillo', 'Sonora', NULL, NULL, false),
  ('universidad-vizcaya-de-las-americas-saltillo', 'universidad-vizcaya-de-las-americas', 'saltillo', U&'Universidad Vizcaya de las Am\00E9ricas, Campus Saltillo', 'Saltillo', 'Saltillo', 'Coahuila', NULL, NULL, false),
  ('universidad-vizcaya-de-las-americas-torreon', 'universidad-vizcaya-de-las-americas', 'torreon', U&'Universidad Vizcaya de las Am\00E9ricas, Campus Torre\00F3n', U&'Torre\00F3n', U&'Torre\00F3n', 'Coahuila', NULL, NULL, false),
  ('universidad-vizcaya-de-las-americas-tepic', 'universidad-vizcaya-de-las-americas', 'tepic', U&'Universidad Vizcaya de las Am\00E9ricas, Campus Tepic', 'Tepic', 'Tepic', 'Nayarit', NULL, NULL, false),
  ('universidad-vizcaya-de-las-americas-monclova', 'universidad-vizcaya-de-las-americas', 'monclova', U&'Universidad Vizcaya de las Am\00E9ricas, Campus Monclova', 'Monclova', 'Monclova', 'Coahuila', NULL, NULL, false),
  ('universidad-vizcaya-de-las-americas-campeche', 'universidad-vizcaya-de-las-americas', 'campeche', U&'Universidad Vizcaya de las Am\00E9ricas, Campus Campeche', 'Campeche', 'Campeche', 'Campeche', NULL, NULL, false),
  ('universidad-vizcaya-de-las-americas-ciudad-juarez', 'universidad-vizcaya-de-las-americas', 'ciudad-juarez', U&'Universidad Vizcaya de las Am\00E9ricas, Campus Ciudad Ju\00E1rez', U&'Ciudad Ju\00E1rez', U&'Ju\00E1rez', 'Chihuahua', NULL, NULL, false),
  ('american-river-college', 'american-river-college', 'principal', 'American River College', NULL, 'Sacramento', 'California', 38.65085, -121.349672, false),
  ('anderson-university', 'anderson-university', 'principal', 'Anderson University', NULL, 'Anderson', 'South Carolina', 34.5152, -82.640358, false),
  ('anne-arundel-community-college', 'anne-arundel-community-college', 'principal', 'Anne Arundel Community College', NULL, 'Arnold', 'Maryland', 39.049813, -76.512223, false),
  ('anoka-ramsey-community-college', 'anoka-ramsey-community-college', 'principal', 'Anoka-Ramsey Community College', NULL, 'Coon Rapids', 'Minnesota', 45.172978, -93.351697, false),
  ('arizona-christian-university', 'arizona-christian-university', 'principal', 'Arizona Christian University', NULL, 'Glendale', 'Arizona', 33.622952, -112.181776, false),
  ('arizona-state-university', 'arizona-state-university', 'principal', 'Arizona State University', NULL, 'Tempe', 'Arizona', 33.417721, -111.934383, false),
  ('arkansas-state-university', 'arkansas-state-university', 'principal', 'Arkansas State University', NULL, 'Jonesboro', 'Arkansas', 35.842388, -90.679988, false),
  ('auburn-university', 'auburn-university', 'principal', 'Auburn University', NULL, 'Auburn', 'Alabama', 32.599378, -85.488258, false),
  ('augustana-university', 'augustana-university', 'principal', 'Augustana University', NULL, 'Sioux Falls', 'South Dakota', 43.525148, -96.736975, false),
  ('baker-university', 'baker-university', 'principal', 'Baker University', NULL, 'Baldwin City', 'Kansas', 38.778712, -95.187346, false),
  ('ball-state-university', 'ball-state-university', 'principal', 'Ball State University', NULL, 'Muncie', 'Indiana', 40.203431, -85.409043, false),
  ('bates-technical-college', 'bates-technical-college', 'principal', 'Bates Technical College', NULL, 'Tacoma', 'Washington', 47.251743, -122.44683, false),
  ('baton-rouge-community-college', 'baton-rouge-community-college', 'principal', 'Baton Rouge Community College', NULL, 'Baton Rouge', 'Louisiana', 30.448276, -91.137935, false),
  ('baylor-university', 'baylor-university', 'principal', 'Baylor University', NULL, 'Waco', 'Texas', 31.546872, -97.121041, false),
  ('bellevue-university', 'bellevue-university', 'principal', 'Bellevue University', NULL, 'Bellevue', 'Nebraska', 41.150225, -95.91764, false),
  ('bergen-community-college', 'bergen-community-college', 'principal', 'Bergen Community College', NULL, 'Paramus', 'New Jersey', 40.951782, -74.088804, false),
  ('blue-ridge-community-and-technical-college', 'blue-ridge-community-and-technical-college', 'principal', 'Blue Ridge Community and Technical College', NULL, 'Martinsburg', 'West Virginia', 39.43529, -78.001918, false),
  ('bluegrass-community-and-technical-college', 'bluegrass-community-and-technical-college', 'principal', 'Bluegrass Community and Technical College', NULL, 'Lexington', 'Kentucky', 38.024808, -84.503665, false),
  ('boise-state-university', 'boise-state-university', 'principal', 'Boise State University', NULL, 'Boise', 'Idaho', 43.604284, -116.203301, false),
  ('boston-university', 'boston-university', 'principal', 'Boston University', NULL, 'Boston', 'Massachusetts', 42.351118, -71.107942, false),
  ('brigham-young-university', 'brigham-young-university', 'principal', 'Brigham Young University', NULL, 'Provo', 'Utah', 40.250851, -111.649281, false),
  ('brigham-young-university-hawaii', 'brigham-young-university-hawaii', 'principal', 'Brigham Young University-Hawaii', NULL, 'Laie', 'Hawaii', 21.642074, -157.926586, false),
  ('brigham-young-university-idaho', 'brigham-young-university-idaho', 'principal', 'Brigham Young University-Idaho', NULL, 'Rexburg', 'Idaho', 43.818408, -111.782431, false),
  ('bristol-community-college', 'bristol-community-college', 'principal', 'Bristol Community College', NULL, 'Fall River', 'Massachusetts', 41.721994, -71.119133, false),
  ('brown-university', 'brown-university', 'principal', 'Brown University', NULL, 'Providence', 'Rhode Island', 41.82617, -71.40385, false),
  ('buena-vista-university', 'buena-vista-university', 'principal', 'Buena Vista University', NULL, 'Storm Lake', 'Iowa', 42.642255, -95.208529, false),
  ('carroll-college', 'carroll-college', 'principal', 'Carroll College', NULL, 'Helena', 'Montana', 46.600771, -112.040285, false),
  ('case-western-reserve-university', 'case-western-reserve-university', 'principal', 'Case Western Reserve University', NULL, 'Cleveland', 'Ohio', 41.507419, -81.609596, false),
  ('casper-college', 'casper-college', 'principal', 'Casper College', NULL, 'Casper', 'Wyoming', 42.832788, -106.326712, false),
  ('central-connecticut-state-university', 'central-connecticut-state-university', 'principal', 'Central Connecticut State University', NULL, 'New Britain', 'Connecticut', 41.692502, -72.765991, false),
  ('central-georgia-technical-college', 'central-georgia-technical-college', 'principal', 'Central Georgia Technical College', NULL, 'Warner Robins', 'Georgia', 32.545341, -83.66765, false),
  ('central-new-mexico-community-college', 'central-new-mexico-community-college', 'principal', 'Central New Mexico Community College', NULL, 'Albuquerque', 'New Mexico', 35.071878, -106.628861, false),
  ('central-wyoming-college', 'central-wyoming-college', 'principal', 'Central Wyoming College', NULL, 'Riverton', 'Wyoming', 43.030556, -108.426738, false),
  ('champlain-college', 'champlain-college', 'principal', 'Champlain College', NULL, 'Burlington', 'Vermont', 44.473287, -73.202746, false),
  ('chandler-gilbert-community-college', 'chandler-gilbert-community-college', 'principal', 'Chandler-Gilbert Community College', NULL, 'Chandler', 'Arizona', 33.293897, -111.795922, false),
  ('chattanooga-state-community-college', 'chattanooga-state-community-college', 'principal', 'Chattanooga State Community College', NULL, 'Chattanooga', 'Tennessee', 35.100202, -85.237389, false),
  ('clemson-university', 'clemson-university', 'principal', 'Clemson University', NULL, 'Clemson', 'South Carolina', 34.679381, -82.835114, false),
  ('coastal-alabama-community-college', 'coastal-alabama-community-college', 'principal', 'Coastal Alabama Community College', NULL, 'Bay Minette', 'Alabama', 30.851343, -87.778193, false),
  ('college-of-dupage', 'college-of-dupage', 'principal', 'College of DuPage', NULL, 'Glen Ellyn', 'Illinois', 41.841577, -88.071635, false),
  ('college-of-western-idaho', 'college-of-western-idaho', 'principal', 'College of Western Idaho', NULL, 'Nampa', 'Idaho', 43.614106, -116.507314, false),
  ('colorado-state-university-fort-collins', 'colorado-state-university-fort-collins', 'principal', 'Colorado State University-Fort Collins', NULL, 'Fort Collins', 'Colorado', 40.574805, -105.080732, false),
  ('columbus-state-community-college', 'columbus-state-community-college', 'principal', 'Columbus State Community College', NULL, 'Columbus', 'Ohio', 39.96887, -82.98766, false),
  ('community-college-of-allegheny-county', 'community-college-of-allegheny-county', 'principal', 'Community College of Allegheny County', NULL, 'Pittsburgh', 'Pennsylvania', 40.450908, -80.018453, false),
  ('community-college-of-aurora', 'community-college-of-aurora', 'principal', 'Community College of Aurora', NULL, 'Aurora', 'Colorado', 39.71788, -104.802673, false),
  ('community-college-of-rhode-island', 'community-college-of-rhode-island', 'principal', 'Community College of Rhode Island', NULL, 'Warwick', 'Rhode Island', 41.712817, -71.481509, false),
  ('community-college-of-vermont', 'community-college-of-vermont', 'principal', 'Community College of Vermont', NULL, 'Montpelier', 'Vermont', 44.280811, -72.573774, false),
  ('concordia-university-saint-paul', 'concordia-university-saint-paul', 'principal', 'Concordia University-Saint Paul', NULL, 'Saint Paul', 'Minnesota', 44.949759, -93.154861, false),
  ('connecticut-state-community-college', 'connecticut-state-community-college', 'principal', 'Connecticut State Community College', NULL, 'Hartford', 'Connecticut', 41.768397, -72.672734, false),
  ('cornell-university', 'cornell-university', 'principal', 'Cornell University', NULL, 'Ithaca', 'New York', 42.4472, -76.483084, false),
  ('dakota-college-at-bottineau', 'dakota-college-at-bottineau', 'principal', 'Dakota College at Bottineau', NULL, 'Bottineau', 'North Dakota', 48.832505, -100.441103, false),
  ('delaware-technical-community-college-terry', 'delaware-technical-community-college-terry', 'principal', 'Delaware Technical Community College-Terry', NULL, 'Dover', 'Delaware', 39.198371, -75.56012, false),
  ('des-moines-area-community-college', 'des-moines-area-community-college', 'principal', 'Des Moines Area Community College', NULL, 'Ankeny', 'Iowa', 41.707348, -93.611597, false),
  ('drexel-university', 'drexel-university', 'principal', 'Drexel University', NULL, 'Philadelphia', 'Pennsylvania', 39.955217, -75.190051, false),
  ('duke-university', 'duke-university', 'principal', 'Duke University', NULL, 'Durham', 'North Carolina', 36.001135, -78.937624, false),
  ('el-paso-community-college', 'el-paso-community-college', 'principal', 'El Paso Community College', NULL, 'El Paso', 'Texas', 31.773359, -106.373616, false),
  ('emory-university', 'emory-university', 'principal', 'Emory University', NULL, 'Atlanta', 'Georgia', 33.790183, -84.325512, false),
  ('flathead-valley-community-college', 'flathead-valley-community-college', 'principal', 'Flathead Valley Community College', NULL, 'Kalispell', 'Montana', 48.227389, -114.327258, false),
  ('florida-international-university', 'florida-international-university', 'principal', 'Florida International University', NULL, 'Miami', 'Florida', 25.75732, -80.373928, false),
  ('florida-state', 'florida-state', 'principal', 'Florida State University', NULL, 'Tallahassee', 'Florida', 30.443147, -84.295064, true),
  ('fox-valley-technical-college', 'fox-valley-technical-college', 'principal', 'Fox Valley Technical College', NULL, 'Appleton', 'Wisconsin', 44.283174, -88.45893, false),
  ('george-fox-university', 'george-fox-university', 'principal', 'George Fox University', NULL, 'Newberg', 'Oregon', 45.303629, -122.967494, false),
  ('george-mason-university', 'george-mason-university', 'principal', 'George Mason University', NULL, 'Fairfax', 'Virginia', 38.83195, -77.307063, false),
  ('george-washington-university', 'george-washington-university', 'principal', 'George Washington University', NULL, 'Washington', 'District of Columbia', 38.89923, -77.048363, false),
  ('georgia-institute-of-technology', 'georgia-institute-of-technology', 'principal', 'Georgia Institute of Technology', NULL, 'Atlanta', 'Georgia', 33.77242, -84.394832, false),
  ('gonzaga-university', 'gonzaga-university', 'principal', 'Gonzaga University', NULL, 'Spokane', 'Washington', 47.666531, -117.400625, false),
  ('grand-rapids-community-college', 'grand-rapids-community-college', 'principal', 'Grand Rapids Community College', NULL, 'Grand Rapids', 'Michigan', 42.967076, -85.665625, false),
  ('great-bay-community-college', 'great-bay-community-college', 'principal', 'Great Bay Community College', NULL, 'Portsmouth', 'New Hampshire', 43.072093, -70.798969, false),
  ('harding-university', 'harding-university', 'principal', 'Harding University', NULL, 'Searcy', 'Arkansas', 35.247386, -91.726143, false),
  ('hinds-community-college', 'hinds-community-college', 'principal', 'Hinds Community College', NULL, 'Raymond', 'Mississippi', 32.256109, -90.416118, false),
  ('indiana-university-bloomington', 'indiana-university-bloomington', 'principal', 'Indiana University-Bloomington', NULL, 'Bloomington', 'Indiana', 39.16609, -86.526559, false),
  ('iowa-state-university', 'iowa-state-university', 'principal', 'Iowa State University', NULL, 'Ames', 'Iowa', 42.026212, -93.648504, false),
  ('ivy-tech-community-college', 'ivy-tech-community-college', 'principal', 'Ivy Tech Community College', NULL, 'Indianapolis', 'Indiana', 39.803753, -86.158213, false),
  ('johns-hopkins-university', 'johns-hopkins-university', 'principal', 'Johns Hopkins University', NULL, 'Baltimore', 'Maryland', 39.328977, -76.621595, false),
  ('johnson-county-community-college', 'johnson-county-community-college', 'principal', 'Johnson County Community College', NULL, 'Overland Park', 'Kansas', 38.924125, -94.727798, false),
  ('kansas-state-university', 'kansas-state-university', 'principal', 'Kansas State University', NULL, 'Manhattan', 'Kansas', 39.188648, -96.581077, false),
  ('kapiolani-community-college', 'kapiolani-community-college', 'principal', 'Kapiolani Community College', NULL, 'Honolulu', 'Hawaii', 21.27148, -157.800213, false),
  ('keene-state-college', 'keene-state-college', 'principal', 'Keene State College', NULL, 'Keene', 'New Hampshire', 42.926452, -72.279276, false),
  ('kent-state-university-at-kent', 'kent-state-university-at-kent', 'principal', 'Kent State University at Kent', NULL, 'Kent', 'Ohio', 41.146653, -81.342533, false),
  ('lake-area-technical-college', 'lake-area-technical-college', 'principal', 'Lake Area Technical College', NULL, 'Watertown', 'South Dakota', 44.901714, -97.095229, false),
  ('liberty-university', 'liberty-university', 'principal', 'Liberty University', NULL, 'Lynchburg', 'Virginia', 37.350232, -79.18222, false),
  ('louisiana-state-university-and-agricultural-mechanical-college', 'louisiana-state-university-and-agricultural-mechanical-college', 'principal', 'Louisiana State University and Agricultural & Mechanical College', NULL, 'Baton Rouge', 'Louisiana', 30.414986, -91.178921, false),
  ('marquette-university', 'marquette-university', 'principal', 'Marquette University', NULL, 'Milwaukee', 'Wisconsin', 43.03903, -87.927961, false),
  ('marshall-university', 'marshall-university', 'principal', 'Marshall University', NULL, 'Huntington', 'West Virginia', 38.422482, -82.428964, false),
  ('metropolitan-community-college-area', 'metropolitan-community-college-area', 'principal', 'Metropolitan Community College Area', NULL, 'Omaha', 'Nebraska', 41.310451, -95.957829, false),
  ('metropolitan-community-college-kansas-city', 'metropolitan-community-college-kansas-city', 'principal', 'Metropolitan Community College-Kansas City', NULL, 'Kansas City', 'Missouri', 39.068668, -94.58966, false),
  ('michigan-state-university', 'michigan-state-university', 'principal', 'Michigan State University', NULL, 'East Lansing', 'Michigan', 42.73212, -84.476111, false),
  ('minnesota-state-university-mankato', 'minnesota-state-university-mankato', 'principal', 'Minnesota State University-Mankato', NULL, 'Mankato', 'Minnesota', 44.146712, -93.99945, false),
  ('mississippi-state-university', 'mississippi-state-university', 'principal', 'Mississippi State University', NULL, 'Mississippi State', 'Mississippi', 33.454852, -88.790139, false),
  ('missouri-state-university-springfield', 'missouri-state-university-springfield', 'principal', 'Missouri State University-Springfield', NULL, 'Springfield', 'Missouri', 37.199258, -93.281281, false),
  ('montana-state-university', 'montana-state-university', 'principal', 'Montana State University', NULL, 'Bozeman', 'Montana', 45.666726, -111.048812, false),
  ('montclair-state-university', 'montclair-state-university', 'principal', 'Montclair State University', NULL, 'Montclair', 'New Jersey', 40.860414, -74.198141, false),
  ('new-mexico-state-university', 'new-mexico-state-university', 'principal', 'New Mexico State University', NULL, 'Las Cruces', 'New Mexico', 32.281568, -106.752069, false),
  ('north-carolina-state-university-at-raleigh', 'north-carolina-state-university-at-raleigh', 'principal', 'North Carolina State University at Raleigh', NULL, 'Raleigh', 'North Carolina', 35.785111, -78.674517, false),
  ('north-dakota-state-university', 'north-dakota-state-university', 'principal', 'North Dakota State University', NULL, 'Fargo', 'North Dakota', 46.893127, -96.800838, false),
  ('northern-virginia-community-college', 'northern-virginia-community-college', 'principal', 'Northern Virginia Community College', NULL, 'Annandale', 'Virginia', 38.833361, -77.236718, false),
  ('northwest-arkansas-community-college', 'northwest-arkansas-community-college', 'principal', 'NorthWest Arkansas Community College', NULL, 'Bentonville', 'Arkansas', 36.357704, -94.17289, false),
  ('northwestern-university', 'northwestern-university', 'principal', 'Northwestern University', NULL, 'Evanston', 'Illinois', 42.050356, -87.679858, false),
  ('nova-southeastern-university', 'nova-southeastern-university', 'principal', 'Nova Southeastern University', NULL, 'Fort Lauderdale', 'Florida', 26.082288, -80.249891, false),
  ('ohio-state-university', 'ohio-state-university', 'principal', 'Ohio State University', NULL, 'Columbus', 'Ohio', 39.999803, -83.007525, false),
  ('oklahoma-city-community-college', 'oklahoma-city-community-college', 'principal', 'Oklahoma City Community College', NULL, 'Oklahoma City', 'Oklahoma', 35.387699, -97.570109, false),
  ('oklahoma-state-university', 'oklahoma-state-university', 'principal', 'Oklahoma State University', NULL, 'Stillwater', 'Oklahoma', 36.123085, -97.069743, false),
  ('oral-roberts-university', 'oral-roberts-university', 'principal', 'Oral Roberts University', NULL, 'Tulsa', 'Oklahoma', 36.049129, -95.952547, false),
  ('oregon-state-university', 'oregon-state-university', 'principal', 'Oregon State University', NULL, 'Corvallis', 'Oregon', 44.56395, -123.274723, false),
  ('pennsylvania-state-university', 'pennsylvania-state-university', 'principal', 'Pennsylvania State University', NULL, 'University Park', 'Pennsylvania', 40.7965, -77.862848, false),
  ('portland-community-college', 'portland-community-college', 'principal', 'Portland Community College', NULL, 'Portland', 'Oregon', 45.438154, -122.730876, false),
  ('princeton-university', 'princeton-university', 'principal', 'Princeton University', NULL, 'Princeton', 'New Jersey', 40.348732, -74.659365, false),
  ('purdue', 'purdue', 'principal', 'Purdue University', NULL, 'West Lafayette', 'Indiana', 40.428206, -86.914435, true),
  ('rhode-island-college', 'rhode-island-college', 'principal', 'Rhode Island College', NULL, 'Providence', 'Rhode Island', 41.842415, -71.46556, false),
  ('roseman-university-of-health-sciences', 'roseman-university-of-health-sciences', 'principal', 'Roseman University of Health Sciences', NULL, 'Henderson', 'Nevada', 36.073182, -115.064633, false),
  ('rutgers-university-new-brunswick', 'rutgers-university-new-brunswick', 'principal', 'Rutgers University-New Brunswick', NULL, 'New Brunswick', 'New Jersey', 40.498769, -74.446251, false),
  ('salt-lake-community-college', 'salt-lake-community-college', 'principal', 'Salt Lake Community College', NULL, 'Salt Lake City', 'Utah', 40.671575, -111.942809, false),
  ('samford-university', 'samford-university', 'principal', 'Samford University', NULL, 'Birmingham', 'Alabama', 33.464128, -86.791799, false),
  ('south-dakota-state-university', 'south-dakota-state-university', 'principal', 'South Dakota State University', NULL, 'Brookings', 'South Dakota', 44.317485, -96.782139, false),
  ('southern-maine-community-college', 'southern-maine-community-college', 'principal', 'Southern Maine Community College', NULL, 'South Portland', 'Maine', 43.646649, -70.229182, false),
  ('southern-new-hampshire-university', 'southern-new-hampshire-university', 'principal', 'Southern New Hampshire University', NULL, 'Manchester', 'New Hampshire', 43.038922, -71.451842, false),
  ('stony-brook-university', 'stony-brook-university', 'principal', 'Stony Brook University', NULL, 'Stony Brook', 'New York', 40.91476, -73.12046, false),
  ('suffolk-county-community-college', 'suffolk-county-community-college', 'principal', 'Suffolk County Community College', NULL, 'Selden', 'New York', 40.848963, -73.056165, false),
  ('temple-university', 'temple-university', 'principal', 'Temple University', NULL, 'Philadelphia', 'Pennsylvania', 39.980546, -75.156859, false),
  ('texas-a-m-university-college-station', 'texas-a-m-university-college-station', 'principal', 'Texas A&M University-College Station', NULL, 'College Station', 'Texas', 30.618726, -96.336475, false),
  ('texas-tech-university', 'texas-tech-university', 'principal', 'Texas Tech University', NULL, 'Lubbock', 'Texas', 33.583448, -101.874783, false),
  ('the-university-of-alabama', 'the-university-of-alabama', 'principal', 'The University of Alabama', NULL, 'Tuscaloosa', 'Alabama', 33.211875, -87.545978, false),
  ('the-university-of-montana', 'the-university-of-montana', 'principal', 'The University of Montana', NULL, 'Missoula', 'Montana', 46.859312, -113.982912, false),
  ('the-university-of-tennessee-knoxville', 'the-university-of-tennessee-knoxville', 'principal', 'The University of Tennessee-Knoxville', NULL, 'Knoxville', 'Tennessee', 35.952082, -83.925852, false),
  ('trident-technical-college', 'trident-technical-college', 'principal', 'Trident Technical College', NULL, 'Charleston', 'South Carolina', 32.928767, -80.031276, false),
  ('tulane-university-of-louisiana', 'tulane-university-of-louisiana', 'principal', 'Tulane University of Louisiana', NULL, 'New Orleans', 'Louisiana', 29.940069, -90.122144, false),
  ('university-at-buffalo', 'university-at-buffalo', 'principal', 'University at Buffalo', NULL, 'Buffalo', 'New York', 43.000942, -78.789458, false),
  ('university-of-alaska-anchorage', 'university-of-alaska-anchorage', 'principal', 'University of Alaska Anchorage', NULL, 'Anchorage', 'Alaska', 61.190163, -149.82619, false),
  ('university-of-alaska-fairbanks', 'university-of-alaska-fairbanks', 'principal', 'University of Alaska Fairbanks', NULL, 'Fairbanks', 'Alaska', 64.85756, -147.823146, false),
  ('university-of-arizona', 'university-of-arizona', 'principal', 'University of Arizona', NULL, 'Tucson', 'Arizona', 32.232672, -110.950815, false),
  ('university-of-arkansas', 'university-of-arkansas', 'principal', 'University of Arkansas', NULL, 'Fayetteville', 'Arkansas', 36.070009, -94.176981, false),
  ('university-of-california-berkeley', 'university-of-california-berkeley', 'principal', 'University of California-Berkeley', NULL, 'Berkeley', 'California', 37.871918, -122.260463, false),
  ('university-of-california-davis', 'university-of-california-davis', 'principal', 'University of California-Davis', NULL, 'Davis', 'California', 38.539667, -121.749567, false),
  ('university-of-charleston', 'university-of-charleston', 'principal', 'University of Charleston', NULL, 'Charleston', 'West Virginia', 38.333367, -81.616244, false),
  ('university-of-colorado-boulder', 'university-of-colorado-boulder', 'principal', 'University of Colorado Boulder', NULL, 'Boulder', 'Colorado', 40.008781, -105.270823, false),
  ('university-of-connecticut', 'university-of-connecticut', 'principal', 'University of Connecticut', NULL, 'Storrs', 'Connecticut', 41.809098, -72.249948, false),
  ('university-of-delaware', 'university-of-delaware', 'principal', 'University of Delaware', NULL, 'Newark', 'Delaware', 39.679577, -75.752822, false),
  ('university-of-denver', 'university-of-denver', 'principal', 'University of Denver', NULL, 'Denver', 'Colorado', 39.678005, -104.963259, false),
  ('university-of-detroit-mercy', 'university-of-detroit-mercy', 'principal', 'University of Detroit Mercy', NULL, 'Detroit', 'Michigan', 42.414222, -83.139158, false),
  ('university-of-florida', 'university-of-florida', 'principal', 'University of Florida', NULL, 'Gainesville', 'Florida', 29.64629, -82.347911, false),
  ('university-of-georgia', 'university-of-georgia', 'principal', 'University of Georgia', NULL, 'Athens', 'Georgia', 33.956262, -83.374039, false),
  ('university-of-hawaii-at-hilo', 'university-of-hawaii-at-hilo', 'principal', 'University of Hawaii at Hilo', NULL, 'Hilo', 'Hawaii', 19.701189, -155.080847, false),
  ('university-of-hawaii-at-manoa', 'university-of-hawaii-at-manoa', 'principal', 'University of Hawaii at Manoa', NULL, 'Honolulu', 'Hawaii', 21.298598, -157.818979, false),
  ('university-of-idaho', 'university-of-idaho', 'principal', 'University of Idaho', NULL, 'Moscow', 'Idaho', 46.727406, -117.014167, false),
  ('university-of-illinois-chicago', 'university-of-illinois-chicago', 'principal', 'University of Illinois Chicago', NULL, 'Chicago', 'Illinois', 41.871837, -87.650503, false),
  ('university-of-illinois-urbana-champaign', 'university-of-illinois-urbana-champaign', 'principal', 'University of Illinois Urbana-Champaign', NULL, 'Champaign', 'Illinois', 40.104718, -88.229114, false),
  ('university-of-iowa', 'university-of-iowa', 'principal', 'University of Iowa', NULL, 'Iowa City', 'Iowa', 41.661935, -91.536425, false),
  ('university-of-jamestown', 'university-of-jamestown', 'principal', 'University of Jamestown', NULL, 'Jamestown', 'North Dakota', 46.914302, -98.698416, false),
  ('university-of-kansas', 'university-of-kansas', 'principal', 'University of Kansas', NULL, 'Lawrence', 'Kansas', 38.958549, -95.247567, false),
  ('university-of-kentucky', 'university-of-kentucky', 'principal', 'University of Kentucky', NULL, 'Lexington', 'Kentucky', 38.038911, -84.504747, false),
  ('university-of-louisiana-at-lafayette', 'university-of-louisiana-at-lafayette', 'principal', 'University of Louisiana at Lafayette', NULL, 'Lafayette', 'Louisiana', 30.212191, -92.020165, false),
  ('university-of-louisville', 'university-of-louisville', 'principal', 'University of Louisville', NULL, 'Louisville', 'Kentucky', 38.216862, -85.760412, false),
  ('university-of-maine', 'university-of-maine', 'principal', 'University of Maine', NULL, 'Orono', 'Maine', 44.899257, -68.669332, false),
  ('university-of-maryland-global-campus', 'university-of-maryland-global-campus', 'principal', 'University of Maryland Global Campus', NULL, 'Adelphi', 'Maryland', 38.912706, -76.847584, false),
  ('university-of-maryland-college-park', 'university-of-maryland-college-park', 'principal', 'University of Maryland-College Park', NULL, 'College Park', 'Maryland', 38.988178, -76.944721, false),
  ('university-of-massachusetts-amherst', 'university-of-massachusetts-amherst', 'principal', 'University of Massachusetts-Amherst', NULL, 'Amherst', 'Massachusetts', 42.385999, -72.526728, false),
  ('university-of-massachusetts-boston', 'university-of-massachusetts-boston', 'principal', 'University of Massachusetts-Boston', NULL, 'Boston', 'Massachusetts', 42.312881, -71.036865, false),
  ('university-of-memphis', 'university-of-memphis', 'principal', 'University of Memphis', NULL, 'Memphis', 'Tennessee', 35.118878, -89.938068, false),
  ('university-of-michigan-ann-arbor', 'university-of-michigan-ann-arbor', 'principal', 'University of Michigan-Ann Arbor', NULL, 'Ann Arbor', 'Michigan', 42.278374, -83.73481, false),
  ('university-of-minnesota-twin-cities', 'university-of-minnesota-twin-cities', 'principal', 'University of Minnesota-Twin Cities', NULL, 'Minneapolis', 'Minnesota', 44.972851, -93.235464, false),
  ('university-of-mississippi', 'university-of-mississippi', 'principal', 'University of Mississippi', NULL, 'University', 'Mississippi', 34.365529, -89.537434, false),
  ('university-of-missouri-columbia', 'university-of-missouri-columbia', 'principal', 'University of Missouri-Columbia', NULL, 'Columbia', 'Missouri', 38.94531, -92.328843, false),
  ('university-of-nebraska-at-omaha', 'university-of-nebraska-at-omaha', 'principal', 'University of Nebraska at Omaha', NULL, 'Omaha', 'Nebraska', 41.258769, -96.008516, false),
  ('university-of-nebraska-lincoln', 'university-of-nebraska-lincoln', 'principal', 'University of Nebraska-Lincoln', NULL, 'Lincoln', 'Nebraska', 40.817598, -96.700508, false),
  ('university-of-nevada-las-vegas', 'university-of-nevada-las-vegas', 'principal', 'University of Nevada-Las Vegas', NULL, 'Las Vegas', 'Nevada', 36.106047, -115.138462, false),
  ('university-of-nevada-reno', 'university-of-nevada-reno', 'principal', 'University of Nevada-Reno', NULL, 'Reno', 'Nevada', 39.543642, -119.815377, false),
  ('university-of-new-england', 'university-of-new-england', 'principal', 'University of New England', NULL, 'Biddeford', 'Maine', 43.458591, -70.38535, false),
  ('university-of-new-hampshire', 'university-of-new-hampshire', 'principal', 'University of New Hampshire', NULL, 'Durham', 'New Hampshire', 43.135934, -70.932465, false),
  ('university-of-new-mexico', 'university-of-new-mexico', 'principal', 'University of New Mexico', NULL, 'Albuquerque', 'New Mexico', 35.083868, -106.620155, false),
  ('university-of-north-carolina-at-chapel-hill', 'university-of-north-carolina-at-chapel-hill', 'principal', 'University of North Carolina at Chapel Hill', NULL, 'Chapel Hill', 'North Carolina', 35.911769, -79.050969, false),
  ('university-of-north-dakota', 'university-of-north-dakota', 'principal', 'University of North Dakota', NULL, 'Grand Forks', 'North Dakota', 47.921654, -97.071738, false),
  ('university-of-notre-dame', 'university-of-notre-dame', 'principal', 'University of Notre Dame', NULL, 'Notre Dame', 'Indiana', 41.703058, -86.238959, false),
  ('university-of-oklahoma', 'university-of-oklahoma', 'principal', 'University of Oklahoma', NULL, 'Norman', 'Oklahoma', 35.209407, -97.444211, false),
  ('university-of-oregon', 'university-of-oregon', 'principal', 'University of Oregon', NULL, 'Eugene', 'Oregon', 44.045146, -123.075792, false),
  ('university-of-rhode-island', 'university-of-rhode-island', 'principal', 'University of Rhode Island', NULL, 'Kingston', 'Rhode Island', 41.484691, -71.527356, false),
  ('university-of-south-carolina-columbia', 'university-of-south-carolina-columbia', 'principal', 'University of South Carolina-Columbia', NULL, 'Columbia', 'South Carolina', 33.996788, -81.026935, false),
  ('university-of-south-dakota', 'university-of-south-dakota', 'principal', 'University of South Dakota', NULL, 'Vermillion', 'South Dakota', 42.786019, -96.925283, false),
  ('university-of-southern-california', 'university-of-southern-california', 'principal', 'University of Southern California', NULL, 'Los Angeles', 'California', 34.021281, -118.284169, false),
  ('university-of-southern-maine', 'university-of-southern-maine', 'principal', 'University of Southern Maine', NULL, 'Portland', 'Maine', 43.662863, -70.274247, false),
  ('university-of-the-cumberlands', 'university-of-the-cumberlands', 'principal', 'University of the Cumberlands', NULL, 'Williamsburg', 'Kentucky', 36.737048, -84.161646, false),
  ('university-of-the-district-of-columbia', 'university-of-the-district-of-columbia', 'principal', 'University of the District of Columbia', NULL, 'Washington', 'District of Columbia', 38.943819, -77.066247, false),
  ('university-of-the-southwest', 'university-of-the-southwest', 'principal', 'University of the Southwest', NULL, 'Hobbs', 'New Mexico', 32.775496, -103.186948, false),
  ('university-of-utah', 'university-of-utah', 'principal', 'University of Utah', NULL, 'Salt Lake City', 'Utah', 40.762484, -111.846044, false),
  ('university-of-vermont', 'university-of-vermont', 'principal', 'University of Vermont', NULL, 'Burlington', 'Vermont', 44.477325, -73.196646, false),
  ('university-of-washington', 'university-of-washington', 'principal', 'University of Washington', NULL, 'Seattle', 'Washington', 47.65538, -122.30514, false),
  ('university-of-wisconsin-madison', 'university-of-wisconsin-madison', 'principal', 'University of Wisconsin-Madison', NULL, 'Madison', 'Wisconsin', 43.075409, -89.404098, false),
  ('university-of-wisconsin-milwaukee', 'university-of-wisconsin-milwaukee', 'principal', 'University of Wisconsin-Milwaukee', NULL, 'Milwaukee', 'Wisconsin', 43.076848, -87.880488, false),
  ('university-of-wyoming', 'university-of-wyoming', 'principal', 'University of Wyoming', NULL, 'Laramie', 'Wyoming', 41.311773, -105.57931, false),
  ('utah-state-university', 'utah-state-university', 'principal', 'Utah State University', NULL, 'Logan', 'Utah', 41.740748, -111.81391, false),
  ('vanderbilt-university', 'vanderbilt-university', 'principal', 'Vanderbilt University', NULL, 'Nashville', 'Tennessee', 36.14659, -86.803369, false),
  ('vermont-state-university', 'vermont-state-university', 'principal', 'Vermont State University', NULL, 'Randolph', 'Vermont', 43.939623, -72.604498, false),
  ('virginia-polytechnic-institute-and-state-university', 'virginia-polytechnic-institute-and-state-university', 'principal', 'Virginia Polytechnic Institute and State University', NULL, 'Blacksburg', 'Virginia', 37.229012, -80.423675, false),
  ('wake-technical-community-college', 'wake-technical-community-college', 'principal', 'Wake Technical Community College', NULL, 'Raleigh', 'North Carolina', 35.650151, -78.706126, false),
  ('washington-state-university', 'washington-state-university', 'principal', 'Washington State University', NULL, 'Pullman', 'Washington', 46.730448, -117.158168, false),
  ('washington-university-in-st-louis', 'washington-university-in-st-louis', 'principal', 'Washington University in St Louis', NULL, 'Saint Louis', 'Missouri', 38.647929, -90.310604, false),
  ('west-virginia-university', 'west-virginia-university', 'principal', 'West Virginia University', NULL, 'Morgantown', 'West Virginia', 39.634371, -79.954391, false),
  ('william-carey-university', 'william-carey-university', 'principal', 'William Carey University', NULL, 'Hattiesburg', 'Mississippi', 31.305264, -89.291815, false),
  ('wilmington-university', 'wilmington-university', 'principal', 'Wilmington University', NULL, 'New Castle', 'Delaware', 39.682299, -75.586998, false),
  ('yale-university', 'yale-university', 'principal', 'Yale University', NULL, 'New Haven', 'Connecticut', 41.311158, -72.926688, false);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM _c JOIN public.institutions i USING (slug) JOIN public.universities u ON u.slug = _c.university_slug
    WHERE i.university_id IS NOT NULL AND i.university_id <> u.id
  ) THEN
    RAISE EXCEPTION 'CAMPUS_REPARENT';
  END IF;
END $$;

WITH upd AS (
  UPDATE public.institutions i SET
    university_id = u.id,
    campus_slug   = coalesce(i.campus_slug, s.campus_slug),
    name          = CASE WHEN s.preserve THEN i.name ELSE s.name END,
    campus_name   = CASE WHEN s.preserve THEN coalesce(i.campus_name, s.campus_name) ELSE s.campus_name END,
    city          = coalesce(i.city, s.city),
    state_region  = coalesce(i.state_region, s.state_region),
    lat           = coalesce(i.lat, s.lat),
    lng           = coalesce(i.lng, s.lng)
  FROM _c s JOIN public.universities u ON u.slug = s.university_slug
  WHERE i.slug = s.slug
    AND (i.university_id, i.campus_slug, i.name, i.campus_name, i.city, i.state_region, i.lat, i.lng)
        IS DISTINCT FROM
        (u.id, coalesce(i.campus_slug, s.campus_slug), CASE WHEN s.preserve THEN i.name ELSE s.name END,
         CASE WHEN s.preserve THEN coalesce(i.campus_name, s.campus_name) ELSE s.campus_name END,
         coalesce(i.city, s.city), coalesce(i.state_region, s.state_region), coalesce(i.lat, s.lat), coalesce(i.lng, s.lng))
  RETURNING 1
) INSERT INTO _report SELECT 'campuses', 'updated', count(*) FROM upd;

WITH ins AS (
  INSERT INTO public.institutions (slug, name, university_id, campus_slug, campus_name, city, state_region, lat, lng, email_domains, is_active)
  SELECT s.slug, s.name, u.id, s.campus_slug, s.campus_name, s.city, s.state_region, s.lat, s.lng, '{}', true
  FROM _c s JOIN public.universities u ON u.slug = s.university_slug
  WHERE NOT EXISTS (SELECT 1 FROM public.institutions i WHERE i.slug = s.slug)
  RETURNING 1
) INSERT INTO _report SELECT 'campuses', 'inserted', count(*) FROM ins;

-- 4. Dominios de correo (con evidencia)
CREATE TEMP TABLE _d (domain text, university_slug text, campus_slug text, audience text, confidence text,
  verification_enabled boolean, official_source_url text, source_title text, last_verified_at date, notes text,
  is_active boolean, student_id_pattern text) ON COMMIT DROP;
INSERT INTO _d VALUES
  ('fsu.edu', 'florida-state', NULL, 'all_affiliates', 'confirmed', true, 'https://announcements.fsu.edu/article/student-email-upgrades-fsuedu-accounts-may-4', 'Student email upgrades to @fsu.edu accounts May 4', '2026-09-14', 'Estudiantes migrados a FSUID@fsu.edu, mismo sistema que personal. Prueba afiliacion vigente, no distingue estudiante de personal.', true, NULL),
  ('my.fsu.edu', 'florida-state', NULL, 'unknown', 'confirmed', false, 'https://its.fsu.edu/about-its/news/student-email-upgrade-complete', 'Student email upgrade complete', '2026-09-14', 'Dominio antiguo de estudiantes; buzones cerrados el 4 de mayo de 2022. No verifica.', false, NULL),
  ('purdue.edu', 'purdue', NULL, 'all_affiliates', 'confirmed', true, 'https://it.purdue.edu/services/email.php', 'Email | Purdue University IT', '2026-09-14', 'Se entrega a quienes mantienen afiliacion con Purdue. Prueba afiliacion, no necesariamente estudiante.', true, NULL),
  ('tec.mx', 'tec', NULL, 'all_affiliates', 'confirmed', true, 'https://conecta.tec.mx/es/noticias/nacional/educacion/eres-del-tec-siguen-gratis-cursos-de-coursera-y-se-suman-los-de-edx', U&'\00BFEres del Tec? Siguen gratis cursos de Coursera y se suman los de edX (Conecta Tec, 2021-03-23)', '2026-09-14', 'Pagina oficial del Tec: estudiantes, profesores y colaboradores necesitan correo @tec.mx (o @tecsalud.mx, @itesm.mx); los EXATEC quedan fuera. Prueba afiliacion vigente, no distingue estudiante de personal. Tambien https://profesorescatedra.tec.mx/en/configure-email-and-access para profesores. Habilitado el 2026-09-14 a peticion del propietario; evidencia de 2021, revisar si aparece una fuente mas reciente.', true, '^a0[0-9]{7}$'),
  ('exatec.tec.mx', 'tec', NULL, 'alumni', 'confirmed', false, 'https://tec.mx/es/exatec/cuenta-de-acceso-mitec-egresados', 'Cuenta de acceso a mitec egresados', '2026-09-14', 'Cuenta de egresados. Nunca verifica matricula vigente.', true, NULL),
  ('exatec.mx', 'tec', NULL, 'unknown', 'unconfirmed', false, NULL, NULL, '2026-09-14', 'Heredado del catalogo anterior sin evidencia. No verifica.', true, NULL),
  ('itesm.mx', 'tec', NULL, 'unknown', 'unconfirmed', false, NULL, NULL, '2026-09-14', 'Solo aparece en servidores y buzones de departamentos. No verifica.', true, NULL),
  ('u.icesi.edu.co', 'icesi', NULL, 'unknown', 'confirmed', false, 'https://www.icesi.edu.co/servicios/syri/ccc/correo-electronico-academico/', 'Correo electronico academico - Servicios', '2026-09-14', 'Correo academico para estudiantes activos, egresados y profesores hora catedra. Incluye egresados: no prueba matricula vigente. Desactivado.', true, NULL),
  ('icesi.edu.co', 'icesi', NULL, 'faculty_staff', 'confirmed', false, 'https://www.icesi.edu.co/servicios/syri/ccc/correo-colaboradores/', 'Correo electronico colaboradores', '2026-09-14', 'Personal y profesores de planta. No verifica estudiantes.', true, NULL),
  ('javeriana.edu.co', 'javeriana', NULL, 'unknown', 'probable', false, NULL, NULL, '2026-09-14', 'Indicios de uso por estudiantes, pero ninguna pagina oficial legible lo declara. La sede Cali usa javerianacali.edu.co. Desactivado.', true, NULL),
  ('comunidad.unam.mx', 'unam', NULL, 'all_affiliates', 'confirmed', true, 'https://www.tic.unam.mx/servicios-de-tic/correo-electronico-institucional/', 'Correo electronico institucional - Portal TIC UNAM', '2026-09-14', 'Lo solicitan estudiantes y personal activos.', true, NULL),
  ('unam.mx', 'unam', NULL, 'faculty_staff', 'confirmed', false, 'https://www.tic.unam.mx/servicios-de-tic/correo-electronico-institucional/', 'Correo electronico institucional - Portal TIC UNAM', '2026-09-14', 'Solo responsables de TIC de dependencias. No es de estudiantes.', true, NULL),
  ('alumnos.udg.mx', 'udg', NULL, 'student', 'confirmed', true, 'https://cgta.udg.mx/correo-institucional', 'Correo institucional | Coordinacion General de Tecnologias de la Administracion', '2026-09-14', 'Cuenta Google Workspace for Education para estudiantes.', true, NULL),
  ('udg.mx', 'udg', NULL, 'unknown', 'unconfirmed', false, NULL, NULL, '2026-09-14', 'Heredado del catalogo anterior sin evidencia de audiencia. No verifica.', true, NULL),
  ('uanl.edu.mx', 'uanl', NULL, 'all_affiliates', 'confirmed', true, 'https://dti.uanl.mx/correo-universitario/', 'Correo Universitario - Direccion de Tecnologias y Desarrollo Digital UANL', '2026-09-14', 'Exclusivo para estudiantes, profesores e investigadores activos.', true, NULL),
  ('alumno.ipn.mx', 'ipn', NULL, 'student', 'probable', false, 'https://www.ipn.mx/cenac/centro-de-atencion/preguntas-frecuentes.html', 'Preguntas frecuentes de los servicios TIC | IPN Oficial', '2026-09-14', 'Se mencionan tipos de cuenta @alumno, pero ninguna pagina legible lo liga explicitamente a estudiantes. Desactivado.', true, NULL),
  ('ipn.mx', 'ipn', NULL, 'faculty_staff', 'probable', false, NULL, NULL, '2026-09-14', 'Por implicacion, personal y dependencias. No verifica.', true, NULL),
  ('uniandes.edu.co', 'universidad-de-los-andes', NULL, 'unknown', 'confirmed', false, 'https://tecnologia.uniandes.edu.co/terminos-y-condiciones-uso-de-cuentas-uniandes/', 'Terminos y condiciones - Uso de Cuentas Uniandes', '2026-09-14', 'Cuentas para estudiantes, profesores, administrativos y egresados. Incluye egresados: no prueba vinculo vigente. Desactivado.', true, NULL),
  ('unal.edu.co', 'universidad-nacional-de-colombia', NULL, 'unknown', 'probable', false, NULL, NULL, '2026-09-14', 'Paginas oficiales no accesibles; indicios de que incluye egresados. Desactivado.', true, NULL),
  ('udea.edu.co', 'universidad-de-antioquia', NULL, 'unknown', 'probable', false, NULL, NULL, '2026-09-14', 'Paginas oficiales devolvieron 403; indicios de que los egresados conservan la cuenta. Desactivado.', true, NULL),
  ('buap.mx', 'buap', NULL, 'unknown', 'unconfirmed', false, NULL, NULL, '2026-09-14', 'Heredado del catalogo anterior (20260830) sin evidencia. No verifica.', true, NULL),
  ('alumno.buap.mx', 'buap', NULL, 'unknown', 'unconfirmed', false, NULL, NULL, '2026-09-14', 'Heredado del catalogo anterior (20260830) sin evidencia. No verifica.', true, NULL),
  ('udlap.mx', 'udlap', NULL, 'unknown', 'unconfirmed', false, NULL, NULL, '2026-09-14', 'Heredado del catalogo anterior (20260830) sin evidencia. No verifica.', true, NULL),
  ('ibero.mx', 'ibero', NULL, 'unknown', 'unconfirmed', false, NULL, NULL, '2026-09-14', 'Heredado del catalogo anterior (20260830) sin evidencia. No verifica.', true, NULL),
  ('anahuac.mx', 'anahuac', NULL, 'unknown', 'unconfirmed', false, NULL, NULL, '2026-09-14', 'Heredado del catalogo anterior (20260830) sin evidencia. No verifica.', true, NULL),
  ('uaslp.mx', 'uaslp', NULL, 'unknown', 'unconfirmed', false, NULL, NULL, '2026-09-14', 'Heredado del catalogo anterior (20260830) sin evidencia. No verifica.', true, NULL),
  ('uaemex.mx', 'uaemex', NULL, 'unknown', 'unconfirmed', false, NULL, NULL, '2026-09-14', 'Heredado del catalogo anterior (20260830) sin evidencia. No verifica.', true, NULL),
  ('colmex.mx', 'colmex', NULL, 'unknown', 'unconfirmed', false, NULL, NULL, '2026-09-14', 'Heredado del catalogo anterior (20260830) sin evidencia. No verifica.', true, NULL),
  ('cide.edu', 'cide', NULL, 'unknown', 'unconfirmed', false, NULL, NULL, '2026-09-14', 'Heredado del catalogo anterior (20260830) sin evidencia. No verifica.', true, NULL),
  ('uam.mx', 'uam', NULL, 'unknown', 'unconfirmed', false, NULL, NULL, '2026-09-14', 'Heredado del catalogo anterior (20260830) sin evidencia. No verifica.', true, NULL),
  ('uaq.mx', 'uaq', NULL, 'unknown', 'unconfirmed', false, NULL, NULL, '2026-09-14', 'Heredado del catalogo anterior (20260830) sin evidencia. No verifica.', true, NULL),
  ('itam.mx', 'itam', NULL, 'unknown', 'unconfirmed', false, NULL, NULL, '2026-09-14', 'Heredado del catalogo anterior (20260830) sin evidencia. No verifica.', true, NULL),
  ('up.edu.mx', 'up', NULL, 'unknown', 'unconfirmed', false, NULL, NULL, '2026-09-14', 'Heredado del catalogo anterior (20260830) sin evidencia. No verifica.', true, NULL);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM _d JOIN public.institution_email_domains d USING (domain) JOIN public.universities u ON u.slug = _d.university_slug
             WHERE d.university_id <> u.id) THEN
    RAISE EXCEPTION 'DOMAIN_REPARENT';
  END IF;
END $$;

WITH up AS (
  INSERT INTO public.institution_email_domains (domain, university_id, campus_id, audience, confidence, verification_enabled,
    official_source_url, source_title, last_verified_at, notes, is_active, student_id_pattern)
  SELECT s.domain, u.id, c.id, s.audience, s.confidence, s.verification_enabled, s.official_source_url, s.source_title,
    s.last_verified_at, s.notes, s.is_active, s.student_id_pattern
  FROM _d s JOIN public.universities u ON u.slug = s.university_slug
  LEFT JOIN public.institutions c ON c.slug = s.campus_slug
  ON CONFLICT (domain) DO UPDATE SET
    campus_id = EXCLUDED.campus_id, audience = EXCLUDED.audience, confidence = EXCLUDED.confidence,
    verification_enabled = EXCLUDED.verification_enabled, official_source_url = EXCLUDED.official_source_url,
    source_title = EXCLUDED.source_title, last_verified_at = EXCLUDED.last_verified_at, notes = EXCLUDED.notes,
    is_active = EXCLUDED.is_active, student_id_pattern = EXCLUDED.student_id_pattern
  WHERE (institution_email_domains.campus_id, institution_email_domains.audience, institution_email_domains.confidence,
         institution_email_domains.verification_enabled, institution_email_domains.official_source_url,
         institution_email_domains.is_active, institution_email_domains.student_id_pattern, institution_email_domains.notes)
    IS DISTINCT FROM (EXCLUDED.campus_id, EXCLUDED.audience, EXCLUDED.confidence, EXCLUDED.verification_enabled,
         EXCLUDED.official_source_url, EXCLUDED.is_active, EXCLUDED.student_id_pattern, EXCLUDED.notes)
  RETURNING (xmax = 0) AS inserted
) INSERT INTO _report SELECT 'domains', CASE WHEN inserted THEN 'inserted' ELSE 'updated' END, count(*) FROM up GROUP BY inserted;

-- 5. Nadie cambio de campus
DO $$
BEGIN
  IF EXISTS (
    (SELECT campus_id, count(*) FROM public.profiles GROUP BY campus_id EXCEPT SELECT campus_id, n FROM _before_profiles)
    UNION ALL
    (SELECT campus_id, n FROM _before_profiles EXCEPT SELECT campus_id, count(*) FROM public.profiles GROUP BY campus_id)
  ) THEN
    RAISE EXCEPTION 'PROFILES_REASSIGNED';
  END IF;
  IF EXISTS (
    (SELECT institution_id, count(*) FROM public.events GROUP BY institution_id EXCEPT SELECT institution_id, n FROM _before_events)
    UNION ALL
    (SELECT institution_id, n FROM _before_events EXCEPT SELECT institution_id, count(*) FROM public.events GROUP BY institution_id)
  ) THEN
    RAISE EXCEPTION 'EVENTS_REASSIGNED';
  END IF;
END $$;

-- Reporte (el SQL Editor muestra este resultado)
SELECT entity, action, sum(n) AS n FROM _report GROUP BY entity, action ORDER BY entity, action;

COMMIT;

-- >>> 20260918000000_ver-asistentes.sql <<<
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

-- >>> 20260919000000_despues-del-evento.sql <<<
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
