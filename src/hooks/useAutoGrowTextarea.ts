import { useLayoutEffect, type RefObject } from 'react';

/** Alto máximo del campo de escribir de los chats, en px: unas cinco líneas. */
export const COMPOSER_MAX_HEIGHT = 132;

/**
 * Un <textarea> que crece con lo que se escribe, hasta un tope.
 *
 * Un textarea no crece solo: con `rows={1}` se queda en una línea y el
 * resto se desplaza por dentro. Aquí se mide el contenido cada vez que
 * cambia el texto y se le da ese alto; pasado el tope deja de crecer y
 * vuelve a desplazarse por dentro.
 *
 * Primero a `auto` y luego al alto medido: sin ese paso el campo solo
 * crecería, y al borrar texto no volvería a encoger.
 *
 * Ese paso tiene un coste, y para eso está `scrollerRef` (la lista de
 * mensajes que hay encima). Mientras se mide, el campo vuelve por un
 * instante a una línea, la lista se estira para ocupar el hueco y el
 * navegador le recorta el desplazamiento; cuando el campo recupera su alto,
 * la lista ya no vuelve donde estaba y el último mensaje queda tapado por el
 * propio campo, un poco más con cada línea. Se apunta la distancia al final
 * antes de medir y se repone después, todo antes de que se pinte nada.
 */
export function useAutoGrowTextarea(
  ref: RefObject<HTMLTextAreaElement>,
  value: string,
  scrollerRef?: RefObject<HTMLElement>,
  maxHeight: number = COMPOSER_MAX_HEIGHT,
) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = scrollerRef?.current ?? null;
    const gap = scroller ? Math.max(0, scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) : 0;

    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;

    if (scroller) {
      const top = scroller.scrollHeight - scroller.clientHeight - gap;
      if (Math.abs(scroller.scrollTop - top) >= 1) scroller.scrollTop = top;
    }
  }, [ref, value, scrollerRef, maxHeight]);
}
