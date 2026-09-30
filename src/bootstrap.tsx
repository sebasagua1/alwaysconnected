import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import App from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { watchColorScheme } from "./lib/theme.ts";
import { watchDynamicType } from "./lib/dynamicType.ts";
import { lockNativeZoom } from "./lib/viewport.ts";
import { markBootScriptRunning } from "./lib/bootSplash.ts";
import "./i18n";

// El JS de la app llegó y se evaluó entero: los avisos de la pantalla de
// entrada los pone ya React, y el enlace de emergencia del HTML (para cuando
// el JS no arranca) no hace falta.
markBootScriptRunning();

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
