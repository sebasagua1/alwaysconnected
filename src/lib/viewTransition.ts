/**
 * Fundido cruzado de verdad entre pestañas, con la API de View Transitions.
 *
 * Antes la pantalla de la que se salía desaparecía de golpe y la nueva
 * entraba desde transparente sobre el fondo vacío: medido en el simulador,
 * un salto seguido de un aparecer. Ahora el navegador hace una foto de la
 * pantalla vieja (mapa incluido, que es un canvas y no se puede clonar) y la
 * funde con la nueva, sin ningún fotograma vacío entre las dos. En Chromium,
 * con la misma build, el fundido va a 17 ms por fotograma y React tarda 6-8
 * ms en montar la pestaña; el simulador de iOS pierde fotogramas al
 * componerlo (su GPU es emulada), así que la fluidez real se mira en un
 * iPhone.
 *
 * Solo donde existe (Safari/iOS 18 en adelante) y sin «Reducir movimiento».
 * En el resto, la navegación de siempre con el fundido de PageTransition.
 */

/** La ruta a la que se está entrando con fundido cruzado, para que PageTransition no añada el suyo. */
let crossfadeTarget: string | null = null;

export function isCrossfadeNavigation(pathname: string): boolean {
  return crossfadeTarget === pathname;
}

/** Hasta cuánto se espera a que React monte la pantalla nueva antes de renunciar al fundido. */
const COMMIT_CAP_MS = 500;

/** La navegación en curso que espera a que React la monte. */
let pendingCommit: { pathname: string; done: () => void } | null = null;

/**
 * PageTransition lo llama en cuanto la ruta nueva está en el DOM (en un
 * layout effect, antes de pintar). Suelta la espera de crossfadeTo y borra
 * la marca: solo vale para esta navegación.
 */
export function notifyRouteCommitted(pathname: string): void {
  crossfadeTarget = null;
  if (pendingCommit?.pathname === pathname) {
    pendingCommit.done();
    pendingCommit = null;
  }
}

function canCrossfade(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof document.startViewTransition === 'function' &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Navega a `pathname` con fundido cruzado si se puede.
 *
 * El navegador hace la foto de la pantalla nueva cuando se resuelve la
 * promesa que devuelve el callback, así que esa promesa espera a que React
 * haya montado la ruta. No vale con `flushSync`: el BrowserRouter de React
 * Router 7 aplica cada cambio de ruta como una transición de React, que
 * `flushSync` no adelanta. Con él, la foto «nueva» salía con el mapa aún
 * puesto: se fundía mapa con mapa (invisible) y la pantalla cambiaba de
 * golpe al final, medio segundo después del toque. Medido en el simulador.
 *
 * Mientras espera, el navegador deja congelada la pantalla vieja. Si React
 * tarda más de COMMIT_CAP_MS (la pantalla aún no había bajado, por ejemplo),
 * se renuncia al fundido y la pantalla nueva sale en cuanto esté, como sin
 * View Transitions.
 */
export function crossfadeTo(pathname: string, navigate: () => void): void {
  if (!canCrossfade()) {
    navigate();
    return;
  }
  let gaveUp = false;
  const vt = document.startViewTransition(
    () =>
      new Promise<void>((resolve) => {
        crossfadeTarget = pathname;
        pendingCommit = { pathname, done: resolve };
        navigate();
        setTimeout(() => {
          if (pendingCommit?.pathname !== pathname) return;
          pendingCommit = null;
          gaveUp = true;
          resolve();
        }, COMMIT_CAP_MS);
      }),
  );
  vt.updateCallbackDone.then(() => {
    if (gaveUp) vt.skipTransition();
  });
  // Saltarse el fundido rechaza estas promesas; no es un error de nadie.
  vt.ready.catch(() => undefined);
  vt.finished.catch(() => undefined);
}
