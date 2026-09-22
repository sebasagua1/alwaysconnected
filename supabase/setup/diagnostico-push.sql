-- ============================================================
-- ¿Por qué no llegan las notificaciones?
--
-- Se pega entero en el SQL Editor de Supabase y se ejecuta. No cambia
-- nada: solo mira. Recorre la cadena
--
--   trigger → push_send() → pg_net → Edge Function send-push → APNs → iPhone
--
-- y marca OK o FALLA en cada eslabón. El primer FALLA es el que hay que
-- arreglar; los de abajo se apoyan en él.
--
-- Es UNA sola consulta a propósito: el SQL Editor solo enseña el
-- resultado de la última sentencia, así que un script de ocho SELECT
-- deja siete resultados invisibles. Todo sale en la misma tabla.
--
-- Hace falta porque push_send() está envuelta en un EXCEPTION WHEN
-- OTHERS y nunca deja caer un error hacia arriba (a propósito: una push
-- rota no puede tumbar el mensaje que la provocó). El efecto secundario
-- es que, cuando algo se rompe, no pasa nada y no hay dónde mirar.
-- ============================================================

SELECT paso, resultado
FROM (

  -- 1. La extensión pg_net: sin ella la base no sabe hacer HTTP.
  SELECT 1 AS n, '1. pg_net instalada' AS paso,
         CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')
              THEN 'OK'
              ELSE 'FALLA -> Database > Extensions > habilitar pg_net'
         END AS resultado

  UNION ALL
  -- 2. El secreto de Vault. El sospechoso número uno: va en un script
  --    aparte porque lleva la clave dentro y no se versiona en git, así
  --    que es justo el paso que se olvida al montar el proyecto. Si
  --    falta, push_send() escribe un WARNING y vuelve. Nada más.
  SELECT 2, '2. secreto service_role_key en Vault',
         CASE WHEN EXISTS (SELECT 1 FROM vault.decrypted_secrets
                            WHERE name = 'service_role_key'
                              AND coalesce(decrypted_secret, '') <> '')
              THEN 'OK'
              ELSE 'FALLA -> select vault.create_secret(''<service_role_key>'', ''service_role_key'');'
         END

  UNION ALL
  -- 3. La URL está escrita a mano dentro de push_send(). Si el proyecto
  --    se reconstruyó, apunta al anterior y las llamadas se van a un
  --    dominio que ya no existe.
  SELECT 3, '3. URL dentro de push_send()',
         coalesce(
           (SELECT substring(p.prosrc from 'https://[a-z0-9]+\.supabase\.co/functions/v1/send-push')
              FROM pg_proc p
              JOIN pg_namespace ns ON ns.oid = p.pronamespace
             WHERE ns.nspname = 'public' AND p.proname = 'push_send'),
           'FALLA -> push_send() no existe o no contiene la URL')
         || '  (debe coincidir con Settings > API > Project URL)'

  UNION ALL
  -- 4. Los disparadores. La invitación a grupo no está aquí: sale de
  --    dentro de create_group_from_event(), no de un trigger.
  SELECT 4, '4. disparadores push (5 esperados)',
         coalesce(
           'FALLA -> faltan o están deshabilitados: ' ||
           (SELECT string_agg(e.nombre, ', ')
              FROM (VALUES ('trg_join_request_push'), ('trg_approval_push'),
                           ('trg_message_push'), ('trg_friend_request_push'),
                           ('trg_event_repeat_push')) AS e(nombre)
             WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t
                                WHERE t.tgname = e.nombre
                                  AND NOT t.tgisinternal
                                  AND t.tgenabled <> 'D')),
           'OK (los 5 presentes y activos)')

  UNION ALL
  -- 5. Sin ningún token, push_send() ni siquiera hace la llamada HTTP:
  --    el problema estaría en el teléfono (permiso denegado en iOS, o
  --    falta la capability de Push Notifications en Xcode).
  SELECT 5, '5. dispositivos registrados',
         CASE WHEN (SELECT count(*) FROM public.device_tokens) = 0
              THEN 'FALLA -> ningún iPhone dado de alta en device_tokens'
              ELSE 'OK (' || (SELECT count(*) FROM public.device_tokens) || ' token(s), '
                          || (SELECT count(DISTINCT user_id) FROM public.device_tokens) || ' cuenta(s))'
         END

  UNION ALL
  -- 5b. Qué cuenta tiene token y desde cuándo, por si es solo la tuya la
  --     que no lo tiene.
  SELECT 6, '5b. token de ' || coalesce(pr.name, '(sin nombre)'),
         d.platform || ', alta ' || to_char(d.updated_at, 'YYYY-MM-DD HH24:MI')
    FROM public.device_tokens d
    LEFT JOIN public.profiles pr ON pr.id = d.user_id

  UNION ALL
  -- 6. Lo que contestó la Edge Function. pg_net guarda las respuestas
  --    unas horas. Aquí es donde aparece el error de verdad.
  SELECT 7, '6. respuestas de send-push',
         'FALLA -> ninguna llamada registrada. O no se disparó nada, o '
         || 'push_send() corta antes de llamar (mirar pasos 2 y 5)'
   WHERE NOT EXISTS (SELECT 1 FROM net._http_response)

  UNION ALL
  --   401 -> la clave del Vault no la acepta send-push
  --   404 -> la función no está desplegada
  --   500 -> faltan los secretos de APNs (APNS_KEY_ID / TEAM_ID / .p8)
  --   200 con "sent":0 -> APNs rechazó el token (el motivo va en results)
  SELECT 8, '6. respuesta ' || to_char(x.created, 'YYYY-MM-DD HH24:MI'),
         coalesce(x.status_code::text, 'sin código') || ' -> '
         || left(coalesce(nullif(x.content, ''), x.error_msg, '(respuesta vacía)'), 300)
    FROM (SELECT * FROM net._http_response ORDER BY created DESC LIMIT 10) x

  UNION ALL
  -- 7. Muchas peticiones en cola con pocas respuestas arriba = pg_net no
  --    está procesando nada.
  SELECT 9, '7. peticiones en cola sin resolver',
         (SELECT count(*)::text FROM net.http_request_queue)

) t
ORDER BY n, paso DESC;
