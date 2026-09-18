/**
 * Las dos decisiones sutiles del envío por APNs, aparte y sin dependencias
 * para poder probarlas: cuándo reintentar en el otro entorno y cuándo dar un
 * token por muerto.
 *
 * Están fuera de send-push/index.ts porque ese archivo llama a serve() y lee
 * secretos al importarse, así que no se puede cargar desde una prueba.
 */

export type ApnsRespuesta = { status: number; reason?: string };

/**
 * APNs tiene dos hosts —producción y sandbox— y un token solo vale en el suyo.
 * Un mismo iPhone puede tener los dos: el de TestFlight es de producción y el
 * de un build instalado desde Xcode es de sandbox.
 *
 * Al mandar al host equivocado, Apple contesta 400 con uno de estos dos
 * motivos, y CUÁL de los dos no es predecible:
 *
 *   · BadDeviceToken        — "el token no vale, comprueba también el entorno"
 *   · DeviceTokenNotForTopic — "el token no corresponde a este topic"
 *
 * Solo se contemplaba el primero. El segundo se quedaba sin reintento y el
 * aviso se perdía en silencio: justo lo que le pasaba al teléfono de
 * desarrollo, mientras que a todo TestFlight le llegaba sin problema.
 */
export function reintentarEnSandbox(r: ApnsRespuesta): boolean {
  return r.status === 400 &&
    (r.reason === "BadDeviceToken" || r.reason === "DeviceTokenNotForTopic");
}

/**
 * Si se borra el token de la base. Conservador a propósito: un token borrado
 * de más deja a alguien sin notificaciones hasta que vuelva a abrir la app.
 *
 *   · 410 / Unregistered — la app se desinstaló. Definitivo, y del token.
 *   · BadDeviceToken en LOS DOS entornos — el token no vale en ninguno.
 *
 * DeviceTokenNotForTopic en los dos NO se borra, aunque tenga pinta de
 * definitivo: ese motivo también sale cuando APNS_BUNDLE_ID no coincide con
 * el Bundle ID de la app, que es un fallo de configuración del servidor y
 * afecta a TODO el mundo a la vez. Borrar ahí vaciaría device_tokens entera
 * por un secreto mal puesto, y la recuperación exige que cada persona vuelva
 * a abrir la app. Se deja la fila y que lo cante el registro.
 */
export function tokenMuerto(ultima: ApnsRespuesta, huboReintento: boolean): boolean {
  if (ultima.status === 410 || ultima.reason === "Unregistered") return true;
  return huboReintento && ultima.status === 400 && ultima.reason === "BadDeviceToken";
}
