import { useEffect, type RefObject } from 'react';

/**
 * Mantiene la lista de un chat a la misma distancia del final cuando cambia
 * de alto: al abrirse el teclado, al cerrarse o al aparecer la franja de
 * «editando». Lo último que se estaba leyendo sigue justo encima de la caja
 * de escribir en vez de quedar tapado.
 *
 * Hace falta también al CRECER, y no solo por comodidad: en el WKWebView de
 * iOS, cuando la lista se alarga (teclado que se cierra) WebKit devuelve al
 * poco el desplazamiento antiguo, que ya queda más allá del final, y debajo
 * del último mensaje aparece un hueco en blanco del alto del teclado. Lo
 * evita pedir el desplazamiento a mano (ver el comentario de abajo).
 *
 * `ready` es para las listas que no existen en el primer render (EventChat
 * pinta antes un estado de carga): al pasar a true se engancha al elemento.
 */
export function useBottomAnchor(listRef: RefObject<HTMLElement>, ready = true) {
  useEffect(() => {
    const el = listRef.current;
    // jsdom no trae ResizeObserver, y en los tests no hay teclado que valga.
    if (!ready || !el || typeof ResizeObserver === 'undefined') return;

    let height = el.clientHeight;
    let gap = 0;
    const readGap = () => {
      // Nunca negativa: el rebote de iOS al llegar al final pasa de largo.
      gap = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
    };
    readGap();

    const observer = new ResizeObserver(() => {
      if (el.clientHeight === height) return;
      height = el.clientHeight;
      const target = el.scrollHeight - el.clientHeight - gap;
      // En dos pasos a propósito. Al crecer la lista el motor ya ha
      // recortado `scrollTop` por su cuenta, así que asignarle ese mismo
      // valor no cambia nada y no se avisa a la capa nativa, que es la que
      // se queda con el desplazamiento viejo. Con un cambio real sí llega.
      // Medido en el simulador (iOS 26.5): sin esto 1420 volvía a 1789.
      el.scrollTop = target - 1;
      el.scrollTop = target;
    });
    observer.observe(el);
    el.addEventListener('scroll', readGap, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', readGap);
    };
  }, [listRef, ready]);
}
