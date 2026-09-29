import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigationType, type NavigationType } from 'react-router-dom';
import { useBootSplash } from '@/lib/bootSplash';
import { clearCrossfadeNavigation, isCrossfadeNavigation } from '@/lib/viewTransition';

/**
 * Transición entre pantallas.
 *
 * Tres movimientos, según lo que esté pasando:
 *   · Entre pestañas → fundido. Es lo que hace iOS: las pestañas son sitios
 *     paralelos, no un camino, así que deslizarlas sugeriría una dirección
 *     que no existe.
 *   · Al abrir un detalle (el chat) → entra desde la derecha.
 *   · Al volver atrás → entra desde la izquierda.
 *
 * El fundido no lleva transform a propósito (ver el comentario de index.css):
 * la app tiene siete hojas y modales `position: fixed`, y un transform en un
 * ancestro los dejaría posicionados contra este contenedor, que no tiene alto
 * propio. Por eso el único caso con transform es el deslizamiento, y la clase
 * se quita en cuanto termina.
 */

/** Las cuatro pestañas de la barra inferior. */
const TAB_PATHS = new Set(['/', '/events', '/friends', '/profile']);

type Variant = 'fade' | 'forward' | 'back' | 'none';

const CLASS_FOR: Record<Variant, string | undefined> = {
  fade: 'animate-page-fade',
  forward: 'animate-page-forward',
  back: 'animate-page-back',
  none: undefined,
};

/**
 * Último toque que empezó pegado al borde izquierdo.
 *
 * Con el gesto nativo de volver (AppViewController), iOS ya anima la vuelta
 * arrastrando la pantalla anterior con el dedo. Si además entrase la
 * animación de «atrás» de aquí, la pantalla se deslizaría dos veces. No hay
 * forma de que el webview diga que un POP vino del gesto, así que se deduce:
 * un POP poco después de un toque en el borde es el gesto.
 */
let lastEdgeTouch = 0;
if (typeof window !== 'undefined') {
  window.addEventListener(
    'touchstart',
    (e) => {
      const x = e.touches[0]?.clientX;
      if (x !== undefined && x < 24) lastEdgeTouch = Date.now();
    },
    { passive: true, capture: true },
  );
}

function pickVariant(
  pathname: string,
  navigationType: NavigationType,
  isFirstRender: boolean,
): Variant {
  // Al abrir la app el tipo de navegación ya es 'POP'. Sin esta salida, lo
  // primero que se ve es un deslizamiento hacia atrás desde una pantalla
  // que no existió nunca. Y si la pantalla de entrada sigue puesta, ningún
  // movimiento: el fundido ya lo hace ella al irse, y dos a la vez dejan ver
  // el fondo a mitad de camino.
  if (isFirstRender) return useBootSplash.getState().visible ? 'none' : 'fade';
  // El fundido cruzado de la barra de pestañas ya lo hace el navegador (ver
  // lib/viewTransition.ts); otro encima dejaría ver el fondo a mitad.
  if (isCrossfadeNavigation(pathname)) return 'none';
  if (navigationType === 'POP') return Date.now() - lastEdgeTouch < 1500 ? 'none' : 'back';
  return TAB_PATHS.has(pathname) ? 'fade' : 'forward';
}

export function PageTransition() {
  const location = useLocation();
  const navigationType = useNavigationType();

  const firstRender = useRef(true);
  useEffect(() => {
    firstRender.current = false;
  }, []);
  useEffect(() => {
    clearCrossfadeNavigation();
  }, [location.pathname]);

  return (
    // key: cada ruta monta su propio contenedor, así que la animación
    // arranca sola en cada navegación sin necesidad de efectos.
    <AnimatedPage
      key={location.pathname}
      variant={pickVariant(location.pathname, navigationType, firstRender.current)}
    >
      <Outlet />
    </AnimatedPage>
  );
}

function AnimatedPage({ variant, children }: { variant: Variant; children: ReactNode }) {
  const [animating, setAnimating] = useState(variant !== 'none');

  return (
    <div
      className={animating ? CLASS_FOR[variant] : undefined}
      onAnimationEnd={(e) => {
        // Solo la animación de ESTE div. Sin la comprobación, cualquier
        // animación de dentro —una hoja que sube, un globo que aparece—
        // quitaría la clase antes de tiempo al burbujear, y con ella el
        // transform a mitad de camino.
        if (e.target === e.currentTarget) setAnimating(false);
      }}
    >
      {children}
    </div>
  );
}
