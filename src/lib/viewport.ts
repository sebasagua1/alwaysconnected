import { Capacitor } from '@capacitor/core';

/**
 * Sin zoom de página dentro de la app.
 *
 * El WKWebView se comporta como Safari: si un campo tiene letra de menos de
 * 16 px, al tocarlo acerca la página para que se lea, y al cerrar el teclado
 * NO vuelve a alejarla. Con el pellizco o un doble toque rápido (los +/− del
 * cupo) pasa lo mismo. Al crear un evento era fácil acabar con la hoja
 * acercada, la X fuera de la pantalla y sin forma obvia de volver.
 *
 * Una app nativa no hace zoom de página: el tamaño de letra lo pone el ajuste
 * de Texto de iOS, que la app ya sigue (ver dynamicType.ts), y el Zoom de
 * Accesibilidad del sistema sigue funcionando porque va por encima del
 * webview. Así que en la app se fija la escala a 1.
 *
 * Solo en la app: en el navegador se deja el pellizco, que ahí es la forma
 * de agrandar el texto (Safari ignora `user-scalable=no` de todos modos).
 * El WKWebView de Capacitor sí lo respeta, porque no activa
 * `ignoresViewportScaleLimits`.
 */
export function lockNativeZoom(doc: Document = document): void {
  if (!Capacitor.isNativePlatform()) return;
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return;
  const kept = meta.content
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !/^(minimum-scale|maximum-scale|user-scalable)\s*=/i.test(part));
  meta.content = [...kept, 'minimum-scale=1', 'maximum-scale=1', 'user-scalable=no'].join(', ');
}
