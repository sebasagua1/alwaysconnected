// Fuente auto-hospedada (antes venía de Google Fonts, que el CSP bloquea
// y añade un fetch externo en el webview nativo).
import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/500.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/plus-jakarta-sans/700.css";
import "@fontsource/plus-jakarta-sans/800.css";
import "./index.css";

/**
 * Entrada mínima: deja pintar la pantalla de entrada y DESPUÉS carga la app.
 *
 * Antes toda la app (React, rutas, Supabase, traducciones: ~600 KB) iba en
 * este módulo, y el navegador lo ejecuta en cuanto termina de leer el HTML,
 * sin pintar antes. Medido en el simulador: el logo no salía hasta que ese JS
 * acababa, a la vez que el login, y su animación ya había corrido sin verse.
 * Con la app en otro trozo, primero se pinta el logo y se anima mientras se
 * carga lo demás.
 *
 * El CSS se queda aquí para que siga siendo un <link> que bloquea el primer
 * pintado: si viniera con el trozo diferido, la app se pintaría un instante
 * sin estilos.
 */
function afterFirstPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      resolve();
    };
    // rAF corre justo ANTES de pintar; el setTimeout de dentro, después.
    requestAnimationFrame(() => setTimeout(go, 0));
    // Con la pestaña oculta no hay rAF: no se espera más que esto.
    setTimeout(go, 120);
  });
}

afterFirstPaint()
  .then(() => import("./bootstrap"))
  .catch((err) => {
    // El trozo de la app no bajó o reventó al evaluarse: no hay React que
    // avise. Se enseña ya el enlace de Reintentar de la pantalla de entrada
    // (index.html), que normalmente espera 12 s.
    console.error("No se pudo arrancar la app:", err);
    document.getElementById("boot-splash")?.classList.add("boot-splash--failed");
  });
