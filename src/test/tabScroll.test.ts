/**
 * Tocar la pestaña activa sube al principio. Lo que se fija: también suben
 * los contenedores con scroll propio (la lista del mapa), que con solo mover
 * la ventana se quedaban donde estaban.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { scrollActiveTabToTop } from '@/lib/tabScroll';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('scrollActiveTabToTop', () => {
  it('sube la ventana y cada contenedor marcado', () => {
    const ventana = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    document.body.innerHTML = '<div data-tab-scroller id="lista"></div><div id="otro"></div>';
    const lista = document.getElementById('lista')!;
    const otro = document.getElementById('otro')!;
    lista.scrollTo = vi.fn();
    otro.scrollTo = vi.fn();

    scrollActiveTabToTop();

    expect(ventana).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    expect(lista.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    expect(otro.scrollTo).not.toHaveBeenCalled();
  });

  it('sin contenedores marcados solo sube la ventana', () => {
    const ventana = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    scrollActiveTabToTop();
    expect(ventana).toHaveBeenCalledTimes(1);
  });
});
