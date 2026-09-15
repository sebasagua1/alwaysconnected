-- ============================================================
-- Réplica mínima de la base de producción ANTES de
-- 20260915000000_catalogo-universidades.sql, para probar esa migración en
-- PGlite (Postgres en WebAssembly) sin tocar Supabase.
--
-- Solo lo que la migración lee o toca: auth.users y auth.uid(), los roles,
-- profiles, institutions (con las 17 filas reales de producción al
-- 2026-09-15), events y las funciones y disparadores de institución tal como
-- quedaron en 20260828, 20260829 y 20260907. Si alguna de esas cambia en una
-- migración nueva, hay que traerla aquí también.
-- ============================================================

CREATE ROLE anon;
CREATE ROLE authenticated;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;
GRANT USAGE ON SCHEMA public TO authenticated, anon;

-- ------------------------------------------------------------
-- institutions (antes campuses)
-- ------------------------------------------------------------
CREATE TABLE public.institutions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL UNIQUE,
  lat           double precision,
  lng           double precision,
  created_at    timestamptz NOT NULL DEFAULT now(),
  slug          text NOT NULL,
  email_domains text[] NOT NULL DEFAULT '{}',
  is_active     boolean NOT NULL DEFAULT true,
  CONSTRAINT institutions_slug_key UNIQUE (slug)
);
ALTER TABLE public.institutions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view institutions" ON public.institutions
  FOR SELECT TO authenticated USING (true);

CREATE FUNCTION public.normalize_institution_domains()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.email_domains := ARRAY(
    SELECT lower(btrim(d))
    FROM unnest(COALESCE(NEW.email_domains, '{}')) AS d
    WHERE btrim(d) <> ''
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_normalize_institution_domains
  BEFORE INSERT OR UPDATE ON public.institutions
  FOR EACH ROW EXECUTE FUNCTION public.normalize_institution_domains();

INSERT INTO public.institutions (id, name, slug, email_domains, lat, lng) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Tec de Monterrey Campus Querétaro', 'tec-mty-qro',
   ARRAY['tec.mx', 'exatec.mx', 'itesm.mx'], 20.6134, -100.4063),
  (gen_random_uuid(), 'Universidad Nacional Autónoma de México', 'unam', ARRAY['unam.mx', 'comunidad.unam.mx'], 19.332, -99.187),
  (gen_random_uuid(), 'Instituto Politécnico Nacional', 'ipn', ARRAY['ipn.mx', 'alumno.ipn.mx'], 19.5045, -99.147),
  (gen_random_uuid(), 'Universidad de Guadalajara', 'udg', ARRAY['udg.mx', 'alumnos.udg.mx'], 20.656, -103.325),
  (gen_random_uuid(), 'Universidad Autónoma de Nuevo León', 'uanl', ARRAY['uanl.edu.mx'], 25.725, -100.313),
  (gen_random_uuid(), 'Universidad Autónoma Metropolitana', 'uam', ARRAY['uam.mx'], 19.365, -99.074),
  (gen_random_uuid(), 'Benemérita Universidad Autónoma de Puebla', 'buap', ARRAY['buap.mx', 'alumno.buap.mx'], 19.0, -98.203),
  (gen_random_uuid(), 'Universidad Autónoma del Estado de México', 'uaemex', ARRAY['uaemex.mx'], 19.29, -99.67),
  (gen_random_uuid(), 'Universidad Autónoma de San Luis Potosí', 'uaslp', ARRAY['uaslp.mx'], 22.15, -100.98),
  (gen_random_uuid(), 'Universidad Autónoma de Querétaro', 'uaq', ARRAY['uaq.mx'], 20.588, -100.405),
  (gen_random_uuid(), 'Universidad Iberoamericana', 'ibero', ARRAY['ibero.mx'], 19.377, -99.262),
  (gen_random_uuid(), 'Instituto Tecnológico Autónomo de México', 'itam', ARRAY['itam.mx'], 19.348, -99.206),
  (gen_random_uuid(), 'Universidad Anáhuac', 'anahuac', ARRAY['anahuac.mx'], 19.419, -99.302),
  (gen_random_uuid(), 'Universidad de las Américas Puebla', 'udlap', ARRAY['udlap.mx'], 19.054, -98.283),
  (gen_random_uuid(), 'Universidad Panamericana', 'up', ARRAY['up.edu.mx'], 19.352, -99.19),
  (gen_random_uuid(), 'El Colegio de México', 'colmex', ARRAY['colmex.mx'], 19.302, -99.205),
  (gen_random_uuid(), 'Centro de Investigación y Docencia Económicas', 'cide', ARRAY['cide.edu'], 19.372, -99.267);

