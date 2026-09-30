import { cn } from '@/lib/utils';

/**
 * El logo de la app: el cuadro azul con el pin, tal cual.
 *
 * Misma geometría que dibuja scripts/gen-app-assets.mjs para el icono y que
 * usa la pantalla de entrada de index.html (cuadro de 700 con rx 160, y el
 * pin trasladado 146 y escalado 17). Antes el login pintaba un pin genérico
 * de lucide dentro de un cuadrado redondeado: se parecía, pero no era el
 * logo, y al pasar de la pantalla de entrada al login se notaba el cambio.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 700 700"
      aria-hidden="true"
      focusable="false"
      className={cn('block', className)}
    >
      <rect width="700" height="700" rx="160" fill="#003DA5" />
      <path
        transform="translate(146 146) scale(17)"
        fill="#fff"
        fillRule="evenodd"
        d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"
      />
    </svg>
  );
}
