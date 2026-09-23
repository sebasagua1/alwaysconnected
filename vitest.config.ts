import { defineConfig, defaultExclude } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// Las pruebas de SQL levantan cada una un Postgres entero compilado a
// WebAssembly (PGlite). Con seis archivos en paralelo eso son seis bases de
// datos vivas a la vez: en el portátil fallaba de vez en cuando al construir
// la instancia, y en un runner de GitHub (7 GB, 2 núcleos) fallaría más.
//
// Por eso hay dos proyectos: las pruebas normales van en paralelo como
// siempre, y las de SQL comparten un único proceso, una detrás de otra. Lo
// que se pierde en tiempo se gana en que el resultado signifique algo.
const SQL = "src/**/*.sql.test.ts";

const comun = {
  globals: true,
  setupFiles: ["./src/test/setup.ts"],
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          ...comun,
          name: "unit",
          environment: "jsdom",
          // Corren a la vez que las de SQL, que se comen la CPU mientras
          // arranca cada PGlite. Con 5 s por prueba, las de pantalla fallaban
          // por tiempo en la suite completa y pasaban solas. Un fallo de
          // verdad sigue fallando; solo tarda mas en rendirse.
          testTimeout: 15_000,
          include: ["src/**/*.{test,spec}.{ts,tsx}"],
          exclude: [...defaultExclude, SQL],
        },
      },
      {
        extends: true,
        test: {
          ...comun,
          name: "sql",
          environment: "node",
          include: [SQL],
          // Un solo proceso para los seis archivos: nunca hay dos PGlite a la vez.
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
