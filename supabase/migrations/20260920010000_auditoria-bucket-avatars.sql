-- ============================================================
-- Auditoria 2026-09-18: el bucket de avatares no tenia ningun limite
--
-- SEC-06 (P2). El bucket se creo en 20260325002039 asi:
--
--   INSERT INTO storage.buckets (id, name, public) VALUES ('avatars','avatars',true);
--
-- Sin file_size_limit y sin allowed_mime_types. La politica de INSERT solo
-- acotaba la CARPETA (la primera parte del nombre tiene que ser tu uuid).
-- El cliente se comporta bien —reduce la imagen y sube siempre a
-- `<uuid>/avatar.jpg` con contentType image/jpeg— pero eso es una
-- convencion del cliente, no una restriccion.
--
-- Por la API directa, una cuenta autenticada podia:
--   * subir archivos de cualquier tamano y en cualquier cantidad
--     (almacenamiento y ancho de banda sin techo, y facturables), y
--   * subir un archivo con Content-Type: text/html a un bucket PUBLICO,
--     o sea alojar phishing servido desde un dominio *.supabase.co.
--
-- Se encadena con SEC-07 (el borrado de cuenta paginaba de 100 en 100 y
-- dejaba lo que pasara del archivo 101).
--
-- VA EN MIGRACION APARTE a proposito: es la unica de esta tanda que puede
-- rechazar algo que hoy existe. El bloque 2 comprueba primero si hay
-- avatares con otro nombre y solo aprieta la politica si no los hay.
--
-- ASCII puro. Idempotente.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Limites del bucket
--
-- 2 MB y tres tipos de imagen. El recorte del cliente sale en JPEG y pesa
-- muy por debajo; esto es el techo, no el objetivo.
-- ------------------------------------------------------------
UPDATE storage.buckets
SET file_size_limit    = 2097152,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']
WHERE id = 'avatars';


-- ------------------------------------------------------------
-- 2. Un archivo por persona, con el nombre que usa la app
--
-- La politica pasa de "tu carpeta" a "tu unico archivo". Con esto, la
-- cantidad deja de ser ilimitada: no se pueden acumular archivos porque
-- solo cabe un nombre.
--
-- Si ya existe algun avatar con otro nombre (subido antes de que el cliente
-- fijara la extension, o por la API a mano), apretar la politica dejaria a
-- esa gente sin poder volver a subir foto. Asi que se comprueba antes y, si
-- los hay, se deja la politica floja y se avisa: hay que renombrarlos o
-- borrarlos primero y volver a pasar esta migracion.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_raros int;
BEGIN
  SELECT count(*) INTO v_raros
  FROM storage.objects
  WHERE bucket_id = 'avatars'
    AND name !~ '^[0-9a-fA-F-]{36}/avatar\.jpg$';

  IF v_raros > 0 THEN
    RAISE WARNING 'avatars: % objeto(s) con un nombre que la politica estricta rechazaria. Se deja la politica por carpeta. Revisalos con: SELECT name FROM storage.objects WHERE bucket_id=''avatars'' AND name !~ ''^[0-9a-fA-F-]{36}/avatar\.jpg$'';', v_raros;
    RETURN;
  END IF;

  DROP POLICY IF EXISTS "Authenticated can upload own avatar" ON storage.objects;
  CREATE POLICY "Authenticated can upload own avatar"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
    AND name = auth.uid()::text || '/avatar.jpg'
  );

  -- El cliente sube con upsert:true, asi que la segunda foto de cada
  -- persona entra por UPDATE, no por INSERT. Sin WITH CHECK aqui, esa ruta
  -- se saltaria el limite de nombre entero.
  DROP POLICY IF EXISTS "Users can update own avatar" ON storage.objects;
  CREATE POLICY "Users can update own avatar"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
  )
  WITH CHECK (
    bucket_id = 'avatars'
    AND name = auth.uid()::text || '/avatar.jpg'
  );

  RAISE NOTICE 'avatars: politica estricta aplicada (un solo archivo por persona).';
END;
$$;

COMMIT;
