import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * Estado de la "carcasa" de la app que no pertenece a ninguna pantalla.
 *
 * Por ahora solo una cosa: quién ha pedido esconder la barra inferior. Es un
 * contador y no un booleano porque lo pueden pedir varios a la vez (elegir
 * ubicación con una hoja abierta encima, por ejemplo) y el primero que suelta
 * no debe volver a enseñarla mientras el otro la sigue necesitando oculta.
 */
interface UiState {
  navHiders: number;
  hideNav: () => () => void;
}

export const useUiStore = create<UiState>((set) => ({
  navHiders: 0,
  hideNav: () => {
    set((s) => ({ navHiders: s.navHiders + 1 }));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      set((s) => ({ navHiders: Math.max(0, s.navHiders - 1) }));
    };
  },
}));

/** Esconde la barra inferior mientras `active` sea true. */
export function useHideBottomNav(active: boolean): void {
  const hideNav = useUiStore((s) => s.hideNav);
  useEffect(() => (active ? hideNav() : undefined), [active, hideNav]);
}

/**
 * Pantallas de detalle donde la barra de pestañas NO va: las conversaciones.
 * En iOS entrar en un detalle la oculta, y aquí además se comía unos 98 pt de
 * chat y dejaba el campo de escribir flotando encima de las pestañas.
 */
export function isFullScreenRoute(pathname: string): boolean {
  return /^\/groups\/[^/]+\/?$/.test(pathname) || /^\/events\/[^/]+\/chat\/?$/.test(pathname);
}
