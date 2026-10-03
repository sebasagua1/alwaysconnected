/**
 * Tocar la pestaña en la que ya estás sube al principio, como en iOS.
 *
 * Casi todas las pantallas desplazan la ventana. La lista del mapa no: vive
 * en un contenedor con su propio scroll (el mapa ocupa la pantalla entera
 * debajo), y subir la ventana no le hacía nada. Quien tenga un contenedor
 * así lo marca con `data-tab-scroller`. Con un atributo y no con un ref
 * porque la barra vive en el AppShell y la pantalla en otra rama del árbol:
 * es el mismo trato que `data-tour`.
 */
export function scrollActiveTabToTop(): void {
  window.scrollTo({ top: 0, behavior: 'smooth' });
  document.querySelectorAll<HTMLElement>('[data-tab-scroller]').forEach((el) => {
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: 0, behavior: 'smooth' });
    else el.scrollTop = 0;
  });
}
