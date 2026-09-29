// Lo que tiene que estar decidido ANTES del primer pintado: el modo oscuro
// (el resto, los cambios en vivo, está en src/lib/theme.ts) y el idioma del
// lema de la pantalla de entrada (index.html).
//
// Por qué es un archivo aparte y no un <script> en línea dentro de
// index.html, que sería lo natural: la CSP que sirve Vercel lleva
// `script-src 'self'` sin 'unsafe-inline', así que el navegador BLOQUEABA el
// script en línea y el anti-fogonazo no funcionaba en la web (en el webview
// de Capacitor sí, porque allí no hay esa cabecera). Se descartó meter el
// hash sha256 del script en vercel.json: cualquiera que tocara una coma aquí
// lo invalidaba y el modo oscuro volvía a romperse en silencio.
//
// Va cargado sin `defer` ni `async` a propósito: bloquea el pintado, que es
// justo lo que hace falta para que no se vea el fondo claro un instante.
try {
  if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.classList.add('dark');
  }
} catch (e) {}

// El lema de la pantalla de entrada está escrito en los dos idiomas dentro de
// index.html, y aquí se elige cuál se ve. Hay que hacerlo antes de pintar: si
// lo cambiara React, quien tiene la app en inglés vería el lema en español un
// instante. Mismo criterio que src/i18n/index.ts: primero el idioma elegido a
// mano en la app, luego el del sistema, y español si no es ninguno de los dos.
try {
  var lang = localStorage.getItem('connecttec_lang');
  if (!lang) {
    var langs = navigator.languages || [navigator.language];
    for (var i = 0; i < langs.length; i++) {
      var code = String(langs[i]).slice(0, 2).toLowerCase();
      if (code === 'es' || code === 'en') { lang = code; break; }
    }
  }
  if (lang && lang.slice(0, 2) === 'en') {
    document.documentElement.setAttribute('data-boot-lang', 'en');
  }
} catch (e) {}

// La entrada del logo espera a que la página se haya pintado de verdad.
// Las animaciones CSS empiezan a contar en cuanto se calculan los estilos,
// y en el webview de iOS la página tarda un poco más en MOSTRARSE: medido en
// el simulador, el primer fotograma visible ya traía el logo al 80 %, así
// que la entrada no se veía. Con `boot-wait` quedan en pausa (index.html)
// hasta el segundo requestAnimationFrame, que llega con el primer fotograma
// ya presentado. El setTimeout es por si rAF no llega (pestaña oculta): la
// entrada no puede quedarse en pausa para siempre.
try {
  var root = document.documentElement;
  root.classList.add('boot-wait');
  var release = function () { root.classList.remove('boot-wait'); };
  requestAnimationFrame(function () { requestAnimationFrame(release); });
  setTimeout(release, 400);
} catch (e) {}
