# Levantar el backend en un proyecto Supabase nuevo

El proyecto original (creado por Lovable) fue **eliminado** (su dominio da NXDOMAIN),
así que hay que reconstruir el backend en un proyecto **tuyo**. Todo el esquema está
en `full_schema.sql` (consolidado de `../migrations/`).

## Pasos

1. **Crea el proyecto**: supabase.com/dashboard → **New Project**.
   - Elige tu organización, nombre (`Always Connected`), una región cercana y guarda la
     **contraseña de la base** en un lugar seguro.

2. **Reconstruye el esquema**: cuando el proyecto esté listo, **SQL Editor** → pega el
   contenido completo de `full_schema.sql` → **Run**. Crea tablas, RLS, RPCs, triggers,
   sistema de puntos, bucket de avatars y realtime.

3. **Copia las credenciales**: Settings → **API** → toma:
   - **Project URL** (`https://XXXX.supabase.co`)
   - **anon public** key

4. **Repunta la app** con esos valores:
   - Local: `.env` → `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`.
   - Vercel: mismas 3 variables en Settings → Environment Variables → **Redeploy**.

5. **Auth → URL Configuration**:
   - Site URL: `https://alwaysconnected.vercel.app`
   - Redirect URLs: `https://alwaysconnected.vercel.app/**` y `http://localhost:8080/**`

6. *(Opcional)* **Google login en web**: Auth → Providers → Google (Client ID/Secret) y en
   Google Cloud agrega el callback `https://XXXX.supabase.co/auth/v1/callback`.

7. *(Opcional)* **Mapbox edge function**: solo si no usas `VITE_MAPBOX_TOKEN`. Con el token
   en las env vars, el mapa funciona sin la función.

## Edge Functions

Hay dos funciones en `../functions/`. La de borrado de cuenta **es obligatoria**:
sin ella el botón de "Eliminar mi cuenta" falla, y Apple rechaza la app por la
guideline 5.1.1(v).

```bash
supabase functions deploy delete-account
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` ya vienen
inyectadas por Supabase; no hay que configurarlas. Opcionalmente, para acotar el
CORS a tu dominio en vez de `*`:

```bash
supabase secrets set APP_ORIGIN=https://alwaysconnected.vercel.app
```

El token de Mapbox va en `VITE_MAPBOX_TOKEN` y viaja en el bundle: es público
por diseño y se restringe por dominio desde el panel de Mapbox.

## Notificaciones push (iOS)

Es el paso que más se olvida, y cuando falta **no da ningún error**: los avisos
simplemente no llegan. `push_send()` está envuelta en un `EXCEPTION WHEN OTHERS`
para que una push rota no tumbe el mensaje que la provocó, así que un fallo de
configuración es completamente mudo.

Hacen falta las cuatro cosas, y en este orden:

1. **Desplegar la función**:

   ```bash
   supabase functions deploy send-push
   ```

2. **Los secretos de APNs** (Apple Developer → Keys → clave de tipo *Apple Push
   Notifications service*, que se descarga una sola vez como `.p8`):

   ```bash
   supabase secrets set APNS_KEY_ID=XXXXXXXXXX
   supabase secrets set APNS_TEAM_ID=YYYYYYYYYY
   supabase secrets set APNS_BUNDLE_ID=com.alwaysconnected.app
   supabase secrets set APNS_PRIVATE_KEY="$(cat AuthKey_XXXXXXXXXX.p8)"
   ```

   `APNS_BUNDLE_ID` tiene que ser **exactamente** el Bundle ID de la app; si no
   cuadra, APNs responde `TopicDisallowed` y no entrega nada.

3. **La clave de servidor en Vault**, que es de donde la saca la base para
   llamar a la función. Va aparte a propósito: lleva la clave dentro y este
   repositorio está en git.

   ```sql
   select vault.create_secret('<service_role_key>', 'service_role_key');
   ```

   Sin este secreto, `push_send()` escribe un `WARNING` y vuelve sin llamar a
   nadie.

4. **La capacidad en Xcode**: target App → Signing & Capabilities →
   *+ Capability* → **Push Notifications**. Sin ella el iPhone nunca obtiene
   token y `registerPush()` no tiene nada que registrar.

### Cuando no llegan

`diagnostico-push.sql` recorre la cadena entera (pg_net → Vault → disparadores →
tokens → respuestas de la Edge Function) y marca `OK` o `FALLA` en cada eslabón.
Se pega en el SQL Editor y no modifica nada. El primer `FALLA` es la causa.

Las respuestas reales de APNs quedan en dos sitios: en `net._http_response`
(lo que contestó la Edge Function, que es lo que consulta el paso 6 del script)
y en el log de la propia función en el panel de Supabase, donde ahora se
registra cada rechazo de APNs con su motivo.

## Moderación (revisar a diario)

Apple exige actuar sobre el contenido reportado en menos de 24 h. La cola está en
la tabla `reports`; se tría desde el SQL Editor o el Table Editor:

```sql
select r.*, p.name as reported_name
from public.reports r
left join public.profiles p on p.id = r.reported_user_id
where r.status = 'pending'
order by r.created_at;
```

Al resolver, pon `status` en `reviewed`, `actioned` o `dismissed`.

## Nota
`full_schema.sql` es **generado** a partir de `../migrations/`; no se edita a mano.
Cada vez que añadas una migración, regenéralo:

```bash
node scripts/gen-full-schema.mjs
```

Para comprobar si se ha quedado atrás sin reescribirlo (sale con código 1 si lo está):

```bash
node scripts/gen-full-schema.mjs --check
```

Merece la pena hacerlo: este archivo se ensambló a mano una vez y nadie volvió a
tocarlo, así que acabó **diez migraciones por detrás**. Lo malo es que seguía
ejecutándose sin un solo error — simplemente creaba una base sin aislamiento por
institución y con las insignias de todo el mundo a la vista (`USING (true)`).
Un esquema desactualizado no se queja; solo te deja agujeros.

Los datos del proyecto viejo no se recuperan (empiezas limpio).
