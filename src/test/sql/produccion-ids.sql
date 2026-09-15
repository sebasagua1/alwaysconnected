-- ============================================================
-- Ids reales de produccion (2026-09-14) para la replica de PGlite.
--
-- Se carga despues de 20260915000000_catalogo-universidades.sql y antes de
-- crear perfiles o eventos. La replica genera ids al azar; la migracion de
-- datos del catalogo comprueba que los ids conocidos no cambian, asi que la
-- prueba necesita los de verdad. Solo ids y slugs: nada personal.
-- ============================================================
ALTER TABLE public.institutions DROP CONSTRAINT IF EXISTS institutions_university_id_fkey;

CREATE TEMP TABLE _pin_u (slug text, id uuid);
INSERT INTO _pin_u VALUES
  ('tec', '2c931b2c-9449-4ba7-b701-2a57c2ae2f62'::uuid),
  ('icesi', '24ba682b-945a-4355-865a-dc65ec118861'::uuid),
  ('javeriana', '9fa36a6f-f113-4788-90b2-5fc69430c851'::uuid),
  ('cesa', '5ef91efd-a109-48d3-8f68-2a9308ce8c5e'::uuid),
  ('purdue', 'bcda7873-6322-4d24-8b49-428e6706ee7d'::uuid),
  ('florida-state', 'd8700f55-9fd3-42d1-a199-fba956e5d78d'::uuid);
CREATE TEMP TABLE _pin_i (slug text, id uuid);
INSERT INTO _pin_i VALUES
  ('tec-queretaro', '1a898a3a-53c0-4468-8dc6-b03bef169a6e'::uuid),
  ('tec-guadalajara', '9269e0c2-1704-4264-8e26-294c7fddbf8a'::uuid),
  ('tec-monterrey', 'a77a918e-5b0b-45b2-9a01-acdd4d61d08a'::uuid),
  ('tec-ciudad-de-mexico', '1fe414c7-3136-4696-ac67-2b07a416e9cf'::uuid),
  ('florida-state', 'be062ad6-1a5d-4687-a71d-21c2ac7a8ad0'::uuid),
  ('purdue', '3869753e-03d4-4ad9-ae96-2b7605117f4b'::uuid),
  ('icesi', '2d5e3036-eed0-4398-92db-f92cb5f4dd4e'::uuid),
  ('javeriana', '91eb1307-a047-436b-ba78-8c6eca58c4fe'::uuid),
  ('cesa', '62cd4de7-26c3-49e4-b4f4-7b5e3efd0617'::uuid),
  ('unam', '9aa57d8a-732e-4293-aa8a-bab741523796'::uuid),
  ('ipn', 'a7463fb5-c938-4743-87cf-51f43edae71b'::uuid),
  ('udg', 'c32b35f0-6177-4488-bb3c-cfa2e0985164'::uuid),
  ('uanl', 'd54d915b-c7a1-4e6d-a2b5-bb7ff3a6f603'::uuid),
  ('buap', '31744f31-49df-466f-bab4-f4527afde0f5'::uuid),
  ('uam', 'e843d37b-5c82-42c0-b853-654807a41042'::uuid),
  ('uaemex', '948cbbe0-8a83-4e6c-a4b6-e0aeb1d7f090'::uuid),
  ('uaslp', '713927e5-430e-4325-af3f-0333d410b5d1'::uuid),
  ('uaq', 'eaa4cd40-0566-42a6-ac91-e652b1137151'::uuid),
  ('ibero', '46a080c1-c6d2-4ee9-ba04-db520d6ef99e'::uuid),
  ('itam', 'f5d3ed89-6d29-4fbe-9470-44cd6ce0db26'::uuid),
  ('anahuac', '60786e59-f502-4f49-824c-7509b8e2a400'::uuid),
  ('udlap', '35a6dfa2-32e4-4286-ac5b-22241ecf3065'::uuid),
  ('up', '026f4553-90bf-46b6-b17f-5784dbff1b7f'::uuid),
  ('colmex', '9be8685c-ae88-4a73-ba4f-14b835d9b66b'::uuid),
  ('cide', 'e592d5a8-f8e9-41e9-b285-68c5f5f858e1'::uuid);

UPDATE public.institutions i SET university_id = p.id
FROM public.universities u JOIN _pin_u p ON p.slug = u.slug
WHERE i.university_id = u.id;
UPDATE public.universities u SET id = p.id FROM _pin_u p WHERE p.slug = u.slug;
UPDATE public.institutions i SET id = p.id FROM _pin_i p WHERE p.slug = i.slug;

ALTER TABLE public.institutions
  ADD CONSTRAINT institutions_university_id_fkey FOREIGN KEY (university_id) REFERENCES public.universities(id);
DROP TABLE _pin_u;
DROP TABLE _pin_i;
