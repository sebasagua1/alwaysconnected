-- ============================================================
-- ¿Por qué no llegan las notificaciones?
--
-- Se pega entero en el SQL Editor de Supabase y se ejecuta. No cambia
-- nada: solo mira. Cada fila es un eslabón de la cadena
--
--   trigger → push_send() → pg_net → Edge Function send-push → APNs → iPhone
--
-- y dice OK o FALLA. El primero que salga FALLA es el que hay que
-- arreglar; los de abajo se apoyan en él.
--
-- Existe porque push_send() está envuelta en un EXCEPTION WHEN OTHERS y
-- nunca deja caer un error hacia arriba (a propósito: una push rota no
-- puede tumbar el mensaje que la provocó). El efecto secundario es que,
-- cuando algo se rompe, no pasa absolutamente nada y no hay dónde mirar.
-- ============================================================

-- ------------------------------------------------------------
-- 1. La extensión pg_net: sin ella la base no sabe hacer HTTP.
-- ------------------------------------------------------------
SELECT '1. pg_net instalada' AS comprobacion,
       CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')
            THEN 'OK'
            ELSE 'FALLA -> Database > Extensions > habilitar pg_net'
       END AS resultado;

-- ------------------------------------------------------------
-- 2. El secreto de Vault. Es el sospechoso número uno: va en un script
--    aparte porque lleva la clave dentro y no se versiona en git (ver el
--    encabezado de 20260827000000_push-triggers.sql), así que es
--    justamente el paso que se olvida al montar el proyecto.
--
--    Si falta, push_send() escribe un WARNING y vuelve. Nada más.
-- ------------------------------------------------------------
SELECT '2. secreto service_role_key en Vault' AS comprobacion,
       CASE WHEN EXISTS (SELECT 1 FROM vault.decrypted_secrets
                          WHERE name = 'service_role_key'
                            AND coalesce(decrypted_secret, '') <> '')
            THEN 'OK'
            ELSE 'FALLA -> select vault.create_secret(''<service_role_key>'', ''service_role_key'');'
       END AS resultado;

-- ------------------------------------------------------------
-- 3. La URL que push_send() llama tiene que ser la de ESTE proyecto.
--    Está escrita a mano dentro de la función: si el proyecto se
--    reconstruyó (ver README de esta carpeta), apunta al anterior y las
--    llamadas se van a un dominio que ya no existe. Esta consulta saca la
--    URL y el ref del proyecto actual para compararlos de un vistazo.
-- ------------------------------------------------------------
SELECT '3. URL dentro de push_send()' AS comprobacion,
       coalesce(
         substring(p.prosrc from 'https://[a-z0-9]+\.supabase\.co/functions/v1/send-push'),
         'FALLA -> push_send() no contiene ninguna URL de send-push'
       ) AS resultado,
       'debe coincidir con el Project URL de Settings > API' AS nota
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'push_send';

-- ------------------------------------------------------------
-- 4. Los disparadores. Deben salir los cinco y ninguno deshabilitado.
--    (La invitación a grupo no es un trigger: sale de dentro de
--    create_group_from_event(), así que no aparece en esta lista.)
-- ------------------------------------------------------------
WITH esperados(nombre) AS (
  VALUES ('trg_join_request_push'), ('trg_approval_push'),
         ('trg_message_push'), ('trg_friend_request_push'),
         ('trg_event_repeat_push')
)
SELECT '4. disparador ' || e.nombre AS comprobacion,
       CASE WHEN t.tgname IS NULL  THEN 'FALLA -> no existe; vuelve a aplicar las migraciones'
            WHEN t.tgenabled = 'D' THEN 'FALLA -> existe pero está DESHABILITADO'
            ELSE 'OK'
       END AS resultado
FROM esperados e
LEFT JOIN pg_trigger t ON t.tgname = e.nombre AND NOT t.tgisinternal
ORDER BY 1;

-- ------------------------------------------------------------
-- 5. Dispositivos registrados. Si está a cero, el problema es del lado
--    de la app (permiso denegado en iOS, o el token nunca llegó a
--    register_device_token) y no del servidor: push_send() ni siquiera
--    hace la llamada HTTP cuando no hay ningún token.
-- ------------------------------------------------------------
SELECT '5. dispositivos registrados' AS comprobacion,
       CASE WHEN count(*) = 0
            THEN 'FALLA -> ningún iPhone dado de alta; mirar el log de la app'
            ELSE 'OK (' || count(*) || ' token(s), ' || count(DISTINCT user_id) || ' cuenta(s))'
       END AS resultado
FROM public.device_tokens;

-- Detalle por cuenta, para ver si es solo la tuya la que no tiene token.
SELECT p.name, d.platform, d.created_at, d.updated_at
FROM public.device_tokens d
LEFT JOIN public.profiles p ON p.id = d.user_id
ORDER BY d.updated_at DESC
LIMIT 20;

-- ------------------------------------------------------------
-- 6. Qué contestó la Edge Function en las últimas llamadas.
--
-- pg_net guarda las respuestas en net._http_response durante unas horas.
-- Aquí es donde aparece el error de verdad:
--   401  -> la clave del Vault no la acepta send-push
--   500  -> faltan los secretos de APNs (APNS_KEY_ID / TEAM_ID / .p8)
--   404  -> la función no está desplegada
--   200 con "sent": 0 -> APNs rechazó el token (el motivo va en results)
-- ------------------------------------------------------------
SELECT created         AS cuando,
       status_code     AS codigo,
       left(content, 500) AS respuesta
FROM   net._http_response
ORDER  BY created DESC
LIMIT  20;

-- ------------------------------------------------------------
-- 7. Llamadas encoladas que nunca se resolvieron. Muchas filas aquí con
--    pocas respuestas arriba = pg_net no está procesando la cola.
-- ------------------------------------------------------------
SELECT count(*) AS peticiones_en_cola FROM net.http_request_queue;
