import { Capacitor } from '@capacitor/core';

/**
 * Tamaño de letra del sistema (Dynamic Type) dentro del WKWebView.
 *
 * iOS no aplica el ajuste de Ajustes > Pantalla y brillo > Tamaño del texto a
 * las páginas: quien lo sube veía la app igual. WebKit sí expone ese tamaño a
 * través de la fuente del sistema `-apple-system-body`, que mide 17 px con el
 * ajuste por defecto y crece o encoge con él.
 *
 * Aquí se mide esa fuente y se reparte en DOS escalas:
 *
 *   · La de la interfaz: el `font-size` de <html>. Toda la app está en rem
 *     (textos, huecos, alturas de barra, iconos), así que crece entera y de
 *     forma coherente. Con tope en 1,3: por encima, la barra inferior y las
 *     pastillas del mapa dejan de caber en un iPhone estándar.
 *
 *   · La del texto: lo que el sistema pide POR ENCIMA de ese tope se aplica
 *     solo a las letras, con `-webkit-text-size-adjust` en <body>. Los rem
 *     no se enteran, así que iconos, huecos y barras se quedan como estaban
 *     y lo que crece es lo que hay que leer.
 *
 *     En <body> y no en <html>, y no da igual: en <html> WebKit agranda
 *     también la letra de la raíz, que es la base de los rem, y entonces
 *     crece TODO otra vez (probado: la barra de pestañas pasaba a dos
 *     líneas y los botones redondos del mapa medían un 25 % más).
 *
 * Antes solo existía la primera, y todos los tamaños de accesibilidad se
 * veían igual que «xxL»: quien subía la letra al máximo en Ajustes obtenía
 * el mismo 30 % que quien la subía tres pasos.
 *
 * La segunda también tiene tope (TEXT_BOOST_MAX). No es el que pediría el
 * sistema —el tamaño más grande es 3,1 veces el normal— sino hasta donde
 * aguantan hoy los botones de alto fijo y los pies de dos botones sin
 * partirse. Subirlo es cosa de repasar esas pantallas, no de tocar la cifra.
 *
 * Lo que no puede crecer (la barra de pestañas, cuatro etiquetas en un ancho
 * fijo) se queda fuera con la clase `dt-fixed`; iOS hace lo mismo con su
 * barra de pestañas.
 */

const BASE_SYSTEM_PX = 17;
const BASE_ROOT_PX = 16;
const MIN_SCALE = 0.9;
const MAX_SCALE = 1.3;
/** Cuánto puede crecer el texto por encima de la interfaz. */
const TEXT_BOOST_MAX = 1.25;

export interface DynamicTypeScales {
  /** Escala de toda la interfaz (rem). */
  layout: number;
  /** Escala añadida solo al texto: 1 si el sistema no pide más que el tope. */
  text: number;
}

/** Las dos escalas para un tamaño de la fuente del sistema, en px. */
export function scalesFor(systemPx: number): DynamicTypeScales {
  const ratio = systemPx / BASE_SYSTEM_PX;
  const layout = Math.min(MAX_SCALE, Math.max(MIN_SCALE, ratio));
  const text = Math.min(TEXT_BOOST_MAX, Math.max(1, ratio / layout));
  return { layout, text };
}

/** Las escalas a aplicar, o null si no hay nada que medir (web, Android). */
export function measureDynamicTypeScale(): DynamicTypeScales | null {
  if (typeof document === 'undefined') return null;
  // Fuera de WebKit la palabra clave no existe: la sonda heredaría los 16 px
  // del body y se leería como "letra más pequeña" sin que nadie la cambiara.
  if (typeof CSS === 'undefined' || !CSS.supports('font', '-apple-system-body')) return null;
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  // Con su propio text-size-adjust: cuelga de <body>, y si heredara el
  // refuerzo se mediría a sí misma ya agrandada. Al volver a la app la
  // medida saldría mayor cada vez.
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;font:-apple-system-body;-webkit-text-size-adjust:100%;';
  probe.textContent = 'A';
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  if (!Number.isFinite(px) || px <= 0) return null;
  return scalesFor(px);
}

/**
 * Pone las dos escalas: la de la interfaz en <html> y el refuerzo de texto
 * en <body>. Aparte de `apply` para poder probarlo.
 */
export function applyDynamicTypeScales(doc: Document, { layout, text }: DynamicTypeScales): void {
  // Sin escala se quita el estilo en vez de fijar 16 px: deja mandar al CSS.
  doc.documentElement.style.fontSize = Math.abs(layout - 1) < 0.01 ? '' : `${(BASE_ROOT_PX * layout).toFixed(2)}px`;
  // Se hereda: basta con ponerlo en <body>. Sin refuerzo se quita, y vuelve
  // a mandar el 100 % de la hoja de estilos.
  if (text > 1.01) doc.body.style.setProperty('-webkit-text-size-adjust', `${Math.round(text * 100)}%`);
  else doc.body.style.removeProperty('-webkit-text-size-adjust');
}

function apply(): void {
  const scales = measureDynamicTypeScale();
  if (scales === null) return;
  applyDynamicTypeScales(document, scales);
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
