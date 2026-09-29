/**
 * Zoom de página: dentro de la app se bloquea, en el navegador no.
 *
 * El fallo: al crear un evento, tocar la descripción (letra de 14 px) hacía
 * que iOS acercara la página, y al cerrar el teclado se quedaba acercada con
 * la X fuera de la pantalla.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let native = true;
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => native },
}));

import { lockNativeZoom } from '@/lib/viewport';

const ORIGINAL = 'width=device-width, initial-scale=1.0, viewport-fit=cover';

function viewport(content = ORIGINAL): HTMLMetaElement {
  document.head.innerHTML = '';
  const meta = document.createElement('meta');
  meta.name = 'viewport';
  meta.content = content;
  document.head.appendChild(meta);
  return meta;
}

describe('lockNativeZoom', () => {
  beforeEach(() => {
    native = true;
  });

  it('en la app fija la escala a 1 y conserva el resto', () => {
    const meta = viewport();
    lockNativeZoom();
    const parts = meta.content.split(',').map((p) => p.trim());
    expect(parts).toEqual([
      'width=device-width',
      'initial-scale=1.0',
      'viewport-fit=cover',
      'minimum-scale=1',
      'maximum-scale=1',
      'user-scalable=no',
    ]);
  });

  it('no duplica nada si se llama dos veces o ya había límites', () => {
    const meta = viewport(`${ORIGINAL}, maximum-scale=5, user-scalable=yes`);
    lockNativeZoom();
    lockNativeZoom();
    expect(meta.content.match(/maximum-scale/g)).toHaveLength(1);
    expect(meta.content.match(/user-scalable/g)).toHaveLength(1);
    expect(meta.content).toContain('maximum-scale=1');
    expect(meta.content).toContain('user-scalable=no');
  });

  it('en el navegador no toca nada: ahí el pellizco es accesibilidad', () => {
    native = false;
    const meta = viewport();
    lockNativeZoom();
    expect(meta.content).toBe(ORIGINAL);
  });

  it('sin meta viewport no falla', () => {
    document.head.innerHTML = '';
    expect(() => lockNativeZoom()).not.toThrow();
  });
});
