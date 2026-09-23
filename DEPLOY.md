# Deploy — Always Connected

Guía reproducible para publicar la app. Dos plataformas: **Supabase** (backend) y
**Vercel** (frontend). Requiere que hayas hecho login en ambos CLIs / dashboards.

---

## 1. Supabase (backend)

### 1.1 Linkear el proyecto (una sola vez)
```bash
supabase link --project-ref myarlozvkbebygwszgkf
```

### 1.2 Aplicar migraciones a producción
```bash
supabase db push
```
> **Sin la CLI de Supabase**, que es el caso habitual aquí: abre cada migración
> pendiente de `supabase/migrations/` y pégala en el
> [SQL Editor](https://supabase.com/dashboard/project/myarlozvkbebygwszgkf/sql/new)
> en orden de fecha. Están escritas para tolerar que se ejecuten dos veces.

> Verifica que el alta asigna institución: `select tgname from pg_trigger
> where tgrelid = 'auth.users'::regclass;` debe listar `on_auth_user_created`.

### 1.3 Desplegar la Edge Function y sus secretos
```bash
supabase functions deploy delete-account
supabase secrets set APP_ORIGIN=https://TU-DOMINIO.vercel.app
```
> `APP_ORIGIN` fija el CORS de la función. Sin él usa `*` (menos seguro).
> El token de Mapbox NO va aquí: es público y viaja en el bundle vía
> `VITE_MAPBOX_TOKEN`. Se restringe por dominio desde el panel de Mapbox.

### 1.3 bis Chat de actividad, contactos y notificaciones

Orden de aplicación en el SQL Editor (todas toleran ejecutarse dos veces):

1. `20260916000000_buscar-personas.sql` (si aún no está: la usan la búsqueda
   y las sugerencias).
2. `20260923000000_chat-de-actividad.sql`
3. `20260924000000_contactos-e-invitaciones.sql`
4. `20260925000000_notificaciones.sql` — cambia TODOS los avisos a la cola
   nueva. Hasta desplegar `notify-dispatch` (paso siguiente) los avisos se
   quedan en la bandeja de la app y no salen como push.
5. `20260925010000_programar-notificaciones.sql` (pg_cron).

Funciones y secretos:
```bash
supabase functions deploy notify-dispatch --project-ref myarlozvkbebygwszgkf
supabase functions deploy contacts-match --project-ref myarlozvkbebygwszgkf
# 32+ caracteres aleatorios. NUNCA cambiarlo después: las huellas guardadas
# dejarían de coincidir. Guárdalo también en el Llavero.
supabase secrets set CONTACTS_HMAC_KEY="$(openssl rand -hex 32)" --project-ref myarlozvkbebygwszgkf
```
`notify-dispatch` reutiliza los secretos de APNs de `send-push`
(`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`) y la clave de servidor de
Vault (`service_role_key`) con la que la base la despierta. `send-push` se
queda desplegada: nada la llama ya, pero sirve para pruebas manuales.

Comprobar tras aplicar:
```sql
select jobname, schedule from cron.job order by jobname;
select status, count(*) from public.notification_deliveries group by 1;
select status_code, created from net._http_response order by created desc limit 5;
```

### 1.4 Configurar Auth (Dashboard → Authentication)
- **URL Configuration** → agrega la URL de producción a *Site URL* y *Redirect URLs*
  (ej. `https://TU-DOMINIO.vercel.app`). Sin esto, el login con Google falla en prod.
- **Providers → Google** → activa el proveedor y pega tu Client ID / Secret de Google Cloud.
- (Opcional) **Email** → decide si exiges verificación de correo antes de iniciar sesión.

---

## 2. Vercel (frontend)

### 2.1 Variables de entorno
Project → Settings → Environment Variables (marca *Production* y *Preview*):

| Variable | Valor |
|---|---|
| `VITE_SUPABASE_URL` | `https://myarlozvkbebygwszgkf.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | tu **anon/public** key (nunca la service_role) |
| `VITE_SUPABASE_PROJECT_ID` | `myarlozvkbebygwszgkf` |
| `VITE_MAPBOX_TOKEN` | tu token público de Mapbox (`pk...`) |

### 2.2 Build (Vercel lo detecta solo)
- Build Command: `npm run build`
- Output Directory: `dist`
- `vercel.json` ya define el rewrite SPA, las cabeceras de seguridad (CSP con Supabase +
  Mapbox) y el caché de assets.

### 2.3 Desplegar
Push a `main` (deploy automático) o:
```bash
vercel --prod
```

---

## 3. Verificación post-deploy

- [ ] Registro con un correo **institucional** entra con la institución ya asignada
      y la insignia de verificado; con uno genérico entra sin institución y el
      onboarding pide elegirla.
- [ ] Login con Google funciona (redirect correcto).
- [ ] El mapa carga (token de Mapbox OK, vía env var o edge function).
- [ ] El service worker se registra sin 404 (`/sw.js` existe en el deploy).
- [ ] Realtime: al crear un evento en una pestaña, aparece en otra.

---

## 4. Camino a la App Store (iOS)

La app es una **PWA**; para publicarla en la App Store hay que envolverla en un
contenedor nativo. Ruta recomendada con **Capacitor**:

```bash
npm install @capacitor/core @capacitor/ios
npm install -D @capacitor/cli
npx cap init "Always Connected" com.alwaysconnected.app --web-dir=dist
npm run build && npx cap add ios && npx cap sync
npx cap open ios   # abre Xcode
```
Luego en Xcode: firma con tu cuenta de **Apple Developer Program**, configura íconos y
splash, y sube con **Archive → Distribute App**.
