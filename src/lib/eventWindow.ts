/**
 * Cuándo se puede registrar asistencia en un evento.
 *
 * La ventana la manda la base de datos: `check_in_to_event()` acepta desde
 * 15 minutos ANTES de empezar y hasta que el evento termina (migración
 * 20260604130000, redefinida en 20260608010000 con el mismo margen).
 *
 * La interfaz enseñaba el botón solo a partir de `starts_at`, así que esos
 * 15 minutos no existían para nadie: el margen estaba escrito en el servidor
 * y era inalcanzable desde la app. Quien llegaba pronto veía la pantalla sin
 * botón, y el botón aparecía justo cuando ya estaba entrando al sitio.
 *
 * Vive aquí, y no dentro del componente, para que se pueda probar sin montar
 * medio mapa y para que el margen esté escrito UNA vez.
 */
export const CHECK_IN_GRACE_MS = 15 * 60 * 1000;

/**
 * ¿Cabe un check-in ahora mismo?
 *
 * `now` se inyecta en vez de leer `Date.now()` dentro para que las pruebas no
 * dependan del reloj de quien las corre.
 */
export function isWithinCheckInWindow(
  startsAt: string | Date,
  endsAt: string | Date,
  now: number = Date.now(),
): boolean {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();

  // Una fecha ilegible no abre la ventana: más vale no enseñar el botón que
  // enseñarlo y que el servidor devuelva OUTSIDE_EVENT_WINDOW.
  if (Number.isNaN(start) || Number.isNaN(end)) return false;

  return now >= start - CHECK_IN_GRACE_MS && now <= end;
}
