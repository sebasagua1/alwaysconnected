import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
// Fuente auto-hospedada (antes venía de Google Fonts, que el CSP bloquea
// y añade un fetch externo en el webview nativo).
import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/500.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/plus-jakarta-sans/700.css";
import "@fontsource/plus-jakarta-sans/800.css";
import App from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { watchColorScheme } from "./lib/theme.ts";
import { watchDynamicType } from "./lib/dynamicType.ts";
import { lockNativeZoom } from "./lib/viewport.ts";
import "./index.css";
import "./i18n";

// Mantiene la clase .dark al día si el sistema cambia de tema con la app
// abierta. El estado inicial ya lo puso el script en línea del index.html.
watchColorScheme();

// El tamaño de letra de Ajustes de iOS, que el webview no aplica solo.
watchDynamicType();

// Dentro de la app la página no hace zoom (se quedaba acercada al escribir).
lockNativeZoom();

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <HelmetProvider>
      <App />
    </HelmetProvider>
  </ErrorBoundary>
);
