-- ============================================================
-- Complemento de produccion-instituciones.sql para probar
-- 20260917000000_verificacion-institucional.sql en PGlite.
--
-- Se carga DESPUES de produccion-instituciones.sql y de
-- 20260915000000_catalogo-universidades.sql. Aporta lo que la migracion
-- lee y que la replica minima no tenia, con la forma que tiene en
-- produccion (comprobado con information_schema el 2026-09-14):
--   * auth.users con email_confirmed_at y raw_app_meta_data;
--   * el rol service_role;
--   * Vault (solo la superficie que se usa: secrets, decrypted_secrets y
--     create_secret; en PGlite el secreto no se cifra);
--   * blocks e is_blocked, que usa public_profiles;
--   * public_profiles con las columnas y el orden de produccion.
-- ============================================================

CREATE ROLE service_role;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT USAGE ON SCHEMA auth TO service_role;

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb NOT NULL DEFAULT '{}';

CREATE SCHEMA IF NOT EXISTS extensions;

CREATE SCHEMA vault;
CREATE TABLE vault.secrets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text UNIQUE,
  description text,
  secret      text NOT NULL
);
CREATE VIEW vault.decrypted_secrets AS
  SELECT id, name, description, secret, secret AS decrypted_secret FROM vault.secrets;
CREATE FUNCTION vault.create_secret(new_secret text, new_name text DEFAULT NULL, new_description text DEFAULT '')
RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO vault.secrets (name, description, secret) VALUES (new_name, new_description, new_secret) RETURNING id;
$$;
REVOKE ALL ON SCHEMA vault FROM PUBLIC;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS semester integer,
  ADD COLUMN IF NOT EXISTS residence_type text,
  ADD COLUMN IF NOT EXISTS interests text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS languages text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS origin text;

CREATE TABLE public.blocks (
  blocker_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker_id, blocked_id)
);
ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.is_blocked(a uuid, b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.blocks
    WHERE (blocker_id = a AND blocked_id = b) OR (blocker_id = b AND blocked_id = a));
$$;
GRANT EXECUTE ON FUNCTION public.is_blocked(uuid, uuid) TO authenticated;

DROP VIEW public.public_profiles;
CREATE VIEW public.public_profiles WITH (security_invoker = false) AS
SELECT id, name, avatar_url, major, semester, residence_type, interests, languages, campus_id,
       points, reputation, created_at, origin, institution_verified
FROM public.profiles p
WHERE auth.uid() IS NOT NULL
  AND NOT public.is_blocked(auth.uid(), p.id)
  AND (p.id = auth.uid() OR public.same_institution(auth.uid(), p.id));
GRANT SELECT ON public.public_profiles TO authenticated;

-- La vista de compatibilidad que lee la version publicada en App Store.
CREATE VIEW public.campuses AS
  SELECT id, name, email_domains[1] AS email_domain, lat, lng, created_at
  FROM public.institutions WHERE is_active;
GRANT SELECT ON public.campuses TO authenticated;
