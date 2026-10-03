/**
 * Las hojas con campos de texto y el teclado. Lo que se fija: con el teclado
 * abierto el contenedor se coloca sobre lo que se ve (más la franja de
 * detrás del teclado), cerrado no se toca nada, y el campo en el que se
 * escribe se deja a la vista moviendo solo su lista. Las cifras son las
 * medidas en un iPhone 17 Pro (874 de alto, 471 con el teclado, página
 * desplazada 139).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { scrollTopToReveal, useKeyboardFrame } from '@/hooks/useKeyboardFrame';

function pantalla({ inner, vv }: { inner: number; vv: { height: number; offsetTop?: number } }) {
  vi.stubGlobal('innerHeight', inner);
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(874);
  vi.stubGlobal('visualViewport', {
    height: vv.height, offsetTop: vv.offsetTop ?? 0, scale: 1,
    addEventListener: () => {}, removeEventListener: () => {},
  });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useKeyboardFrame', () => {
  it('sin teclado no toca nada: la hoja se queda con sus clases', () => {
    pantalla({ inner: 874, vv: { height: 874 } });
    const { result } = renderHook(() => useKeyboardFrame());
    act(() => {});
    expect(result.current).toEqual({ keyboardOpen: false, keyboardPad: 0, frameStyle: undefined, sheetStyle: undefined });
  });

  it('con teclado: el contenedor va sobre lo visible y sigue por detrás del teclado', () => {
    pantalla({ inner: 471, vv: { height: 471, offsetTop: 139 } });
    const { result } = renderHook(() => useKeyboardFrame());
    act(() => {});
    expect(result.current.keyboardOpen).toBe(true);
    expect(result.current.keyboardPad).toBe(403);
    // Empieza donde empieza lo que se ve y mide lo visible MÁS el teclado.
    expect(result.current.frameStyle).toEqual({ top: 139, height: 471 + 403, bottom: 'auto' });
    // La hoja ocupa ese contenedor entero y deja el hueco del teclado abajo.
    expect(result.current.sheetStyle).toMatchObject({ height: '100%', maxHeight: '100%', paddingBottom: 403 });
  });
});

describe('scrollTopToReveal', () => {
  // Una lista que ocupa de 100 a 400 en pantalla, desplazada 50.
  const lista = { top: 100, bottom: 400, scrollTop: 50 };

  it('si el campo ya se ve entero no mueve nada', () => {
    expect(scrollTopToReveal(lista, { top: 150, bottom: 200 })).toBe(50);
  });

  it('si queda por debajo, baja lo justo para dejarlo con aire', () => {
    // El campo acaba en 460: 60 por debajo, más los 16 de margen.
    expect(scrollTopToReveal(lista, { top: 420, bottom: 460 })).toBe(50 + 76);
  });

  it('si queda por arriba, sube lo justo', () => {
    // El campo empieza en 90: tiene que quedar en 116.
    expect(scrollTopToReveal(lista, { top: 90, bottom: 130 })).toBe(50 - 26);
  });

  it('nunca pide un desplazamiento negativo', () => {
    expect(scrollTopToReveal({ ...lista, scrollTop: 10 }, { top: 20, bottom: 60 })).toBe(0);
  });

  it('un campo más alto que la lista se alinea por su principio', () => {
    // Asoma por abajo, pero no cabe: lo que manda es dónde empieza.
    expect(scrollTopToReveal(lista, { top: 200, bottom: 600 })).toBe(50 + 84);
  });
});
