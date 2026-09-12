import { Capacitor } from '@capacitor/core';
import { Geolocation, type Position } from '@capacitor/geolocation';

/**
 * Ubicación: CoreLocation en nativo, `navigator.geolocation` en web.
 *
 * El motivo de que esto exista no es técnico, es lo que lee el usuario. Con
 * `navigator.geolocation` dentro del WKWebView quien pide permiso es WebKit, y
 * lo pide en nombre del ORIGEN de la página — que es `capacitor://localhost`.
 * El aviso decía literalmente «"localhost" would like to use your current
 * location», que además de quedar mal delata que dentro hay un webview. El
 * plugin habla con CoreLocation, así que sale el aviso del sistema con el
 * nombre de la app y el texto de NSLocationWhenInUseUsageDescription.
 *
 * Es el mismo origen que ya envenenaba el sondeo de permisos: ver
 * useUserLocation, donde `navigator.permissions` puede decir `denied` con el
 * GPS entregando posiciones.
 */

export const isNativeGeo = Capacitor.isNativePlatform();

export interface GeoOptions {
  enableHighAccuracy?: boolean;
  maximumAge?: number;
  timeout?: number;
}

/**
 * Los errores salen con la MISMA forma que GeolocationPositionError, constantes
 * incluidas, para que quien los recibe no tenga que saber por qué camino
 * vinieron. MapHome compara contra `err.PERMISSION_DENIED`.
 */
function geoError(code: 1 | 2 | 3, message: string): GeolocationPositionError {
  return {
    code,
    message,
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  } as GeolocationPositionError;
}

function aPosicionWeb(p: Position): GeolocationPosition {
  return {
    timestamp: p.timestamp,
    coords: {
      latitude: p.coords.latitude,
      longitude: p.coords.longitude,
      accuracy: p.coords.accuracy,
      altitude: p.coords.altitude ?? null,
      altitudeAccuracy: p.coords.altitudeAccuracy ?? null,
      heading: p.coords.heading ?? null,
      speed: p.coords.speed ?? null,
    },
  } as GeolocationPosition;
}

/**
 * Pide permiso si todavía no se ha decidido. Devuelve el estado final.
 *
 * Este es el punto donde sale el aviso nativo, y por eso se llama de forma
 * explícita en vez de dejar que lo dispare la primera lectura.
 */
async function asegurarPermiso(): Promise<'granted' | 'denied' | 'prompt'> {
  let estado = await Geolocation.checkPermissions();
  if (estado.location !== 'granted' && estado.location !== 'denied') {
    estado = await Geolocation.requestPermissions();
  }
  if (estado.location === 'granted') return 'granted';
  if (estado.location === 'denied') return 'denied';
  return 'prompt';
}

/**
 * Estado del permiso sin pedirlo. `null` en web: ahí lo sondea el propio hook
 * con `navigator.permissions`, que es lo único que hay.
 */
export async function checkPermission(): Promise<'granted' | 'denied' | 'prompt' | null> {
  if (!isNativeGeo) return null;
  try {
    const { location } = await Geolocation.checkPermissions();
    if (location === 'granted') return 'granted';
    if (location === 'denied') return 'denied';
    return 'prompt';
  } catch {
    return null;
  }
}

/**
 * Sigue la posición. Devuelve la función con la que se suelta.
 *
 * Es asíncrona porque en nativo hay que pedir permiso antes, así que quien la
 * llama puede querer soltarla ANTES de que llegue a suscribirse; ese caso está
 * contemplado abajo, o quedaría un reloj encendido para siempre.
 */
export async function watchPosition(
  options: GeoOptions,
  onPosition: (pos: GeolocationPosition) => void,
  onError: (err: GeolocationPositionError) => void,
): Promise<() => void> {
  if (!isNativeGeo) {
    if (!navigator.geolocation) {
      onError(geoError(2, 'Geolocation no disponible'));
      return () => {};
    }
    const id = navigator.geolocation.watchPosition(onPosition, onError, options);
    return () => navigator.geolocation.clearWatch(id);
  }

  let cancelado = false;
  let idReloj: string | null = null;
  const soltar = () => {
    cancelado = true;
    if (idReloj) {
      void Geolocation.clearWatch({ id: idReloj });
      idReloj = null;
    }
  };

  try {
    if ((await asegurarPermiso()) === 'denied') {
      onError(geoError(1, 'User denied Geolocation'));
      return soltar;
    }
    if (cancelado) return soltar;

    const id = await Geolocation.watchPosition(options, (pos, err) => {
      if (err) {
        onError(geoError(2, err.message ?? 'Geolocation falló'));
        return;
      }
      if (pos) onPosition(aPosicionWeb(pos));
    });

    // Soltado mientras se suscribía: el reloj existe ya, hay que apagarlo.
    if (cancelado) {
      void Geolocation.clearWatch({ id });
      return soltar;
    }
    idReloj = id;
  } catch (err) {
    onError(geoError(2, err instanceof Error ? err.message : 'Geolocation falló'));
  }

  return soltar;
}

/** Una sola lectura. La usa el check-in. */
export async function getCurrentPosition(options: GeoOptions = {}): Promise<GeolocationPosition> {
  if (!isNativeGeo) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(geoError(2, 'Geolocation no disponible'));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, options);
    });
  }

  if ((await asegurarPermiso()) === 'denied') {
    throw geoError(1, 'User denied Geolocation');
  }
  return aPosicionWeb(await Geolocation.getCurrentPosition(options));
}
