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

### 1.4 Configurar Auth (Dashboard → Authentication)
- **URL Configuration** → agrega la URL de producción a *Site URL* y *Redirect URLs*
  (ej. `https://TU-DOMINIO.vercel.app`). Sin esto, el login con Google falla en prod.
- **Providers → Google** → activa el proveedor y pega tu Client ID / Secret de Google Cloud.
- **Providers → Email → «Confirm email» = ON. OBLIGATORIO.** No es una decisión de
  comodidad: es el único eslabón que sostiene toda la verificación institucional.
  `my_email_university()` exige `email_confirmed_at IS NOT NULL`, pero si «Confirm
  email» está apagado Supabase rellena esa columna **en el momento del alta, sin
  comprobar nada**, y la base no puede distinguir los dos casos. Con el ajuste
  apagado, cualquiera se registra con `a01999999@tec.mx` —una dirección real que no
  es suya— y sale con `institution_verified = true`, matrícula deducida y campus
  asignado. La insignia de verificado, que es la señal de confianza del producto
  entero, deja de significar nada.
  [Abrir el panel](https://supabase.com/dashboard/project/myarlozvkbebygwszgkf/auth/providers)

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

- [ ] **«Confirm email» sigue en ON** ([Authentication → Providers → Email](https://supabase.com/dashboard/project/myarlozvkbebygwszgkf/auth/providers)).
      Va el primero de la lista porque de él cuelga toda la verificación institucional
      (§1.4). Si alguien lo apaga, nada falla de forma visible: la insignia sigue
      apareciendo, solo que ya no verifica nada. Auditar las cuentas que entraron por
      esa vía:
      ```sql
      select a.user_id, a.verification_method, a.verified_at, au.email_confirmed_at
      from   public.profile_affiliations a
      join   auth.users au on au.id = a.user_id
      where  a.status = 'verified'
        and  a.verification_method in ('auth_email_domain', 'legacy_auth_email')
      order  by a.verified_at;
      ```
      Si `email_confirmed_at` coincide con el alta al segundo, esa cuenta se registró
      con la confirmación desactivada.
- [ ] Registro con un correo **institucional** entra con la institución ya asignada
      y la insignia de verificado; con uno genérico entra sin institución y el
      onboarding pide elegirla.
- [ ] Login con Google funciona (redirect correcto).
- [ ] El mapa carga (token de Mapbox OK, vía env var o edge function).
- [ ] El service worker se registra sin 404 (`/sw.js` existe en el deploy).
- [ ] Realtime: al crear un evento en una pestaña, aparece en otra.

---

## 4. Camino a la App Store (iOS)

La carpeta `ios/` **ya está en el repositorio** con Capacitor configurado: sus
capacidades, entitlements y número de build están versionados. No hay nada que
generar.

```bash
npm run ios:sync   # build web + npx cap sync ios
npm run ios:open   # abre Xcode
```
Luego en Xcode: firma con tu cuenta de **Apple Developer Program** y sube con
**Archive → Distribute App**.

> `npx cap add ios` **no** se corre: regeneraría el proyecto desde cero y borraría la
> configuración nativa commiteada. La guía completa, con los pasos de App Store
> Connect, está en [APP_STORE.md](APP_STORE.md).

---

## 5. Operación: respaldos, vigilancia y riesgos conocidos

La auditoría del 2026-09-18 señaló que no había nada escrito sobre esto (OPS-01).
Lo que sigue es el estado real, no un plan.

### 5.1 Respaldos

Supabase hace respaldos automáticos según el plan del proyecto:
[Database → Backups](https://supabase.com/dashboard/project/myarlozvkbebygwszgkf/database/backups).

- [ ] Comprobar **qué política tiene el proyecto hoy** (frecuencia y retención).
      En los planes gratuitos puede no haber ninguno, o solo del último día.
- [ ] **Probar una restauración de verdad, una vez.** Un respaldo que nadie ha
      restaurado nunca es una suposición, no un respaldo. La forma barata de
      probarlo: restaurar sobre un proyecto NUEVO, no sobre producción.
- [ ] Anotar aquí la fecha de la última restauración probada: _(nunca)_

Además, el esquema entero vive en el repositorio (`supabase/setup/full_schema.sql`,
regenerado y verificado por CI), así que una base vacía se puede reconstruir aunque
no haya respaldo. Lo que no se reconstruye son **los datos**.

### 5.2 Qué falla en silencio

Tres cosas degradan sin romperse, que es justo lo que las hace peligrosas:

| Qué | Cómo se manifiesta | Cómo se comprueba |
|---|---|---|
| Falta un secreto en Vault | `push_send()` hace `RAISE WARNING` y sigue. Las notificaciones dejan de llegar y nada avisa. | `select name from vault.secrets;` → deben estar `service_role_key` e `institution_email_pepper` |
| `pg_cron` no está o el trabajo no corre | Los mensajes no caducan y la base crece sin límite | `select jobname, schedule, active from cron.job;` |
| «Confirm email» apagado | La verificación institucional sigue dando la insignia sin verificar nada (§1.4) | [Authentication → Providers](https://supabase.com/dashboard/project/myarlozvkbebygwszgkf/auth/providers) |

No hay monitoreo de errores en el cliente ni en las Edge Functions. `ErrorBoundary`
existe y está probado, pero solo pinta: nadie se entera de los fallos salvo que
alguien los cuente. Poner Sentry (o equivalente) en el cliente y en las tres Edge
Functions sigue pendiente; el coste de no tenerlo sube con cada usuario.

### 5.3 Riesgo conocido y aceptado: los DELETE de Realtime

Supabase documenta que **la RLS no se aplica a los eventos `DELETE` de
`postgres_changes`**: la clave primaria de la fila borrada se reparte a todos los
suscriptores del canal. La app se suscribe a `events`, `messages` y
`event_participants` sin filtro.

No hay fallo funcional —el cliente ignora los ids que no tiene, y `MapHome.tsx` lo
comenta explícitamente— pero cualquier usuario autenticado recibe los UUID de
eventos y mensajes borrados de **todas** las instituciones. Un UUID suelto vale poco;
permite estimar volumen de actividad ajena y poco más.

Se acepta a sabiendas. Cerrarlo del todo implica cambiar `postgres_changes` por
Broadcast sobre `realtime.messages` —que sí tiene RLS y ya está preparado desde la
migración `20260518070740`—, y eso es una reescritura de las tres suscripciones. Toca
antes de abrir la app a varias universidades, no antes del próximo lanzamiento.
