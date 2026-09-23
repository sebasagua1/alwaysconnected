-- ============================================================
-- Lo mínimo de Supabase para poder cargar supabase/setup/full_schema.sql
-- ENTERO en PGlite: roles, auth, storage, vault, pg_cron, pg_net y la
-- publicación de realtime.
--
-- No imita nada más de lo que el esquema toca. Lo que importa de verdad
-- —políticas, disparadores y funciones del proyecto— sale tal cual de las
-- migraciones; esto solo pone el suelo sobre el que se apoyan.
--
--   * auth.uid() lee el `sub` de request.jwt.claims (lo que hace Supabase) y,
--     por compatibilidad con los fixtures viejos, request.jwt.claim.sub.
--   * net.http_post no llama a nadie: apunta la petición en
--     net._test_requests para que las pruebas vean qué se habría enviado.
--   * cron.schedule solo recuerda el nombre y la expresión.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, anon, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated, anon, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated, anon, service_role;

CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO authenticated, anon, service_role;

-- ---------------------------------------------------------------- auth
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;

CREATE TABLE IF NOT EXISTS auth.users (
  id                 uuid PRIMARY KEY,
  email              text,
  email_confirmed_at timestamptz,
  encrypted_password text,
  phone              text,
  phone_confirmed_at timestamptz,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_app_meta_data  jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_anonymous       boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )
$$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.jwt() TO authenticated, anon, service_role;

-- ---------------------------------------------------------------- storage
CREATE SCHEMA IF NOT EXISTS storage;
GRANT USAGE ON SCHEMA storage TO authenticated, anon, service_role;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  public             boolean DEFAULT false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id  text REFERENCES storage.buckets(id),
  name       text,
  owner      uuid,
  metadata   jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;

-- ---------------------------------------------------------------- vault
CREATE SCHEMA IF NOT EXISTS vault;
CREATE TABLE IF NOT EXISTS vault.secrets (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name   text UNIQUE,
  secret text
);
CREATE OR REPLACE VIEW vault.decrypted_secrets AS
  SELECT id, name, secret AS decrypted_secret FROM vault.secrets;
CREATE OR REPLACE FUNCTION vault.create_secret(_secret text, _name text, _description text DEFAULT NULL) RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO vault.secrets (name, secret) VALUES (_name, _secret)
  ON CONFLICT (name) DO UPDATE SET secret = EXCLUDED.secret
  RETURNING id
$$;

-- ---------------------------------------------------------------- pg_cron
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE IF NOT EXISTS cron.job (
  jobid    bigserial PRIMARY KEY,
  jobname  text UNIQUE,
  schedule text,
  command  text
);
CREATE OR REPLACE FUNCTION cron.schedule(_name text, _schedule text, _command text) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (_name, _schedule, _command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid
$$;
CREATE OR REPLACE FUNCTION cron.unschedule(_name text) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM cron.job WHERE jobname = _name;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'could not find valid entry for job %', _name;
  END IF;
  RETURN true;
END;
$$;

-- ---------------------------------------------------------------- pg_net
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE IF NOT EXISTS net._test_requests (
  id      bigserial PRIMARY KEY,
  url     text,
  headers jsonb,
  body    jsonb,
  at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION net.http_post(
  url                  text,
  body                 jsonb DEFAULT '{}'::jsonb,
  params               jsonb DEFAULT '{}'::jsonb,
  headers              jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO net._test_requests (url, headers, body) VALUES (url, headers, body) RETURNING id
$$;

-- ---------------------------------------------------------------- realtime
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;
