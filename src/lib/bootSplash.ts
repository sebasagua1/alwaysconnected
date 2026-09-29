import { Capacitor, registerPlugin } from '@capacitor/core';
import { create } from 'zustand';

/**
 * La pantalla de entrada: logo, nombre y lema sobre el azul de la marca.
 *
 * NO es un componente de React. Vive en index.html, fuera de #root, para que
 * salga en el PRIMER pintado, antes de que el JS termine de cargar: si la
 * pintara React, entre la pantalla de lanzamiento de iOS y ella habría un
 * hueco vacío. Aquí solo se decide cuándo se va.
 *
 * El recorrido completo, sin un solo salto de color:
 *   1. iOS enseña LaunchScreen.storyboard: el azul, liso.
 *   2. El webview carga con ese mismo azul de fondo (AppViewController).
 *   3. El HTML pinta este azul y el logo aparece con su animación.
 *   4. Cuando la sesión está resuelta y la pantalla de destino montada
 *      (<BootReady />), se funde y deja ver la app.
 *
 * Mientras tanto, si algo tarda o falla, <StartupStatus /> escribe el aviso y
 * el botón de Reintentar DENTRO de ella: un error nunca queda tapado.
 */

const SPLASH_ID = 'boot-splash';
const STATUS_SLOT_ID = 'boot-splash-status';

interface BootSplashState {
  /** Si la pantalla de entrada sigue en pantalla (aunque se esté fundiendo no cuenta). */
  visible: boolean;
}

export const useBootSplash = create<BootSplashState>(() => ({
  visible: typeof document !== 'undefined' && !!document.getElementById(SPLASH_ID),
}));

/** Dónde se pintan los avisos mientras la pantalla de entrada está puesta. */
export function bootStatusSlot(): HTMLElement | null {
  return document.getElementById(STATUS_SLOT_ID);
}

/**
 * Le dice al HTML que el JS arrancó.
 *
 * El HTML trae un enlace de «Reintentar» que aparece solo a los 12 s: es la
 * salida si el JS no llega a ejecutarse (un chunk que no bajó, un error al
 * evaluar un módulo). Si llega, React ya se encarga de avisar él, así que ese
 * enlace sobra.
 */
export function markBootScriptRunning(): void {
  document.getElementById(SPLASH_ID)?.classList.add('boot-splash--js');
}

/** Marca que hay un aviso dentro, para esconder la barrita de «cargando». */
export function setBootStatusShown(shown: boolean): void {
  document.getElementById(SPLASH_ID)?.classList.toggle('boot-splash--status', shown);
}

// --- Parte nativa ----------------------------------------------------------

interface LaunchScreenPlugin {
  hide(): Promise<void>;
}

/** ios/App/App/AppViewController.swift. En web no existe. */
const LaunchScreen = registerPlugin<LaunchScreenPlugin>('LaunchScreen');

/**
 * La barra de estado va en blanco mientras se ve el azul, y el webview tiene
 * ese azul de fondo. Al irse la pantalla de entrada, las dos cosas vuelven a
 * las del sistema (texto oscuro en modo claro).
 */
function hideNativeLaunchAppearance(): void {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('LaunchScreen')) return;
  LaunchScreen.hide().catch((err) => console.error('LaunchScreen.hide:', err));
}

// --- Salida ---------------------------------------------------------------

/** Tope de espera a que termine la entrada del logo, por si la animación no avisa. */
const ENTRANCE_CAP_MS = 600;
/** Tope de espera al fundido de salida (dura 320 ms), por si `transitionend` no llega. */
const EXIT_CAP_MS = 700;
/** Tope de espera a que el hilo principal se libere antes de fundir. */
const IDLE_CAP_MS = 1500;
/** Dos fotogramas así de juntos (dos a 60 Hz) = no hubo una tarea larga en medio. */
const SMOOTH_FRAME_MS = 34;

/**
 * Espera a que el navegador vuelva a pintar a ritmo normal.
 *
 * Justo cuando la pantalla de destino se monta, sus efectos hacen el trabajo
 * pesado: el mapa arranca Mapbox y bloquea el hilo principal unos 700 ms
 * (medido en el simulador). Si el fundido empieza ahí, el navegador
 * no llega a pintarlo: la pantalla se queda congelada con el logo y salta de
 * golpe al mapa cuando el fundido ya «ha terminado». Esperando a dos
 * fotogramas seguidos, el fundido arranca con el hilo libre y se ve entero.
 */
function whenRenderingIsSmooth(): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    let last = 0;
    const tick = (t: number) => {
      if ((last && t - last < SMOOTH_FRAME_MS) || t - start > IDLE_CAP_MS) {
        resolve();
        return;
      }
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Sin fotogramas (pestaña oculta) rAF no corre: el tope lo resuelve igual.
    setTimeout(resolve, IDLE_CAP_MS);
  });
}

let hiding = false;

/**
 * Funde la pantalla de entrada y la quita del DOM. Idempotente.
 *
 * Antes de fundir espera dos cosas, y ninguna es un tiempo inventado:
 *   · a que termine la entrada del logo, si aún estaba en marcha (sin sesión
 *     pasa: no hay nada que pedir a la red). Cortarla a la mitad se ve como
 *     un parpadeo. Como mucho, lo que queda de medio segundo;
 *   · a que el hilo principal quede libre (whenRenderingIsSmooth), para que
 *     el fundido se pinte de verdad y no sea un salto.
 */
export function hideBootSplash(): void {
  if (hiding) return;
  hiding = true;

  const el = document.getElementById(SPLASH_ID);
  if (!el) {
    useBootSplash.setState({ visible: false });
    hideNativeLaunchAppearance();
    return;
  }

  const logo = el.querySelector('.boot-splash__logo');
  const entrance = logo?.getAnimations?.() ?? [];
  const entranceDone = Promise.all(entrance.map((a) => a.finished.catch(() => undefined)));
  const cap = new Promise((resolve) => setTimeout(resolve, ENTRANCE_CAP_MS));

  Promise.race([entranceDone, cap])
    .then(whenRenderingIsSmooth)
    .then(() => {
      useBootSplash.setState({ visible: false });
      el.setAttribute('aria-hidden', 'true');
      el.classList.add('boot-splash--out');

      let removed = false;
      const remove = () => {
        if (removed) return;
        removed = true;
        el.remove();
        // Al terminar el fundido y no al empezarlo: si la pantalla de debajo
        // aún no se hubiera pintado, el fondo del sistema (blanco en modo
        // claro) asomaría a mitad del fundido. Pasó con el mapa.
        hideNativeLaunchAppearance();
      };
      el.addEventListener('transitionend', (e) => {
        if (e.target === el) remove();
      });
      setTimeout(remove, EXIT_CAP_MS);
    });
}
