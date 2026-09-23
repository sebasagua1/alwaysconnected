# Vista previa de la interfaz

```bash
npm run preview:ui      # http://localhost:5199
```

En un entorno sin IPv6 (contenedores, algunas CI) falla con
`EAFNOSUPPORT :::5199`, porque hereda el `host: "::"` de la config normal —le
pasa igual a `npm run dev`—. Se esquiva forzando IPv4:

```bash
npm run preview:ui -- --host 127.0.0.1
```

Levanta la app **entera** —rutas, stores, AuthGate, GSAP, CSS— con el cliente
de Supabase sustituido por un mock. Sirve para mirar las pantallas de dentro
(Mis Eventos, Amigos, chats, notificaciones, el mapa) sin credenciales, sin
tocar datos reales y sin `.env`.

No sustituye a probar contra un Supabase de verdad: aquí solo se comprueba
cómo se ve y cómo se mueve la interfaz.

## Qué hay dentro

| Archivo | Para qué |
|---|---|
| `mock-supabase.ts` | El cliente falso: tablas, RPC, tiempo real y sesión |
| `../../vite.preview.config.ts` | La config normal con el alias al mock |

La sesión ya viene iniciada. Para ver el onboarding: `/?onboarding=1`.

## Rutas útiles

```
/                         mapa (marcadores sí, cartografía no)
/events                   mis eventos
/friends                  amigos, grupos y ranking
/friends/find             buscar amigos
/notifications            centro de notificaciones
/groups/g1                chat de grupo
```

## Inyectar un mensaje entrante

Los chats registran sus callbacks de tiempo real, así que desde la consola del
navegador se puede simular que llega un mensaje:

```js
__entra('un mensaje de otra persona')
__entra('un mensaje mío', true)
```

Es la única forma de comprobar que un mensaje ajeno **no** arranca de la
lectura a quien va desplazándose hacia arriba, y que uno propio **sí** baja.

## Cuatro trampas al ampliar el mock

Descubiertas a base de perseguir fallos que resultaron ser del mock y no de la
app. Ante una pantalla vacía o un dato raro, sospechar primero de aquí.

1. **`rpc()` devuelve un builder encadenable, no una promesa.**
   `usePeopleSearch` le cuelga `.abortSignal()` para cancelar la búsqueda
   anterior. Con una promesa pelada revienta con *"abortSignal is not a
   function"* y la lista se queda vacía.

2. **`order()` y `limit()` hay que implementarlos.** `GroupChat` pide los
   últimos 40 en orden descendente y luego les da la vuelta. Ignorándolos, el
   chat se pinta al revés y parece un fallo de la app.

3. **Los nombres de campo son los que lee el código, no los que uno supone.**
   `friends_page` manda `total` en cada fila (sin él la cabecera pinta `NaN`),
   las solicitudes usan `friendship_id` (sin él React avisa de keys
   duplicadas) y el contador del centro de avisos lee `notifications_unread`.

4. **El perfil usa `campus_id`, no `institution_id`.** Con el campo mal, el
   mapa centra en el punto de respaldo y los marcadores quedan fuera de cuadro.

## Capturas y vídeo

Chromium y Playwright están disponibles en los contenedores de desarrollo:

```js
import { chromium, devices } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
// viewport de iPhone 13 = 390x664, NO 390x844
const ctx = await b.newContext({
  ...devices['iPhone 13'],
  recordVideo: { dir: 'video', size: { width: 390, height: 664 } },
});
```

Para medir si una animación corre de verdad, hay que muestrear desde el primer
fotograma con `addInitScript`: mirar la opacidad después de `networkidle` llega
tarde y siempre da 1, parezca que anima o no.

Para el mapa sin token, interceptar `**api.mapbox.com/**` y servir un estilo GL
mínimo (una capa `background`, sin fuentes ni teselas). Los marcadores son
elementos del DOM que pone la app, así que se ven igual.
