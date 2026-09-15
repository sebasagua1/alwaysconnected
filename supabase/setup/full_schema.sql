-- ============================================================
-- Always Connected — esquema completo (consolidado de migrations/)
-- Pegar en el SQL Editor de un proyecto Supabase NUEVO y ejecutar.
--
-- NO EDITAR A MANO: lo genera scripts/gen-full-schema.mjs.
-- Migraciones incluidas: 41 (hasta 20260918000000_ver-asistentes.sql).
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
