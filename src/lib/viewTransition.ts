import { flushSync } from 'react-dom';

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

/** PageTransition lo llama al terminar de montar: la marca solo vale para esta navegación. */
export function clearCrossfadeNavigation(): void {
  crossfadeTarget = null;
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
 * `flushSync` hace que React pinte la pantalla nueva DENTRO del callback: la
 * API toma la foto del estado nuevo en cuanto el callback termina, y sin él
 * la foto saldría con la pantalla vieja todavía puesta.
 */
export function crossfadeTo(pathname: string, navigate: () => void): void {
  if (!canCrossfade()) {
    navigate();
    return;
  }
  document.startViewTransition(() => {
    crossfadeTarget = pathname;
    flushSync(navigate);
  });
}
