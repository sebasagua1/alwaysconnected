import { useEffect, useRef, useState } from 'react';
import { checkPermission, isNativeGeo, watchPosition } from '@/lib/geo';

export type GeoPermissionStatus = 'prompt' | 'granted' | 'denied' | 'unsupported';

export interface UserLocation {
  lng: number;
  lat: number;
  accuracy: number;
  heading: number | null;
  speed: number | null;
  timestamp: number;
}

interface Options {
  enabled?: boolean;
  enableHighAccuracy?: boolean;
  maximumAge?: number;
  timeout?: number;
}

/**
 * Sigue la ubicación de forma continua. En nativo va contra CoreLocation y en
 * web contra `navigator.geolocation`; de esconder la diferencia se encarga
 * lib/geo.ts. Pensado para móvil: alta precisión, con `maximumAge` limitando
 * cuántas lecturas llegan.
 */
export function useUserLocation(options: Options = {}) {
  const {
    enabled = true,
    enableHighAccuracy = true,
    maximumAge = 5000,
    timeout = 15000,
  } = options;

  const [location, setLocation] = useState<UserLocation | null>(null);
  const [error, setError] = useState<GeolocationPositionError | null>(null);
  const [permission, setPermission] = useState<GeoPermissionStatus>('prompt');
  // El GPS de alta precisión no tiene por qué seguir encendido con la pantalla
  // tapada o la pestaña en segundo plano. En iOS el webview se suspende solo,
  // pero en la web una pestaña de fondo seguiría consumiendo indefinidamente.
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );

  useEffect(() => {
    const alCambiar = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', alCambiar);
    return () => document.removeEventListener('visibilitychange', alCambiar);
  }, []);

  /**
   * Si el propio geolocation ya se ha pronunciado, en un sentido o en otro.
   *
   * A partir de ahí su palabra es la única que vale y el sondeo deja de tocar
   * nada: es lo observado contra lo que otra capa opina.
   */
  const decididoPorGeoRef = useRef(false);

  // Sondeo del estado del permiso.
  //
  // OJO con lo que este sondeo vale y lo que NO vale. En WEB responde
  // `navigator.permissions`, y dentro de un webview eso contesta por el origen
  // de la página (capacitor://localhost), que no tiene nada que ver con la
  // autorización nativa de CoreLocation: puede decir `denied` con el GPS
  // entregando posiciones.
  //
  // En NATIVO ya no se le pregunta a él, sino a CoreLocation a través del
  // plugin (ver lib/geo.ts), que sí dice la verdad. Aun así se mantiene la
  // misma regla en los dos casos: el sondeo NUNCA declara denegado, solo
  // adelanta un `granted`. Quien declara denegado es el error
  // PERMISSION_DENIED del propio watch, que es el que habla con el sistema.
  useEffect(() => {
    if (!isNativeGeo && !navigator.geolocation) {
      setPermission('unsupported');
      return;
    }

    let cancelado = false;
    const aplicar = (estado: string) => {
      if (cancelado) return;
      // En cuanto geolocation ha dicho algo, el sondeo se calla. Sin esto, su
      // promesa resolvía DESPUÉS de un PERMISSION_DENIED real y devolvía el
      // estado a `prompt`, tapando una denegación de verdad.
      if (decididoPorGeoRef.current) return;
      // Y lo único que puede aportar es adelantar un `granted`. `denied` se
      // ignora siempre —miente dentro del webview— y `prompt` ya es el valor
      // inicial, así que no añade nada.
      if (estado === 'granted') setPermission('granted');
    };

    if (isNativeGeo) {
      checkPermission()
        .then((estado) => { if (estado) aplicar(estado); })
        .catch(() => {});
      return () => { cancelado = true; };
    }

    if (!('permissions' in navigator) || !navigator.permissions?.query) return;

    navigator.permissions
      .query({ name: 'geolocation' })
      .then((res) => {
        aplicar(res.state);
        res.onchange = () => aplicar(res.state);
      })
      // En WebKit 'geolocation' no siempre es un nombre válido y la promesa
      // se rechaza. No es un fallo: simplemente no hay sondeo.
      .catch(() => {});

    return () => { cancelado = true; };
  }, []);

  useEffect(() => {
    // Al ocultarse, la limpieza de este efecto suelta el reloj; al volver, se
    // vuelve a suscribir y la primera lectura llega en unos segundos.
    if (!enabled || !visible) return;
    if (!isNativeGeo && !navigator.geolocation) {
      setPermission('unsupported');
      return;
    }

    // En nativo suscribirse es asíncrono —hay que pedir permiso antes—, así que
    // la limpieza puede llegar antes que la suscripción. Eso lo resuelve
    // watchPosition por dentro devolviendo siempre una función que suelta.
    let soltar: (() => void) | null = null;
    let soltado = false;

    watchPosition(
      { enableHighAccuracy, maximumAge, timeout },
      (pos) => {
        setError(null);
        decididoPorGeoRef.current = true;
        setPermission('granted');
        setLocation({
          lng: pos.coords.longitude,
          lat: pos.coords.latitude,
          accuracy: pos.coords.accuracy,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
          timestamp: pos.timestamp,
        });
      },
      (err) => {
        setError(err);
        if (err.code === err.PERMISSION_DENIED) {
          decididoPorGeoRef.current = true;
          setPermission('denied');
        }
      },
    )
      .then((fn) => {
        if (soltado) { fn(); return; }
        soltar = fn;
      })
      .catch(() => {});

    return () => {
      soltado = true;
      soltar?.();
      soltar = null;
    };
  }, [enabled, visible, enableHighAccuracy, maximumAge, timeout]);

  return { location, error, permission };
}
