import { Suspense } from 'react';
import { BottomNav } from './BottomNav';
import { PageTransition } from './PageTransition';
import { useNotificationSync } from '@/hooks/useNotificationSync';
import { PendingInvite } from '@/components/friends/PendingInvite';

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

  return (
    <div className="mx-auto sm:max-w-[430px] min-h-screen relative bg-background">
      {/* Suspense aquí dentro y no solo en App: las pantallas se cargan en
          diferido, y con la única frontera de arriba la primera visita a
          cada pestaña hacía desaparecer la barra inferior entera para poner
          una rueda a pantalla completa. Así solo parpadea el contenido. */}
      <Suspense fallback={<ContentSpinner />}>
        <PageTransition />
      </Suspense>
      <BottomNav />
      <PendingInvite />
    </div>
  );
}
