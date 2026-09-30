/**
 * Lo que hace fluidas las transiciones entre pantallas:
 *   · lazyPage: una pantalla precargada se pinta sin pasar por Suspense, y
 *     una que ya estaba montada no se desmonta cuando termina la precarga;
 *   · crossfadeTo: fundido cruzado del navegador donde existe, y navegación
 *     normal donde no (o con «Reducir movimiento»). La foto de la pantalla
 *     nueva espera a que React la monte (notifyRouteCommitted), y si tarda
 *     demasiado se renuncia al fundido.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Suspense, useEffect } from 'react';
import { render, screen, act, cleanup } from '@testing-library/react';
import { lazyPage } from '@/lib/lazyPage';
import { crossfadeTo, isCrossfadeNavigation, notifyRouteCommitted } from '@/lib/viewTransition';

afterEach(() => {
  cleanup();
  notifyRouteCommitted('');
  vi.useRealTimers();
  // @ts-expect-error: se quita lo que haya puesto la prueba
  delete document.startViewTransition;
});

describe('lazyPage', () => {
  it('precargada, se pinta al primer render sin enseñar el fallback de Suspense', async () => {
    const Page = lazyPage(async () => ({ default: () => <p>pantalla</p> }));
    await Page.preload();
    render(<Suspense fallback={<p>rueda</p>}><Page /></Suspense>);
    // Síncrono: sin await ni findBy. Con React.lazy aquí saldría la rueda.
    expect(screen.getByText('pantalla')).toBeInTheDocument();
    expect(screen.queryByText('rueda')).not.toBeInTheDocument();
  });

  it('sin precargar, funciona como lazy de siempre', async () => {
    const Page = lazyPage(async () => ({ default: () => <p>pantalla</p> }));
    render(<Suspense fallback={<p>rueda</p>}><Page /></Suspense>);
    expect(screen.getByText('rueda')).toBeInTheDocument();
    expect(await screen.findByText('pantalla')).toBeInTheDocument();
  });

  it('una pantalla ya montada no se desmonta cuando termina la precarga (conserva su estado)', async () => {
    const montajes = vi.fn();
    function Pantalla() {
      useEffect(() => { montajes(); }, []);
      return <p>pantalla</p>;
    }
    const Page = lazyPage(async () => ({ default: Pantalla }));
    const { rerender } = render(<Suspense fallback={<p>rueda</p>}><Page /></Suspense>);
    expect(await screen.findByText('pantalla')).toBeInTheDocument();
    await act(async () => { await Page.preload(); });
    rerender(<Suspense fallback={<p>rueda</p>}><Page /></Suspense>);
    expect(montajes).toHaveBeenCalledTimes(1);
  });

  it('si la carga falla, el siguiente intento vuelve a pedirla', async () => {
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error('sin red'))
      .mockResolvedValueOnce({ default: () => <p>pantalla</p> });
    const Page = lazyPage(factory);
    await expect(Page.preload()).rejects.toThrow('sin red');
    await expect(Page.preload()).resolves.toBeDefined();
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe('crossfadeTo', () => {
  it('sin View Transitions, navega sin más', () => {
    const navegar = vi.fn();
    crossfadeTo('/events', navegar);
    expect(navegar).toHaveBeenCalledTimes(1);
    expect(isCrossfadeNavigation('/events')).toBe(false);
  });

  /** Un startViewTransition falso: guarda la promesa del callback para que la prueba la vigile. */
  function fakeViewTransitions() {
    const state = { update: null as Promise<void> | null, skipped: false };
    const start = vi.fn((cb: () => Promise<void> | void) => {
      const update = Promise.resolve(cb());
      state.update = update;
      return {
        updateCallbackDone: update,
        ready: update,
        finished: update,
        skipTransition: () => { state.skipped = true; },
      };
    });
    Object.defineProperty(document, 'startViewTransition', { value: start, configurable: true, writable: true });
    return { start, state };
  }

  it('con View Transitions, navega dentro de la transición y marca la ruta', () => {
    const { start } = fakeViewTransitions();
    const navegar = vi.fn();
    crossfadeTo('/events', navegar);
    expect(start).toHaveBeenCalledTimes(1);
    expect(navegar).toHaveBeenCalledTimes(1);
    // PageTransition lo lee para no poner su fundido encima.
    expect(isCrossfadeNavigation('/events')).toBe(true);
    expect(isCrossfadeNavigation('/friends')).toBe(false);
  });

  it('la foto nueva espera a que React monte la ruta (no basta con navegar)', async () => {
    vi.useFakeTimers();
    const { state } = fakeViewTransitions();
    const hecho = vi.fn();
    crossfadeTo('/events', () => {});
    state.update!.then(hecho);
    await vi.advanceTimersByTimeAsync(100);
    // Navegar no basta: con React Router 7 el DOM aún tiene la pantalla vieja.
    expect(hecho).not.toHaveBeenCalled();
    notifyRouteCommitted('/events');
    await vi.advanceTimersByTimeAsync(0);
    expect(hecho).toHaveBeenCalledTimes(1);
    expect(state.skipped).toBe(false);
    expect(isCrossfadeNavigation('/events')).toBe(false);
  });

  it('si React no monta la ruta a tiempo, se renuncia al fundido en vez de congelar la pantalla', async () => {
    vi.useFakeTimers();
    const { state } = fakeViewTransitions();
    crossfadeTo('/events', () => {});
    await vi.advanceTimersByTimeAsync(600);
    expect(state.skipped).toBe(true);
    // Un aviso tardío de otra ruta no rompe nada.
    notifyRouteCommitted('/events');
  });

  it('con «Reducir movimiento» no hay fundido cruzado', () => {
    const start = vi.fn();
    Object.defineProperty(document, 'startViewTransition', { value: start, configurable: true, writable: true });
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({ ...original(q), matches: q.includes('reduce') })) as typeof window.matchMedia;
    try {
      const navegar = vi.fn();
      crossfadeTo('/events', navegar);
      expect(start).not.toHaveBeenCalled();
      expect(navegar).toHaveBeenCalledTimes(1);
    } finally {
      window.matchMedia = original;
    }
  });
});
