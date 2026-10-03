# Always Connected — Campus Social App

App web mobile-first (PWA) para comunidades universitarias: descubre, crea
y únete a actividades reales del campus en un mapa en tiempo real, con chats de grupo,
amigos, perfiles, puntos e insignias.

## Stack

React + Vite + TypeScript · Supabase (Postgres + Auth + Realtime) · Zustand ·
shadcn/ui + Tailwind · Mapbox GL · i18next (es/en) · PWA (`vite-plugin-pwa`) · Vercel.

## Puesta en marcha

```bash
npm install
cp .env.example .env   # completa tus claves
npm run dev
```

### Variables de entorno

Ver `.env.example`. Necesitas un proyecto de **Supabase** (URL + anon key) y un token
público de **Mapbox** en `VITE_MAPBOX_TOKEN`.

> El token de Mapbox es público por diseño: viaja en el bundle. Se protege
> restringiéndolo por dominio desde el panel de Mapbox, no escondiéndolo.

> El proyecto usa **npm** (`package-lock.json`). No commitear lockfiles de otros gestores.

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo (Vite) |
| `npm run build` | Typecheck (`tsc --noEmit`) + build de producción |
| `npm run lint` | ESLint |
| `npm test` | Tests (Vitest) |
| `npm run preview` | Sirve el build de producción localmente |

## Estructura

```
src/
  pages/         Rutas: MapHome, MyEvents, Friends, GroupChat, Profile, Auth, Onboarding
  components/    UI (shadcn), layout (AppShell, BottomNav), map/, profile/
  stores/        Zustand: authStore, eventStore
  hooks/         useUserLocation, use-toast
  integrations/  Cliente y tipos de Supabase
  i18n/          Configuración y locales es/en
supabase/
  migrations/    Esquema, RLS, reputación, badges, check-ins, ratings
  functions/     Edge Functions (delete-account)
```

## Despliegue

Vercel. `vercel.json` define el rewrite SPA, cabeceras de seguridad (CSP, X-Frame-Options,
etc.) y caché de assets.
