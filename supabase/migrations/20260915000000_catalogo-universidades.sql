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
