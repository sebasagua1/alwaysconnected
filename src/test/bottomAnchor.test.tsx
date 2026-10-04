/**
 * La lista de un chat conserva su distancia al final cuando cambia de alto
 * (teclado, campo de escribir que crece o encoge).
 *
 * Lo que se fija: lo que se estaba leyendo sigue encima del campo, y un
 * mensaje que entra a la vez que la lista cambia de alto —enviar un borrador
 * de varias líneas— no se queda fuera de la vista.
 *
 * jsdom no maqueta ni trae ResizeObserver: la lista y el observer son de
 * mentira, y los eventos se disparan a mano en el orden en que los reparte
 * el navegador (primero scroll, luego el observer).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useBottomAnchor } from '@/hooks/useBottomAnchor';

let alCambiarDeAlto: (() => void) | null = null;

function lista(scrollHeight: number, clientHeight: number) {
  const el = document.createElement('div');
  const medidas = { scrollHeight, clientHeight, scrollTop: 0 };
  const max = () => medidas.scrollHeight - medidas.clientHeight;
  Object.defineProperties(el, {
    scrollHeight: { get: () => medidas.scrollHeight },
    clientHeight: { get: () => medidas.clientHeight },
    scrollTop: {
      get: () => medidas.scrollTop,
      set: (v: number) => { medidas.scrollTop = Math.max(0, Math.min(v, max())); },
    },
  });
  return {
    el,
    medidas,
    /** Cambia el alto como lo haría el navegador: recorta el desplazamiento si se pasa. */
    redimensionar(alto: number) { medidas.clientHeight = alto; medidas.scrollTop = Math.min(medidas.scrollTop, max()); },
    scroll() { el.dispatchEvent(new Event('scroll')); },
    distanciaAlFinal() { return medidas.scrollHeight - medidas.scrollTop - medidas.clientHeight; },
  };
}

function montar(l: ReturnType<typeof lista>) {
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: () => void) { alCambiarDeAlto = cb; }
    observe() {}
    disconnect() {}
  });
  return renderHook(() => useBottomAnchor({ current: l.el }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  alCambiarDeAlto = null;
});

describe('useBottomAnchor', () => {
  it('se abre el teclado estando al final: sigue al final', () => {
    const l = lista(2000, 650);
    l.medidas.scrollTop = 1350;
    montar(l);
    l.redimensionar(280);
    alCambiarDeAlto!();
    expect(l.distanciaAlFinal()).toBe(0);
  });

  it('leyendo mensajes anteriores: conserva la distancia al abrir y al cerrar el teclado', () => {
    const l = lista(2000, 650);
    l.medidas.scrollTop = 900;
    montar(l);
    l.scroll();
    expect(l.distanciaAlFinal()).toBe(450);

    l.redimensionar(280);
    alCambiarDeAlto!();
    expect(l.distanciaAlFinal()).toBe(450);

    l.redimensionar(650);
    alCambiarDeAlto!();
    expect(l.distanciaAlFinal()).toBe(450);
  });

  it('enviar un borrador de varias líneas: el mensaje nuevo queda a la vista', () => {
    const l = lista(2000, 580);
    l.medidas.scrollTop = 1420;
    montar(l);
    l.scroll(); // al final

    // El campo vuelve a una línea (la lista crece 66) y entra el mensaje
    // (110 de alto). El desplazamiento suave hacia abajo acaba de empezar:
    // la lista todavía no se ha movido.
    l.redimensionar(646);
    l.medidas.scrollHeight = 2110;
    expect(l.distanciaAlFinal()).toBe(110);

    // El navegador reparte primero el scroll y después el cambio de alto.
    l.scroll();
    alCambiarDeAlto!();
    expect(l.distanciaAlFinal()).toBe(0);
  });

  it('después de atender un cambio de alto vuelve a apuntar la distancia', () => {
    const l = lista(2000, 650);
    l.medidas.scrollTop = 1350;
    montar(l);
    l.redimensionar(280);
    alCambiarDeAlto!();
    // La persona sube a leer con el teclado abierto…
    l.medidas.scrollTop = 1000;
    l.scroll();
    const distancia = l.distanciaAlFinal();
    // …y al cerrarlo sigue viendo lo mismo.
    l.redimensionar(650);
    alCambiarDeAlto!();
    expect(l.distanciaAlFinal()).toBe(distancia);
  });
});
