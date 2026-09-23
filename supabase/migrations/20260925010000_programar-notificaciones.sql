-- ============================================================
-- Programar los trabajos de notificaciones (pg_cron)
--
-- Va en su propio archivo por lo mismo que 20260825010000 y
-- 20260921010000: si pg_cron no estuviera disponible, que falle esto y no
-- se lleve por delante la tuberia de 20260925000000.
--
--   despachar-notificaciones   cada minuto   solo despierta a notify-dispatch
--                                            si hay algo pendiente o atascado
--   recordar-eventos           cada 5 min    recordatorios antes de empezar
--   recomendar-eventos         cada 10 min   actividades nuevas (amigos, campus)
--   resumen-diario             cada hora     10:00 locales de cada persona
--   sugerir-personas           cada hora     18:00 locales, 1 por semana
--   avisos-de-cuenta           cada hora     12:00 locales, 1 cada 3 dias
--   limpiar-notificaciones     04:37         retencion y huellas caducadas
--
-- "avisar-inicio-evento" (20260921010000) se queda como estaba: la funcion
-- que llama ahora encola por notify() en vez de mandar directo.
--
-- ASCII puro. Idempotente: vuelve a programar con el mismo nombre.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
DECLARE
  j text;
BEGIN
  FOREACH j IN ARRAY ARRAY['despachar-notificaciones', 'recordar-eventos', 'recomendar-eventos',
                           'resumen-diario', 'sugerir-personas', 'avisos-de-cuenta', 'limpiar-notificaciones'] LOOP
    BEGIN
      PERFORM cron.unschedule(j);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
END $$;

SELECT cron.schedule('despachar-notificaciones', '* * * * *',   $$SELECT public.kick_notification_dispatch_if_due()$$);
SELECT cron.schedule('recordar-eventos',         '*/5 * * * *', $$SELECT public.notify_upcoming_events()$$);
SELECT cron.schedule('recomendar-eventos',       '*/10 * * * *', $$SELECT public.notify_new_events()$$);
SELECT cron.schedule('resumen-diario',           '3 * * * *',   $$SELECT public.notify_daily_digests()$$);
SELECT cron.schedule('sugerir-personas',         '13 * * * *',  $$SELECT public.notify_people_suggestions()$$);
SELECT cron.schedule('avisos-de-cuenta',         '23 * * * *',  $$SELECT public.notify_account_nudges()$$);
SELECT cron.schedule('limpiar-notificaciones',   '37 4 * * *',  $$SELECT public.purge_old_notifications()$$);

SELECT jobname, schedule FROM cron.job
WHERE jobname IN ('despachar-notificaciones', 'recordar-eventos', 'recomendar-eventos', 'resumen-diario',
                  'sugerir-personas', 'avisos-de-cuenta', 'limpiar-notificaciones', 'avisar-inicio-evento')
ORDER BY jobname;
