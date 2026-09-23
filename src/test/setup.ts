import "@testing-library/jest-dom";
import { configure } from "@testing-library/react";

// findBy/waitFor esperan 1 s por defecto: poco cuando la suite completa
// comparte CPU con las pruebas de SQL (ver vitest.config.ts).
configure({ asyncUtilTimeout: 4000 });

// jsdom no implementa scrollTo en los elementos, solo en window, y lanza
// "is not a function" en cuanto un componente hace scroll de verdad. No es un
// fallo del componente: es que el DOM de mentira no llega. Mismo motivo que el
// matchMedia de abajo.
// Las pruebas de SQL (PGlite) corren en entorno node, sin DOM.
if (typeof window !== "undefined") {
  Object.defineProperty(Element.prototype, "scrollTo", {
    writable: true,
    value: () => {},
  });

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });
}
