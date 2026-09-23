import { useEffect, useState } from 'react';

export interface VisibleArea {
  /** Cuánto tapa el teclado por abajo, en px (0 si está cerrado). */
  keyboard: number;
  /** Alto y posición de lo que de verdad se ve (el visualViewport). */
  height: number;
  top: number;
}

/**
 * El área visible de la pantalla, teclado incluido.
 *
 * En el WKWebView de iOS el teclado no encoge la página: encoge el
 * `visualViewport`, y `100dvh` sigue midiendo la pantalla entera. Un chat
 * que se apoya solo en `h-screen-nav` deja la caja de escribir DETRÁS del
 * teclado y confía en que iOS desplace la página para enseñarla, que es lo
 * que hace saltar la cabecera fuera de la vista. Con estas medidas el chat
 * se coloca exactamente sobre lo visible.
 *
 * Se considera teclado a partir de 120 px: por debajo son la barra de
 * dirección de Safari o la de sugerencias, que no merecen recolocar nada.
 */
export function useKeyboardInset(): VisibleArea {
  const [area, setArea] = useState<VisibleArea>({ keyboard: 0, height: 0, top: 0 });

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const hidden = Math.max(0, window.innerHeight - vv.height);
        setArea({
          keyboard: hidden >= 120 ? Math.round(hidden) : 0,
          height: Math.round(vv.height),
          top: Math.round(vv.offsetTop),
        });
      });
    };
    measure();
    vv.addEventListener('resize', measure);
    vv.addEventListener('scroll', measure);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener('resize', measure);
      vv.removeEventListener('scroll', measure);
    };
  }, []);

  return area;
}
