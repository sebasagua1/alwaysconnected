/**
 * La detección del teclado. Lo que se fija: en el WKWebView de iOS 26
 * `innerHeight` se encoge con el teclado igual que el visualViewport, y aun
 * así hay que enterarse de que está abierto. Las cifras son las medidas en
 * un iPhone 17 Pro (874 de alto, 471 con el teclado).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useKeyboardInset } from '@/hooks/useKeyboardInset';

function pantalla({ inner, doc, vv }: { inner: number; doc: number; vv: { height: number; offsetTop?: number; scale?: number } }) {
  vi.stubGlobal('innerHeight', inner);
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(doc);
  vi.stubGlobal('visualViewport', {
    height: vv.height, offsetTop: vv.offsetTop ?? 0, scale: vv.scale ?? 1,
    addEventListener: () => {}, removeEventListener: () => {},
  });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
}

const medir = () => {
  const { result } = renderHook(() => useKeyboardInset());
  act(() => {});
  return result.current;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useKeyboardInset', () => {
  it('teclado cerrado: no tapa nada', () => {
    pantalla({ inner: 874, doc: 874, vv: { height: 874 } });
    expect(medir()).toEqual({ keyboard: 0, height: 874, top: 0 });
  });

  it('iOS 26: innerHeight se encoge con el teclado y aun así se detecta', () => {
    pantalla({ inner: 471, doc: 874, vv: { height: 471, offsetTop: 403 } });
    expect(medir()).toEqual({ keyboard: 403, height: 471, top: 403 });
  });

  it('innerHeight que no se encoge (lo que el hook suponía antes) sigue valiendo', () => {
    pantalla({ inner: 874, doc: 874, vv: { height: 471, offsetTop: 403 } });
    expect(medir().keyboard).toBe(403);
  });

  it('un zoom con los dedos encoge el visualViewport pero no es un teclado', () => {
    pantalla({ inner: 437, doc: 874, vv: { height: 437, scale: 2 } });
    expect(medir().keyboard).toBe(0);
  });

  it('por debajo de 120 px no se considera teclado', () => {
    pantalla({ inner: 874, doc: 874, vv: { height: 800 } });
    expect(medir().keyboard).toBe(0);
  });
});
