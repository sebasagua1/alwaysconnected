-- ============================================================
-- Auditoria 2026-09-18: avisar de los cambios, y no perder los reportes
--
-- 1. UX-02 (P2). El organizador podia cambiar la HORA, el SITIO o cancelar
--    un evento, y nadie se enteraba. No habia ningun disparador de push
--    sobre UPDATE de events: los cuatro de 20260827000000 cubren solicitud,
--    aprobacion, mensaje y amistad, y el de 20260919000000 el plan repetido.
--    Ninguno cubria el cambio.
--
--    Para una app cuyo proposito es que la gente se encuentre FISICAMENTE,
--    presentarse a un evento cancelado o en el sitio equivocado erosiona la
--    confianza mas que cualquier fallo tecnico.
--
--    Tres casos, y un cuarto que se trata aparte:
--      * is_active pasa a false  -> "se cancelo"
--      * cambia starts_at        -> "cambio la hora"
--      * cambian lat/lng         -> "cambio el lugar"
--      * privacy de open/private a friends: la RLS deja de mostrarles el
--        evento aunque su fila siga ahi, asi que pierden de vista algo a lo
--        que estan apuntados. Se avisa igual, porque es lo unico que van a
--        recibir: despues ya no lo veran.
--
--    Va a quien tiene status='joined' y no ha bloqueado a quien organiza,
--    igual que on_event_repeat_push. Se reutiliza push_send tal cual: una
--    push fallida nunca tumba el UPDATE que la provoco.
--
-- 2. SEC-09 (P3). reports.reported_user_id era ON DELETE CASCADE, asi que
--    alguien reportado por acoso borraba su cuenta, se registraba otra vez
--    con el mismo correo, y el historial de moderacion sobre el desaparecia.
--    Apple pide actuar sobre el contenido reportado (guideline 1.2) y el
--    README documenta que la triage se hace a mano desde el SQL Editor: si
--    los reportes se evaporan antes de que alguien los mire, la cola nunca
--    los ve.
--
--    reports.reporter_id ya se paso a SET NULL en 20260817010000 por esta
--    misma razon, y blocks guarda blocked_name desnormalizado por si el
--    bloqueado se va. Aqui se aplica el mismo patron, ya probado en el
--    propio proyecto, al lado que faltaba.
--
-- ASCII puro. Idempotente. No borra datos.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Aviso al cambiar o cancelar un evento
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.on_event_change_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_title  text;
  v_cuerpo text;
  v_tipo   text;
  r        record;
BEGIN
  -- El titulo, truncado por lo mismo que en on_event_repeat_push: APNs
  -- rechaza cargas de mas de 4 KB y una push rota no avisa de nada.
  v_title := left(NEW.title, 80);
  IF length(NEW.title) > 80 THEN
    v_title := v_title || U&'\2026';
  END IF;

  -- Un solo aviso por UPDATE, con el cambio mas grave que haya ocurrido.
  -- Cancelar gana a todo: si el evento ya no existe, la hora da igual.
  IF OLD.is_active AND NOT NEW.is_active THEN
    v_tipo   := 'event_cancelled';
    v_cuerpo := U&'Se cancel\00F3 \00AB' || v_title || U&'\00BB';
  ELSIF NEW.starts_at IS DISTINCT FROM OLD.starts_at THEN
    v_tipo   := 'event_changed';
    v_cuerpo := U&'Cambi\00F3 la hora de \00AB' || v_title || U&'\00BB';
  ELSIF NEW.lat IS DISTINCT FROM OLD.lat OR NEW.lng IS DISTINCT FROM OLD.lng THEN
    v_tipo   := 'event_changed';
    v_cuerpo := U&'Cambi\00F3 el lugar de \00AB' || v_title || U&'\00BB';
  ELSIF NEW.privacy = 'friends' AND OLD.privacy <> 'friends' THEN
    -- El ultimo aviso que van a ver: despues la RLS ya no les muestra el
    -- evento, aunque su fila de participacion siga ahi.
    v_tipo   := 'event_changed';
    v_cuerpo := U&'\00AB' || v_title || U&'\00BB ahora es solo para amigos';
  ELSE
    RETURN NEW;
  END IF;

  FOR r IN
    SELECT ep.user_id
    FROM   public.event_participants ep
    WHERE  ep.event_id = NEW.id
      AND  ep.status   = 'joined'
      AND  ep.user_id <> NEW.creator_id
      AND  NOT public.is_blocked(ep.user_id, NEW.creator_id)
    LIMIT 200
  LOOP
    PERFORM public.push_send(
      r.user_id,
      CASE WHEN v_tipo = 'event_cancelled' THEN U&'Plan cancelado' ELSE U&'Cambi\00F3 un plan' END,
      v_cuerpo,
      jsonb_build_object('type', v_tipo, 'event_id', NEW.id)
    );
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.on_event_change_push() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_event_change_push ON public.events;
CREATE TRIGGER trg_event_change_push
  AFTER UPDATE OF starts_at, lat, lng, is_active, privacy ON public.events
  FOR EACH ROW
  -- Sin el WHEN, guardar el evento sin tocar nada disparia la funcion en
  -- vano para cada participante.
  WHEN (OLD.is_active  IS DISTINCT FROM NEW.is_active
     OR OLD.starts_at  IS DISTINCT FROM NEW.starts_at
     OR OLD.lat        IS DISTINCT FROM NEW.lat
     OR OLD.lng        IS DISTINCT FROM NEW.lng
     OR OLD.privacy    IS DISTINCT FROM NEW.privacy)
  EXECUTE FUNCTION public.on_event_change_push();


