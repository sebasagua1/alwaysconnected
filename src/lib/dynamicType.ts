import { Capacitor } from '@capacitor/core';

/**
 * Tamaño de letra del sistema (Dynamic Type) dentro del WKWebView.
 *
 * iOS no aplica el ajuste de Ajustes > Pantalla y brillo > Tamaño del texto a
 * las páginas: quien lo sube veía la app igual. WebKit sí expone ese tamaño a
 * través de la fuente del sistema `-apple-system-body`, que mide 17 px con el
 * ajuste por defecto y crece o encoge con él.
 *
 * Aquí se mide esa fuente y se escala el `font-size` de <html> en la misma
 * proporción. Toda la app está en rem (textos, huecos, alturas de barra), así
 * que crece de forma coherente: un 16 px de base con el ajuste por defecto,
 * que es lo que había, y proporcional con cualquier otro.
 *
 * Con tope por los dos lados: por encima de ~1,3 la barra inferior y las
 * pastillas del mapa dejan de caber en un iPhone estándar.
 */

const BASE_SYSTEM_PX = 17;
const BASE_ROOT_PX = 16;
const MIN_SCALE = 0.9;
const MAX_SCALE = 1.3;

/** Escala a aplicar, o null si no hay nada que medir (web, Android). */
export function measureDynamicTypeScale(): number | null {
  if (typeof document === 'undefined') return null;
  // Fuera de WebKit la palabra clave no existe: la sonda heredaría los 16 px
  // del body y se leería como "letra más pequeña" sin que nadie la cambiara.
  if (typeof CSS === 'undefined' || !CSS.supports('font', '-apple-system-body')) return null;
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;font:-apple-system-body;';
  probe.textContent = 'A';
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  if (!Number.isFinite(px) || px <= 0) return null;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, px / BASE_SYSTEM_PX));
}

function apply(): void {
  const scale = measureDynamicTypeScale();
  if (scale === null) return;
  const root = document.documentElement;
  // Sin escala se quita el estilo en vez de fijar 16 px: deja mandar al CSS.
  root.style.fontSize = Math.abs(scale - 1) < 0.01 ? '' : `${(BASE_ROOT_PX * scale).toFixed(2)}px`;
}

/**
 * Aplica el tamaño del sistema y lo vuelve a mirar al volver a la app, que es
 * cuando cambia: el ajuste se toca en Ajustes con la app en segundo plano.
 * Solo en la app de iOS; en el navegador cada cual usa el zoom del navegador.
 */
export function watchDynamicType(): () => void {
  if (Capacitor.getPlatform() !== 'ios') return () => {};
  apply();
  const onVisible = () => { if (!document.hidden) apply(); };
  document.addEventListener('visibilitychange', onVisible);
  return () => document.removeEventListener('visibilitychange', onVisible);
}
