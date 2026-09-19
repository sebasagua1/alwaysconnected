-- ============================================================
-- Programar la reconciliacion de perfiles.
--
-- Va en su propio script a proposito, por lo mismo que
-- 20260825010000_schedule-message-purge.sql: el SQL Editor ejecuta cada
-- uno dentro de una transaccion, y si CREATE EXTENSION pg_cron fallara
-- se llevaria por delante el relleno y el endurecimiento de
-- 20260920000000, que son lo que de verdad importa.
--
-- Que cubre esto que no cubra ya la migracion anterior: el disparador
-- endurecido protege las altas normales, y el guardia de borrado protege
-- contra borrar un perfil a mano. Queda un camino que ninguno de los dos
-- puede tapar desde dentro de la base: una sesion con
-- session_replication_role = 'replica' no ejecuta el disparador. Asi se
-- restaura un backup, asi hace PITR Supabase y asi importa datos el
-- panel. Si eso pasa, nadie se entera hasta que alguien audita a mano;
-- con esto, se arregla solo a la manana siguiente.
--
-- Si esto falla no pasa nada grave: basta con llamar a
-- backfill_missing_profiles() a mano de vez en cuando, o programarlo
-- desde Database > Cron Jobs en el panel de Supabase.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- unschedule falla si el trabajo no existe, de ahi el envoltorio.
DO $$
BEGIN
  PERFORM cron.unschedule('reconciliar-perfiles');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'reconciliar-perfiles',
  '43 4 * * *',                       -- 04:43 cada dia, despues del purgado
  $$SELECT public.backfill_missing_profiles()$$
);

-- Comprobacion: debe salir una fila con el horario.
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'reconciliar-perfiles';