-- ------------------------------------------------------------
-- 2. Los reportes sobreviven a que el reportado borre su cuenta
--
-- No basta con pasar la clave ajena a SET NULL: reports_one_target exige
-- que cada reporte apunte a EXACTAMENTE una cosa, y un CHECK se comprueba
-- tambien en el UPDATE que provoca el SET NULL. El borrado de cuenta
-- fallaria entero.
--
-- Asi que el objetivo se parte en dos columnas:
--   * reported_user_id  sigue siendo el enlace VIVO, con clave ajena; pasa
--     a NULL cuando la cuenta se va, y por eso ya no puede sostener el
--     CHECK.
--   * reported_user_ref es la copia DURADERA del uuid, SIN clave ajena, que
--     es la que el CHECK mira. Mas reported_name, para que la cola no tenga
--     que descifrar un uuid a mano.
--
-- Mismo patron que blocks.blocked_name, que ya existe en el proyecto.
-- ------------------------------------------------------------
ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS reported_user_ref uuid,
  ADD COLUMN IF NOT EXISTS reported_name     text;

COMMENT ON COLUMN public.reports.reported_user_ref IS
  'Copia del uuid reportado, SIN clave ajena a proposito: sobrevive a que la '
  'cuenta se borre. Es la que sostiene reports_one_target; reported_user_id '
  'es el enlace vivo y pasa a NULL.';
COMMENT ON COLUMN public.reports.reported_name IS
  'Nombre de la persona reportada en el momento del reporte. Desnormalizado '
  'para que la cola de moderacion siga sabiendo sobre quien era. Mismo patron '
  'que blocks.blocked_name.';

-- Rellenar lo que ya hay ANTES de tocar el CHECK y la clave ajena.
UPDATE public.reports r
SET    reported_user_ref = r.reported_user_id
WHERE  r.reported_user_id IS NOT NULL
  AND  r.reported_user_ref IS NULL;

UPDATE public.reports r
SET    reported_name = p.name
FROM   public.profiles p
WHERE  p.id = r.reported_user_id
  AND  r.reported_name IS NULL;

-- Las dos las pone el servidor en cada reporte nuevo, no el cliente.
CREATE OR REPLACE FUNCTION public.set_report_reported_target()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.reported_user_ref := NEW.reported_user_id;
  NEW.reported_name     := NULL;

  IF NEW.reported_user_id IS NOT NULL THEN
    SELECT p.name INTO NEW.reported_name
    FROM public.profiles p WHERE p.id = NEW.reported_user_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_report_reported_target() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_set_report_reported_target ON public.reports;
CREATE TRIGGER trg_set_report_reported_target
  BEFORE INSERT ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.set_report_reported_target();

-- El CHECK pasa a mirar la copia duradera.
ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_one_target;
ALTER TABLE public.reports
  ADD CONSTRAINT reports_one_target CHECK (
    (reported_user_ref   IS NOT NULL)::int
  + (reported_event_id   IS NOT NULL)::int
  + (reported_message_id IS NOT NULL)::int = 1
  );

-- El indice unico tambien: si no, borrar la cuenta y volver a registrarse
-- con el mismo correo permitiria un reporte duplicado del mismo denunciante.
DROP INDEX IF EXISTS public.reports_unique_user_target;
CREATE UNIQUE INDEX IF NOT EXISTS reports_unique_user_target
  ON public.reports (reporter_id, reported_user_ref) WHERE reported_user_ref IS NOT NULL;

-- Y la cola de moderacion se lee por aqui.
CREATE INDEX IF NOT EXISTS reports_pending_idx
  ON public.reports (created_at DESC) WHERE status = 'pending';

-- CASCADE -> SET NULL. El nombre del constraint lo pone Postgres al crear la
-- tabla, asi que se busca en el catalogo en vez de darlo por sabido.
DO $$
DECLARE
  v_nombre text;
  v_tipo   "char";
BEGIN
  SELECT con.conname, con.confdeltype INTO v_nombre, v_tipo
  FROM   pg_constraint con
  JOIN   pg_attribute  att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
  WHERE  con.conrelid = 'public.reports'::regclass
    AND  con.contype  = 'f'
    AND  att.attname  = 'reported_user_id'
    AND  array_length(con.conkey, 1) = 1;

  IF v_nombre IS NULL THEN
    RAISE NOTICE 'reports.reported_user_id ya no tiene clave ajena de una sola columna; nada que cambiar.';
    RETURN;
  END IF;

  IF v_tipo = 'n' THEN
    RAISE NOTICE 'reports.reported_user_id ya estaba en SET NULL.';
    RETURN;
  END IF;

  EXECUTE format('ALTER TABLE public.reports DROP CONSTRAINT %I', v_nombre);
  ALTER TABLE public.reports
    ADD CONSTRAINT reports_reported_user_id_fkey
    FOREIGN KEY (reported_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  RAISE NOTICE 'reports.reported_user_id: CASCADE -> SET NULL.';
END;
$$;

COMMIT;
