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
