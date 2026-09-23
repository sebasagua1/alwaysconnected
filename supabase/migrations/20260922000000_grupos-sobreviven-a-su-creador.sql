-- ============================================================
-- Auditoria 2026-09-18: borrar tu cuenta no borra el grupo de los demas
--
-- UX-03 (P3). groups.created_by era NOT NULL ... ON DELETE CASCADE, asi que
-- borrar una cuenta eliminaba TODOS los grupos que esa persona hubiera
-- creado y, en cascada, sus group_members y todos los messages de esos
-- grupos -- incluidos los de las demas personas.
--
-- Desde la privacidad de quien se va es correcto que desaparezca lo suyo.
-- Para el resto del grupo es una perdida de datos inesperada causada por un
-- tercero, y con create_group_from_event (20260919000000) los grupos pasaron
-- a ser objetos compartidos con vida propia, lo que lo agrava.
--
-- Lo que hace esta migracion:
--   1. created_by pasa a ser nullable y su clave ajena a ON DELETE SET NULL.
--   2. Un disparador recoge ese NULL y traspasa el grupo al miembro mas
--      antiguo que quede. Si no queda nadie, el grupo se borra: un grupo sin
--      miembros no le sirve a nadie y solo acumularia mensajes huerfanos.
--   3. Los DM son un caso aparte. Son grupos llamados '__dm_<uuid>_<uuid>'
--      y solo tienen sentido entre DOS personas concretas: si una se va, el
--      chat se borra, que es EXACTAMENTE lo que pasaba antes. Traspasarlo
--      dejaria a la otra persona con un DM sin interlocutor.
--
-- Ninguna politica se rompe: las tres que miran created_by lo comparan con
-- auth.uid(), y NULL = <uuid> no es cierto, asi que un grupo sin dueno
-- simplemente deja de conceder nada por esa via. Lo comprobe una por una:
--   * "Members and creators can view groups"        (SELECT groups)
--   * "Creators can update groups"                  (UPDATE groups)
--   * la rama de creador en el SELECT de group_members
-- Todas siguen concediendo por is_group_member, que es lo que importa.
--
-- ASCII puro. Idempotente.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. created_by puede quedarse sin dueno mientras se traspasa
-- ------------------------------------------------------------
ALTER TABLE public.groups ALTER COLUMN created_by DROP NOT NULL;

DO $$
DECLARE
  v_nombre text;
  v_tipo   "char";
BEGIN
  SELECT con.conname, con.confdeltype INTO v_nombre, v_tipo
  FROM   pg_constraint con
  JOIN   pg_attribute  att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
  WHERE  con.conrelid = 'public.groups'::regclass
    AND  con.contype  = 'f'
    AND  att.attname  = 'created_by'
    AND  array_length(con.conkey, 1) = 1;

  IF v_nombre IS NULL THEN
    RAISE NOTICE 'groups.created_by no tiene clave ajena de una sola columna; nada que cambiar.';
  ELSIF v_tipo = 'n' THEN
    RAISE NOTICE 'groups.created_by ya estaba en SET NULL.';
  ELSE
    EXECUTE format('ALTER TABLE public.groups DROP CONSTRAINT %I', v_nombre);
    ALTER TABLE public.groups
      ADD CONSTRAINT groups_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
    RAISE NOTICE 'groups.created_by: CASCADE -> SET NULL.';
  END IF;
END;
$$;


-- ------------------------------------------------------------
-- 2. El traspaso
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transfer_group_on_owner_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_heredero uuid;
BEGIN
  -- Un DM no se traspasa: se va con quien se va.
  IF left(COALESCE(NEW.name, ''), 5) = '__dm_' THEN
    DELETE FROM public.groups WHERE id = NEW.id;
    RETURN NULL;
  END IF;

  -- El miembro mas antiguo que quede, excluyendo a quien se va. Hay que
  -- excluirlo a mano: el borrado de auth.users dispara varias cascadas y no
  -- garantiza que su propia fila de group_members se haya ido ya, asi que sin
  -- esto podria heredar el grupo la misma persona que lo esta dejando.
  SELECT gm.user_id INTO v_heredero
  FROM   public.group_members gm
  WHERE  gm.group_id = NEW.id
    AND  gm.user_id <> OLD.created_by
  ORDER  BY gm.joined_at ASC, gm.user_id ASC
  LIMIT  1;

  IF v_heredero IS NULL THEN
    -- Nadie mas dentro: el grupo no le sirve a nadie y solo dejaria mensajes
    -- huerfanos. Mismo efecto que antes de esta migracion.
    DELETE FROM public.groups WHERE id = NEW.id;
    RETURN NULL;
  END IF;

  UPDATE public.groups SET created_by = v_heredero WHERE id = NEW.id;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.transfer_group_on_owner_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_transfer_group_on_owner_delete ON public.groups;
CREATE TRIGGER trg_transfer_group_on_owner_delete
  AFTER UPDATE OF created_by ON public.groups
  FOR EACH ROW
  -- Solo el paso a NULL, que es el que provoca el SET NULL del borrado de
  -- cuenta. Un cambio normal de dueno no entra aqui.
  WHEN (NEW.created_by IS NULL AND OLD.created_by IS NOT NULL)
  EXECUTE FUNCTION public.transfer_group_on_owner_delete();

COMMENT ON COLUMN public.groups.created_by IS
  'Quien creo el grupo. Nullable desde 20260922000000 solo como paso '
  'intermedio: si esa cuenta se borra, la clave ajena lo pone en NULL y '
  'trg_transfer_group_on_owner_delete traspasa el grupo al miembro mas '
  'antiguo (o lo borra si no queda nadie, y siempre si es un DM).';

COMMIT;
