-- ============================================================
-- Programar el aviso de "ya empezo el evento".
--
-- Va en su propio script por lo mismo que 20260825010000 y 20260920010000:
-- el SQL Editor ejecuta cada uno dentro de una transaccion, y si
-- CREATE EXTENSION pg_cron fallara se llevaria por delante la columna, el
-- indice y la funcion de 20260921000000, que es lo que de verdad importa.
--
-- Cada 5 minutos, no cada minuto: el aviso llega entre 0 y 5 minutos
-- despues de la hora de inicio, que para un evento de 2 horas (la mediana
-- medida) no se nota, y son 288 pasadas al dia en vez de 1440. La consulta
-- ademas va por indice parcial sobre los no avisados, asi que cuando no
-- hay nada que hacer no cuesta nada.
--
-- Si esto falla no pasa nada grave: la funcion esta puesta y se puede
-- llamar a mano, o programar desde Database > Cron Jobs en el panel.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- unschedule falla si el trabajo no existe, de ahi el envoltorio.
DO $$
BEGIN
  PERFORM cron.unschedule('avisar-inicio-evento');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'avisar-inicio-evento',
  '*/5 * * * *',
  $$SELECT public.notify_started_events()$$
);

-- Comprobacion: debe salir una fila con el horario.
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'avisar-inicio-evento';
