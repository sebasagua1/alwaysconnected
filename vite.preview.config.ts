/**
 * Vista previa de la interfaz con Supabase falseado.
 *
 *     npm run preview:ui
 *
 * Es la config normal con una sola diferencia: `@/integrations/supabase/client`
 * apunta al mock de `scripts/ui-preview/`. La app corre entera —rutas, stores,
 * AuthGate, GSAP, CSS— con sesión ya iniciada y datos de mentira, así que se
 * pueden mirar las pantallas de dentro sin credenciales.
 *
 * Solo para mirar. No sustituye a probar contra un Supabase de verdad.
 */
import { defineConfig, mergeConfig, type UserConfig } from 'vite';
import path from 'path';
import base from './vite.config';

export default defineConfig(async (env) => {
  const resuelta = (typeof base === 'function' ? await base(env) : base) as UserConfig;

  return mergeConfig(resuelta, {
    resolve: {
      alias: [{
        find: /^@\/integrations\/supabase\/client$/,
        replacement: path.resolve(__dirname, './scripts/ui-preview/mock-supabase.ts'),
      }],
    },
    // Con el mock puesto nadie lee las variables de Supabase. La de Mapbox sí
    // se lee, y se inyecta aquí para no tener que crear un .env: el token es
    // inválido a propósito, así que el mapa sale sin cartografía pero con sus
    // marcadores, que son elementos del DOM que pone la app.
    define: {
      'import.meta.env.VITE_MAPBOX_TOKEN': JSON.stringify('pk.vista-previa-sin-cartografia'),
    },
    server: { port: 5199 },
  } satisfies UserConfig);
});