-- ------------------------------------------------------------
-- profiles
-- ------------------------------------------------------------
CREATE TABLE public.profiles (
  id                   uuid PRIMARY KEY REFERENCES auth.users(id),
  email                text,
  name                 text,
  major                text,
  campus_id            uuid REFERENCES public.institutions(id),
  institution_verified boolean NOT NULL DEFAULT false,
  student_id           text,
  points               integer NOT NULL DEFAULT 0,
  reputation           integer NOT NULL DEFAULT 0,
  onboarding_completed boolean NOT NULL DEFAULT false,
  CONSTRAINT profiles_institution_required
    CHECK (NOT onboarding_completed OR campus_id IS NOT NULL) NOT VALID
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id);

-- 20260828
CREATE FUNCTION public.institution_for_email(_email text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id
  FROM public.institutions
  WHERE is_active
    AND lower(split_part(_email, '@', 2)) = ANY (email_domains)
  LIMIT 1;
$$;

-- 20260907
CREATE FUNCTION public.student_id_for_email(_email text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN _email IS NULL THEN NULL
    WHEN public.institution_for_email(_email) IS NULL THEN NULL
    ELSE lower(btrim(split_part(_email, '@', 1)))
  END;
$$;

CREATE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_institution uuid;
BEGIN
  v_institution := public.institution_for_email(NEW.email);
  INSERT INTO public.profiles (id, email, campus_id, institution_verified, student_id)
  VALUES (NEW.id, NEW.email, v_institution, v_institution IS NOT NULL, public.student_id_for_email(NEW.email));
  RETURN NEW;
END;
$$;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE FUNCTION public.prevent_score_tampering()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF (NEW.points IS DISTINCT FROM OLD.points OR NEW.reputation IS DISTINCT FROM OLD.reputation)
     AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'permission denied: score fields are read-only for regular users' USING ERRCODE = '42501';
  END IF;
  IF NEW.institution_verified IS DISTINCT FROM OLD.institution_verified
     AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'permission denied: institution_verified is set by the server, not the client' USING ERRCODE = '42501';
  END IF;
  IF OLD.student_id IS NOT NULL
     AND NEW.student_id IS DISTINCT FROM OLD.student_id
     AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'permission denied: student_id is derived from the verified email, not set by the client' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_prevent_score_tampering
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_score_tampering();

-- ------------------------------------------------------------
-- Aislamiento (20260829)
-- ------------------------------------------------------------
CREATE FUNCTION public.same_institution(_a uuid, _b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles pa
    JOIN public.profiles pb ON pb.id = _b
    WHERE pa.id = _a
      AND pa.campus_id IS NOT NULL
      AND pa.campus_id = pb.campus_id
  );
$$;
GRANT EXECUTE ON FUNCTION public.same_institution(uuid, uuid) TO authenticated;

CREATE TABLE public.events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id     uuid NOT NULL,
  title          text NOT NULL,
  privacy        text NOT NULL DEFAULT 'open',
  is_active      boolean NOT NULL DEFAULT true,
  institution_id uuid REFERENCES public.institutions(id)
);
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.set_event_institution()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  SELECT campus_id INTO NEW.institution_id FROM public.profiles WHERE id = NEW.creator_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_set_event_institution
  BEFORE INSERT ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.set_event_institution();

CREATE POLICY "Events visibility policy" ON public.events FOR SELECT TO authenticated
  USING (creator_id = auth.uid() OR public.same_institution(auth.uid(), creator_id));
CREATE POLICY "Users can create events" ON public.events FOR INSERT TO authenticated
  WITH CHECK (creator_id = auth.uid());

CREATE VIEW public.public_profiles WITH (security_invoker = false) AS
SELECT id, name, campus_id, institution_verified
FROM public.profiles p
WHERE auth.uid() IS NOT NULL
  AND (p.id = auth.uid() OR public.same_institution(auth.uid(), p.id));

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO authenticated;
