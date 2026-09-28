import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

/**
 * Respuesta táctil en las acciones que importan. En iOS las acciones
 * importantes «se sienten»; sin esto, unirse o publicar no daban ninguna.
 *
 * Con moderación: ni en scroll ni en cada toque, solo al confirmar algo.
 * En la web no hace nada, y un fallo del motor nunca rompe la acción.
 */
const isNative = Capacitor.isNativePlatform();

function run(fn: () => Promise<void>): void {
  if (!isNative) return;
  fn().catch(() => {});
}

export const haptic = {
  /** Toque ligero: enviar un mensaje, aprobar, unirse. */
  light: () => run(() => Haptics.impact({ style: ImpactStyle.Light })),
  /** Algo salió bien y es un logro: publicar un evento, hacer check-in. */
  success: () => run(() => Haptics.notification({ type: NotificationType.Success })),
  /** No se pudo: check-in lejos, evento lleno. */
  warning: () => run(() => Haptics.notification({ type: NotificationType.Warning })),
  /** Cambio de selección (pastillas, pasos). */
  selection: () => run(() => Haptics.selectionChanged()),
};
