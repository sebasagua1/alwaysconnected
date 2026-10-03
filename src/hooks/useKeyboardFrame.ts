import { useEffect, type CSSProperties, type RefObject } from 'react';
import { useKeyboardInset } from '@/hooks/useKeyboardInset';

/**
 * Hojas y pantallas `fixed` con campos de texto: que el teclado no las
 * descoloque.
 *
 * En el WKWebView el teclado no encoge la página, así que un `fixed inset-0`
 * sigue midiendo la pantalla entera con medio formulario detrás del teclado.
 * Para enseñar el campo, iOS desplaza la página: la cabecera (con su X) se
 * sale por arriba o se monta sobre la hora del sistema, y el botón de
 * guardar se queda tapado hasta que se cierra el teclado.
 *
 * Con el teclado abierto, `frameStyle` coloca el contenedor sobre lo que se
 * ve (el visualViewport) MÁS la franja que tapa el teclado, y `keyboardPad`
 * es el relleno inferior que mantiene el contenido fuera de esa franja: la
 * cabecera vuelve a estar arriba, el pie queda justo encima del teclado y lo
 * de en medio se desplaza.
 *
 * La franja de debajo no es un detalle: el teclado de iOS 26 es translúcido.
 * Si el contenedor acabara donde empieza el teclado, a través de él se vería
 * la pantalla de detrás (el botón «Crear evento» del mapa se veía así). Con
 * la franja, lo que se trasluce es el fondo de la propia hoja.
 *
 * Solo hasta donde WebKit deja: un `fixed` no se pinta por debajo del borde
 * inferior de la página, y la página está subida lo que iOS la desplazó
 * (`visible.top`). Con el campo arriba del formulario casi no se desplaza y
 * la franja cubre todo el teclado; con el campo abajo del todo no cubre
 * nada, y detrás del teclado se sigue adivinando la pantalla de debajo,
 * como antes de este hook. Medido en iOS 26.5: página 874, desplazada 228,
 * la hoja se pinta hasta 646.
 *
 * `sheetStyle` es para una hoja que cuelga del borde inferior de ese
 * contenedor: mientras se escribe ocupa todo lo visible, con su cabecera
 * por debajo de la hora del sistema. A pantalla completa y no «casi»,
 * porque iOS también desplaza lo que hay detrás, y por la rendija de arriba
 * se veía el texto de la pantalla de debajo montado sobre la hora.
 *
 * Al encogerse, el campo en el que se escribe puede quedar fuera de la parte
 * visible de su lista: si se pasa `scrollRef`, se desplaza ESA lista (no la
 * página) lo justo para que se vea, también al saltar de un campo a otro.
 */
export function useKeyboardFrame<T extends HTMLElement>(scrollRef?: RefObject<T>) {
  const visible = useKeyboardInset();
  const keyboardOpen = visible.keyboard > 0 && visible.height > 0;

  useEffect(() => {
    const scroller = scrollRef?.current;
    if (!keyboardOpen || !scroller) return;
    const reveal = () => {
      const field = document.activeElement;
      if (!(field instanceof HTMLElement) || !scroller.contains(field)) return;
      const s = scroller.getBoundingClientRect();
      const f = field.getBoundingClientRect();
      const next = scrollTopToReveal({ top: s.top, bottom: s.bottom, scrollTop: scroller.scrollTop }, f);
      if (next !== scroller.scrollTop) scroller.scrollTop = next;
    };
    // Un frame después: para entonces el contenedor ya tiene su alto nuevo.
    const frame = requestAnimationFrame(reveal);
    scroller.addEventListener('focusin', reveal);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('focusin', reveal);
    };
  }, [keyboardOpen, visible.height, visible.top, scrollRef]);

  const keyboardPad = keyboardOpen ? visible.keyboard : 0;
  const frameStyle: CSSProperties | undefined = keyboardOpen
    ? { top: visible.top, height: visible.height + visible.keyboard, bottom: 'auto' }
    : undefined;
  const sheetStyle: CSSProperties | undefined = keyboardOpen
    ? {
        height: '100%',
        maxHeight: '100%',
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingBottom: keyboardPad,
        // Pegada al borde de la pantalla, las esquinas redondeadas dejarían
        // ver el fondo por detrás.
        borderTopLeftRadius: 0,
        borderTopRightRadius: 0,
      }
    : undefined;
  return { keyboardOpen, keyboardPad, frameStyle, sheetStyle };
}

/** Aire que se deja entre el campo y el borde de la lista. */
const MARGIN = 16;

/**
 * El `scrollTop` que deja un campo a la vista dentro de su lista. Si ya se
 * ve entero, devuelve el que había: no se mueve nada sin motivo.
 */
export function scrollTopToReveal(
  scroller: { top: number; bottom: number; scrollTop: number },
  field: { top: number; bottom: number },
  margin: number = MARGIN,
): number {
  const above = scroller.top + margin - field.top;
  // Si asoma por arriba, o no cabe entero, manda el principio del campo: es
  // donde está lo que se acaba de tocar.
  if (above > 0 || field.bottom - field.top > scroller.bottom - scroller.top - 2 * margin) {
    return Math.max(0, scroller.scrollTop - above);
  }
  const below = field.bottom - (scroller.bottom - margin);
  if (below > 0) return scroller.scrollTop + below;
  return scroller.scrollTop;
}
