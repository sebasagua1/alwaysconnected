-- ============================================================
-- Cuentas sin perfil: rellenar las que faltan y cerrar el agujero
--
-- El problema (detectado el 2026-09-18 auditando event_participants):
-- hay filas en auth.users sin su fila en public.profiles. Como
-- public.same_institution() resuelve la pertenencia leyendo profiles,
-- sin perfil devuelve false siempre y la RLS de events, public_profiles
-- y el chat dejan de mostrarle a esa persona lo de su propio campus. La
-- app se le ve medio vacia y no falla nada visible.
--
-- Que puede dejar a una cuenta asi. Repasadas todas las versiones de
-- handle_new_user() (20260325, 20260828, 20260907, 20260915, 20260917):
--
--   a) NO es que el disparador falle en silencio. No tiene ningun
--      EXCEPTION WHEN OTHERS, y si el INSERT revienta se lleva por
--      delante la transaccion entera del alta: no queda huerfana, es que
--      no hay cuenta (GoTrue devuelve "Database error saving new user").
--      El caso tipico es profiles.email NOT NULL con NEW.email nulo, que
--      pasa en las altas sin correo (anonima, telefono, o un idToken de
--      Apple sin claim de email). Eso rompe el alta, no la deja a medias.
--      Aun asi se arregla abajo: un alta sin correo no deberia tumbarse.
--
--   b) SI dejan huerfanas, y son las que explican lo que se ve:
--      * cualquier camino que se salte el disparador, o sea cualquier
--        sesion con session_replication_role = 'replica': restauraciones,
--        PITR, pg_restore y la importacion de datos del panel;
--      * borrar a mano una fila de public.profiles. La clave ajena
--        profiles.id -> auth.users(id) cae en cascada hacia abajo, pero
--        nada impedia el borrado en el otro sentido;
--      * cuentas anteriores al 2026-03-25, cuando no existia el
--        disparador.
--
--   c) Un segundo agujero silencioso, del mismo estilo:
--      sync_profile_verified() hace UPDATE profiles WHERE id = NEW.user_id,
--      que sin perfil es un no-op sin error. Se queda una afiliacion
--      verificada cuyo perfil no existe. Lo arregla el relleno de abajo.
--
-- Lo que hace esta migracion:
--   1. backfill_missing_profiles(): crea los perfiles que faltan y pasa
--      cada uno por la misma via que un alta normal.
--   2. Lo ejecuta una vez.
--   3. Endurece handle_new_user(): correo ausente no tumba el alta, y
--      repetir el INSERT no rompe. SIN EXCEPTION WHEN OTHERS a proposito
--      (ver el comentario del punto 3).
--   4. Prohibe borrar un perfil mientras su cuenta siga viva.
--
-- ASCII puro. Idempotente: se puede pegar dos veces.
-- Diagnostico previo: supabase/setup/diagnostico-perfiles-huerfanos.sql
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Rellenar los que faltan
--
-- En funcion y no suelto porque hace falta tres veces: aqui, en el
-- trabajo programado de 20260920010000, y a mano si algun dia se
-- restaura un backup.
--
-- No toca las cuentas borradas en blando (deleted_at): resucitarles el
-- perfil las devolveria a la vista publica. La columna se lee via
-- to_jsonb() porque no existe en todas las versiones de GoTrue y
-- nombrarla directamente haria fallar la funcion entera.
--
-- El correo va con coalesce a cadena vacia por profiles.email NOT NULL.
-- Vacio es exacto: esa cuenta no tiene correo. No casa con ningun
-- dominio, asi que institution_for_email() y student_id_for_email()
-- devuelven NULL igual que siempre.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backfill_missing_profiles()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids uuid[];
  v_id  uuid;
