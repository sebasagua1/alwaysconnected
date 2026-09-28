import { useCallback, useEffect, useRef } from 'react';
import type React from 'react';

/**
 * Cerrar una hoja arrastrándola hacia abajo, como en iOS.
 *
 * Las hojas tenían la barrita de arrastre pero era decoración: bajar el dedo,
 * que es lo primero que prueba cualquiera en un iPhone, no hacía nada.
 *
 * Dos sitios desde los que se puede arrastrar:
 *   · La zona de agarre (`handleProps`): la barrita y la cabecera. Lleva
 *     `touch-action: none`, así que el navegador no intenta hacer scroll ahí.
 *   · El contenido con scroll (`scrollRef`), SOLO cuando ya está arriba del
 *     todo y el dedo baja. Ahí no se puede quitar el scroll al contenido, así
 *     que se escucha con touch events no pasivos y se frena el scroll del
 *     navegador únicamente en ese caso.
 *
 * La hoja sigue al dedo y, al soltar, se cierra si bajó más de un cuarto de su
 * alto o si el gesto fue rápido; si no, vuelve a su sitio. El transform se
 * QUITA al terminar: un transform que se queda puesto convierte los
 * descendientes `position: fixed` (el selector de fecha, por ejemplo) en hijos
 * de la hoja, y dejarían de cubrir la pantalla.
 */

const START_SLOP = 6;
const CLOSE_FRACTION = 0.25;
const CLOSE_VELOCITY = 0.6; // px/ms
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

interface Options {
  onClose: () => void;
  enabled?: boolean;
  /**
   * Se consulta ANTES de cerrar. Si devuelve false la hoja vuelve a su sitio
   * (p. ej. porque hay un borrador y se va a preguntar si descartarlo).
   */
  canClose?: () => boolean;
}

export function useSheetDrag<Sheet extends HTMLElement, Scroll extends HTMLElement = HTMLDivElement>({
  onClose,
  enabled = true,
  canClose,
}: Options) {
  const sheetRef = useRef<Sheet>(null);
  const scrollRef = useRef<Scroll>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const canCloseRef = useRef(canClose);
  canCloseRef.current = canClose;

  const state = useRef({ active: false, dragging: false, startY: 0, startT: 0, dy: 0, pointerId: -1 });

  const setOffset = (dy: number) => {
    const el = sheetRef.current;
    if (!el) return;
    el.style.transition = 'none';
    // Hacia arriba ofrece resistencia en vez de despegarse del borde.
    el.style.transform = `translate3d(0, ${dy >= 0 ? dy : dy * 0.2}px, 0)`;
  };

  const release = useCallback(() => {
    const s = state.current;
    const el = sheetRef.current;
    const wasDragging = s.dragging;
    s.active = false;
    s.dragging = false;
    if (!el || !wasDragging) return;

    const dt = Math.max(1, performance.now() - s.startT);
    const velocity = s.dy / dt;
    const height = el.getBoundingClientRect().height || 1;

    const wantsClose = s.dy > height * CLOSE_FRACTION || (s.dy > 24 && velocity > CLOSE_VELOCITY);
    if (wantsClose && (canCloseRef.current?.() ?? true)) {
      el.style.transition = `transform 200ms ${EASE}`;
      el.style.transform = `translate3d(0, ${height + 40}px, 0)`;
      window.setTimeout(() => onCloseRef.current(), 180);
      return;
    }

    el.style.transition = `transform 260ms ${EASE}`;
    el.style.transform = 'translate3d(0, 0, 0)';
    window.setTimeout(() => {
      // Solo si nadie ha empezado otro arrastre entre medias.
      if (state.current.dragging || !sheetRef.current) return;
      sheetRef.current.style.transition = '';
      sheetRef.current.style.transform = '';
    }, 280);
  }, []);

  // --- Zona de agarre: pointer events -------------------------------------
  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!enabled || e.button !== 0) return;
    const s = state.current;
    s.active = true;
    s.dragging = false;
    s.startY = e.clientY;
    s.startT = performance.now();
    s.dy = 0;
    s.pointerId = e.pointerId;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const s = state.current;
    if (!s.active || e.pointerId !== s.pointerId) return;
    const dy = e.clientY - s.startY;
    if (!s.dragging) {
      // Un toque en la X de la cabecera no es un arrastre: hasta que el dedo
      // no se mueve unos píxeles no se captura nada.
      if (Math.abs(dy) < START_SLOP) return;
      s.dragging = true;
      s.startT = performance.now();
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    s.dy = dy;
    setOffset(dy);
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerId !== state.current.pointerId) return;
    release();
  };

  const handleProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
    style: { touchAction: 'none' } as React.CSSProperties,
    'data-sheet-handle': '',
  };

  // --- Contenido con scroll: touch events no pasivos ----------------------
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !enabled) return;
    let startY = 0;
    let armed = false;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      // La zona de agarre ya tiene su propio manejo con pointer events.
      if ((e.target as Element | null)?.closest?.('[data-sheet-handle]')) { armed = false; return; }
      startY = e.touches[0].clientY;
      // Solo si el contenido está arriba del todo al empezar.
      armed = scroller.scrollTop <= 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!armed) return;
      const dy = e.touches[0].clientY - startY;
      const s = state.current;
      if (!s.dragging) {
        if (dy < START_SLOP) {
          // Hacia arriba es scroll normal: se desarma y no se vuelve a mirar.
          if (dy < 0) armed = false;
          return;
        }
        s.dragging = true;
        s.startT = performance.now();
      }
      e.preventDefault();
      s.dy = dy;
      setOffset(dy);
    };
    const onEnd = () => {
      armed = false;
      release();
    };

    scroller.addEventListener('touchstart', onStart, { passive: true });
    scroller.addEventListener('touchmove', onMove, { passive: false });
    scroller.addEventListener('touchend', onEnd);
    scroller.addEventListener('touchcancel', onEnd);
    return () => {
      scroller.removeEventListener('touchstart', onStart);
      scroller.removeEventListener('touchmove', onMove);
      scroller.removeEventListener('touchend', onEnd);
      scroller.removeEventListener('touchcancel', onEnd);
    };
  }, [enabled, release]);

  return { sheetRef, scrollRef, handleProps };
}
