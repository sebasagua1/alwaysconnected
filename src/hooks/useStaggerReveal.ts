import { useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);

/**
 * Revela en cascada los hijos marcados con `data-reveal` dentro de un
 * contenedor. Pensado para listas que llegan de la red: en vez de aparecer
 * de golpe cuando termina la consulta, las tarjetas entran una detrás de
 * otra y la espera se lee como carga y no como salto.
 *
 * Tres decisiones que importan:
 *
 * - `gsap.from` y no `gsap.to`. Con `from`, el estado final es el que ya
 *   tiene el elemento en el HTML, así que si la animación no llega a
 *   correr —movimiento reducido, GSAP que no carga, un fallo cualquiera—
 *   la lista se ve igual que sin el hook. Con `to` habría que dejar las
 *   tarjetas en opacity:0 de partida y cualquier fallo las escondería.
 *
 * - `gsap.matchMedia` para `prefers-reduced-motion`. Quien pide menos
 *   movimiento no ve nada: matchMedia no ejecuta el bloque y las tarjetas
 *   quedan en su sitio. Es el mismo trato que ya se le da al latido de los
 *   marcadores del mapa en index.css.
 *
 * - `revertOnUpdate`. Al cambiar de pestaña o recargar la lista, GSAP
 *   deshace la animación anterior antes de montar la nueva, así que no se
 *   acumulan transformaciones sobre los mismos nodos.
 *
 * Los tiempos (300ms, 8px, 0.03s entre elementos) salen del preset
 * "Stagger List / Subtle" de la skill ui-ux-pro-max, que es el tramo
 * pensado para listas de contenido en móvil.
 */
export function useStaggerReveal<T extends HTMLElement = HTMLDivElement>(
  dependencies: unknown[] = [],
) {
  const scope = useRef<T>(null);

  useGSAP(
    () => {
      const items = gsap.utils.toArray<HTMLElement>('[data-reveal]');
      if (items.length === 0) return;

      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.from(items, {
          opacity: 0,
          y: 8,
          duration: 0.3,
          ease: 'power1.out',
          // Un tope al total: con 40 tarjetas, 0.03s cada una serían más de
          // un segundo hasta que entra la última. `amount` reparte ese
          // presupuesto entre las que haya.
          stagger: { each: 0.03, amount: Math.min(items.length * 0.03, 0.36) },
          // Que el navegador no reserve capas de más en listas largas.
          clearProps: 'opacity,transform',
        });
      });

      return () => mm.revert();
    },
    { scope, dependencies, revertOnUpdate: true },
  );

  return scope;
}
