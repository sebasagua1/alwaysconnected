import { Suspense } from 'react';
import { useLocation } from 'react-router-dom';
import { BottomNav } from './BottomNav';
import { PageTransition } from './PageTransition';
import { useNotificationSync } from '@/hooks/useNotificationSync';
import { PendingInvite } from '@/components/friends/PendingInvite';
import { PushPrimer } from '@/components/notifications/PushPrimer';
import { useNotificationPrefsSync } from '@/hooks/useNotificationPrefsSync';

/** Rueda que ocupa solo el hueco del contenido, sin comerse la barra. */
function ContentSpinner() {
  return (
    <div className="h-screen-nav flex items-center justify-center">
      <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export function AppShell() {
  // Una sola suscripción para toda la app: los contadores los comparte el
  // store, así que no hace falta que cada pantalla monte la suya.
  useNotificationSync();
  // Zona horaria e idioma para el horario silencioso y el texto de las push.
  useNotificationPrefsSync();
  const { pathname } = useLocation();

  return (
    <div className="mx-auto sm:max-w-[430px] min-h-screen relative bg-background">
      {/* Suspense aquí dentro y no solo en App: las pantallas se cargan en
          diferido, y con la única frontera de arriba la primera visita a
          cada pestaña hacía desaparecer la barra inferior entera para poner
          una rueda a pantalla completa. Así solo parpadea el contenido. */}
      <Suspense fallback={<ContentSpinner />}>
        <PageTransition />
      </Suspense>
      {/* Franja opaca bajo la hora y la batería para las pantallas que hacen
          scroll. En el mapa no: el mapa no se desplaza y debe llegar hasta el
          borde, como en Mapas. z-40: por debajo de la barra inferior (z-50) y
          de hojas y diálogos (z-60 en adelante), que la tapan al abrirse. */}
      {pathname !== '/' && (
        <div
          aria-hidden="true"
          className="status-bar-scrim fixed inset-x-0 top-0 z-40 pointer-events-none bg-background/85 backdrop-blur-xl"
        />
      )}
      <BottomNav />
      <PendingInvite />
      <PushPrimer />
    </div>
  );
}