BEGIN
  WITH creados AS (
    INSERT INTO public.profiles (id, email)
    SELECT u.id, coalesce(u.email, '')
    FROM auth.users u
    WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)
      AND (to_jsonb(u) ->> 'deleted_at') IS NULL
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  )
  SELECT array_agg(id) INTO v_ids FROM creados;

  IF v_ids IS NULL THEN
    RETURN 0;
  END IF;

  -- Antes de nada, lo que ya se sabia de esa persona. Una cuenta huerfana
  -- puede tener su fila en profile_affiliations: sin perfil,
  -- sync_profile_verified() no tenia donde escribir (ver el punto c de la
  -- cabecera) y apply_auth_email_affiliation() se corta en
  -- 'already_verified' sin llegar a asignar campus. Si no se copia aqui, el
  -- perfil nace vacio y same_institution() le sigue diciendo que no a todo:
  -- la fila existiria y la app se le veria igual de rota.
  UPDATE public.profiles p
  SET campus_id            = coalesce(p.campus_id, a.campus_id),
      institution_verified = (a.status = 'verified'),
      student_id           = coalesce(
                               p.student_id,
                               CASE WHEN a.status = 'verified'
                                    THEN public.student_id_for_email(u.email) END)
  FROM public.profile_affiliations a
  JOIN auth.users u ON u.id = a.user_id
  WHERE a.user_id = p.id
    AND p.id = ANY (v_ids);

  -- Y ahora cada perfil pasa por la misma via que un alta de hoy:
  -- si su correo de acceso esta confirmado y es de un dominio
  -- institucional, queda adscrito a su campus y verificado. Si no, se
  -- queda sin verificar, como cualquier cuenta con correo generico.
  -- Esto es lo que les devuelve su comunidad: sin campus_id,
  -- same_institution() les seguiria diciendo que no a todo.
  --
  -- El EXCEPTION de dentro del bucle es deliberado y NO es el que se
  -- critica arriba: esta acotado a un paso accesorio, avisa en vez de
  -- callarse, y lo que protege es el perfil, que ya esta creado. Sin el,
  -- una sola afiliacion rara abortaria el relleno de todos los demas.
  FOREACH v_id IN ARRAY v_ids LOOP
    BEGIN
      PERFORM public.apply_auth_email_affiliation(v_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'backfill_missing_profiles: afiliacion de % no resuelta (%)', v_id, SQLERRM;
    END;
  END LOOP;

  RETURN array_length(v_ids, 1);
END;
$$;

COMMENT ON FUNCTION public.backfill_missing_profiles() IS
  'Crea la fila de public.profiles de las cuentas de auth.users que no la tienen y resuelve su afiliacion. Idempotente. La llama el trabajo programado reconciliar-perfiles.';

REVOKE EXECUTE ON FUNCTION public.backfill_missing_profiles() FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- 2. Ejecutarlo ahora
-- ------------------------------------------------------------
DO $$
DECLARE
  v_n integer;
BEGIN
  v_n := public.backfill_missing_profiles();
  RAISE NOTICE 'perfiles creados: %', v_n;
END $$;


-- ------------------------------------------------------------
-- 3. Que no vuelva a pasar en el alta
--
-- Dos cambios, los dos pequenos:
--
--   * coalesce(NEW.email, ''): un alta sin correo (anonima, por telefono,
--     o un idToken de Apple sin claim de email) ya no choca contra
--     profiles.email NOT NULL. Antes eso no dejaba huerfana a la cuenta
--     (tumbaba el alta entera), pero tumbar el alta tampoco vale.
--
--   * ON CONFLICT (id) DO NOTHING: si el perfil ya existe, no revienta.
--     Hace falta para que el relleno y el disparador puedan cruzarse sin
--     pisarse.
--
-- Lo que NO lleva, a proposito: un EXCEPTION WHEN OTHERS envolviendo el
-- INSERT. Seria justo el bug que se esta arreglando: convertiria
-- cualquier fallo futuro en una cuenta huerfana silenciosa, que es lo
-- que ha costado una auditoria de event_participants encontrar. Si este
-- INSERT llega a fallar algun dia, que se note en el alta.
--
-- El disparador se recrea en vez de darse por existente: asi esta
-- migracion tambien sirve si alguien lo borro o lo dejo desactivado
-- (DROP + CREATE lo devuelve a estado activo).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, coalesce(NEW.email, ''))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ------------------------------------------------------------
-- 4. Que no se pueda borrar un perfil con la cuenta viva
--
-- La clave ajena profiles.id -> auth.users(id) ON DELETE CASCADE cubre
-- un sentido: borrar la cuenta borra el perfil. El otro estaba abierto,
-- y borrar una fila de profiles desde el panel o el SQL Editor dejaba a
-- esa persona con la app rota sin ningun aviso.
--
-- El borrado de cuenta de verdad sigue funcionando: cuando la cascada
-- llega aqui, la fila de auth.users ya no esta en la transaccion, asi
-- que el EXISTS da false y deja pasar. Hay una prueba que lo fija
-- (src/test/perfilesHuerfanos.sql.test.ts).
--
-- Si alguna vez hace falta borrar un perfil de verdad, se quita el
-- disparador, se borra, y se vuelve a poner.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_orphan_profile_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.id) THEN
    RAISE EXCEPTION 'no se puede borrar el perfil mientras la cuenta siga existiendo: borra la cuenta y el perfil cae en cascada'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_orphan_profile_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_prevent_orphan_profile_delete ON public.profiles;
CREATE TRIGGER trg_prevent_orphan_profile_delete
  BEFORE DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_orphan_profile_delete();

COMMIT;


-- ============================================================
-- Comprobacion (se ejecuta y devuelve filas): deben salir DOS
-- disparadores, on_auth_user_created sobre auth.users y
-- trg_prevent_orphan_profile_delete sobre public.profiles, los dos
-- con tgenabled = 'O'.
-- ============================================================
SELECT c.relname AS tabla, t.tgname AS disparador, t.tgenabled AS estado
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal
  AND t.tgname IN ('on_auth_user_created', 'trg_prevent_orphan_profile_delete')
ORDER BY 1, 2;
