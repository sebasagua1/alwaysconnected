import { useEffect, useState, Suspense } from 'react';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';
import { AppShell } from '@/components/layout/AppShell';
import Auth from '@/pages/Auth';
import { registerPush } from '@/lib/push';
import { initDeepLinks, setDeepLinkNavigator } from '@/lib/deepLinks';
import { markSignedIn } from '@/lib/authHints';
import { BootReady, StartupStatus } from '@/components/boot/StartupStatus';
import { lazyPage } from '@/lib/lazyPage';

// Rutas cargadas bajo demanda: mantienen el bundle inicial pequeño
// (importante en móvil). Auth se queda eager porque es el primer
// paint para usuarios sin sesión.
const Onboarding = lazyPage(() => import('@/pages/Onboarding'));
const MapHome = lazyPage(() => import('@/pages/MapHome'));
const MyEvents = lazyPage(() => import('@/pages/MyEvents'));
const Friends = lazyPage(() => import('@/pages/Friends'));
const Profile = lazyPage(() => import('@/pages/Profile'));
const GroupChat = lazyPage(() => import('@/pages/GroupChat'));
const EventChat = lazyPage(() => import('@/pages/EventChat'));
const FindFriends = lazyPage(() => import('@/pages/FindFriends'));
const InviteLanding = lazyPage(() => import('@/pages/InviteLanding'));
const Notifications = lazyPage(() => import('@/pages/Notifications'));
const NotificationSettings = lazyPage(() => import('@/pages/NotificationSettings'));
const EventDetail = lazyPage(() => import('@/pages/EventDetail'));
const NotFound = lazyPage(() => import('@/pages/NotFound'));
const ResetPassword = lazyPage(() => import('@/pages/ResetPassword'));

/**
 * Pantallas que se precargan en cuanto la app está dentro, sin esperar a que
 * alguien las abra: las cuatro pestañas y lo que más se abre desde ellas.
 * Sin esto, la primera visita a cada una enseñaba la rueda mientras bajaba su
 * código y entraba a saltos.
 */
const PRELOAD = [MapHome, MyEvents, Friends, Profile, Notifications, GroupChat, EventChat, EventDetail];

/** Tras el arranque, para no competir con lo que se está pintando. */
const PRELOAD_DELAY_MS = 1200;

function preloadScreens(): void {
  // De una en una: cada trozo se evalúa en el hilo principal, y todas a la
  // vez podían trabar un toque justo en ese momento.
  PRELOAD.reduce<Promise<unknown>>(
    (prev, page) => prev.then(() => page.preload()).catch(() => undefined),
    Promise.resolve(),
  );
}

function PageSpinner() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

/** A partir de aquí, si el arranque sigue sin resolverse, se dice y se ofrece salida. */
const SLOW_START_MS = 6000;

/** true cuando `active` lleva `ms` seguidos en true. */
function useTakingLong(active: boolean, ms: number): boolean {
  const [long, setLong] = useState(false);
  useEffect(() => {
    if (!active) {
      setLong(false);
      return;
    }
    const id = setTimeout(() => setLong(true), ms);
    return () => clearTimeout(id);
  }, [active, ms]);
  return long;
}

/**
 * Mientras se resuelve la sesión o llega el perfil.
 *
 * Durante el arranque no se ve: la tapa la pantalla de entrada. Antes aquí
 * solo había una rueda, sin límite y sin salida; ahora, pasados unos segundos,
 * dice qué pasa y deja reintentar. Reintentar RECARGA: si lo que se colgó fue
 * la renovación del token, supabase-js tiene esa promesa guardada y todas las
 * llamadas siguientes esperan detrás de ella; empezar de cero es lo único que
 * la suelta.
 */
function Pending({ slow }: { slow: boolean }) {
  const { t } = useTranslation();
  if (!slow) return <PageSpinner />;
  return (
    <StartupStatus
      tone="slow"
      title={t('boot.slowTitle')}
      body={t('boot.slowBody')}
      onRetry={() => window.location.reload()}
    />
  );
}

function AuthGate() {
  const { t } = useTranslation();
  const {
    user, session, profile, profileLoaded, profileError, profileFetching, loading, sessionError,
    passwordRecovery, setPasswordRecovery, setSession, resolveSession, fetchProfile, signOut,
  } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    // Set up auth listener first
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // El enlace del correo abre sesión por su cuenta: sin esto el usuario
      // entraría directo a la app sin cambiar la contraseña.
      if (event === 'PASSWORD_RECOVERY') setPasswordRecovery(true);
      // El estado inicial lo decide resolveSession(). Este evento llega con
      // null tanto si no hay sesión como si la había pero no se pudo renovar
      // por falta de red, y en ese segundo caso mandaba al login a quien no
      // había cerrado sesión.
      if (event === 'INITIAL_SESSION') return;
      setSession(session);
      // Cualquier otro evento es una respuesta de verdad: si había un aviso
      // de «sin conexión» y el refresco automático lo logra, se entra solo.
      useAuthStore.setState({ loading: false, sessionError: null });
    });

    // Then check existing session
    resolveSession();

    return () => subscription.unsubscribe();
  }, [setSession, setPasswordRecovery, resolveSession]);

  // Fetch profile when user changes
  useEffect(() => {
    if (user) fetchProfile();
    // Para que la pantalla de acceso abra en «Iniciar sesión» la próxima vez.
    if (user) markSignedIn();
  }, [user, fetchProfile]);

  // Con la app ya dentro, se bajan en segundo plano las demás pantallas.
  const inApp = !!session && profileLoaded && !passwordRecovery && !(profile && !profile.onboarding_completed);
  useEffect(() => {
    if (!inApp) return;
    const id = setTimeout(preloadScreens, PRELOAD_DELAY_MS);
    return () => clearTimeout(id);
  }, [inApp]);

  // Registro para push. En web no hace nada; en iOS renueva el token en cada
  // arranque (APNs los rota por su cuenta) SOLO si ya había permiso. La
  // pregunta ya no sale aquí, en frío: la hace PushPrimer después de algo que
  // la justifique. Ver lib/push.ts.
  useEffect(() => {
    if (user) registerPush();
  }, [user]);

  // Enlaces profundos y salto al tocar una notificación. AuthGate va dentro de
  // <BrowserRouter>, así que aquí sí hay router al que entregarle la ruta.
  useEffect(() => {
    setDeepLinkNavigator((route) => navigate(route));
    initDeepLinks();
    return () => setDeepLinkNavigator(null);
  }, [navigate]);

  // Todo lo que todavía no permite decidir a qué pantalla ir.
  const pending = loading || (!!session && !passwordRecovery && !profileLoaded && !profileError);
  const slow = useTakingLong(pending, SLOW_START_MS);

  // Antes que `loading`: al pulsar Reintentar vuelve a cargar, y el aviso
  // se queda puesto (con el botón en «Reintentando…») hasta que haya respuesta.
  if (sessionError) {
    const offline = sessionError === 'network';
    return (
      <StartupStatus
        tone="error"
        title={t(offline ? 'boot.offlineTitle' : 'boot.errorTitle')}
        body={t(offline ? 'boot.offlineBody' : 'boot.errorBody')}
        onRetry={resolveSession}
        retrying={loading}
      />
    );
  }

  if (loading) return <Pending slow={slow} />;

  // <BootReady /> va junto a cada pantalla de destino, dentro del mismo
  // Suspense: la pantalla de entrada se va cuando la de destino está montada,
  // no antes (el fallback de Suspense quedaría a la vista).
  if (!session) return <><Auth /><BootReady /></>;

  // Antes que el onboarding y que todo lo demás: la sesión existe, pero es la
  // que abrió el enlace de recuperación y solo sirve para cambiar la clave.
  if (passwordRecovery) return <><ResetPassword /><BootReady /></>;

  if (profileError) {
    return (
      <StartupStatus
        tone="error"
        title={t('boot.profileTitle')}
        body={t('boot.profileBody')}
        onRetry={fetchProfile}
        retrying={profileFetching}
        secondary={{ label: t('boot.signOut'), onClick: signOut }}
      />
    );
  }

  // Esperar al perfil antes de decidir. Sin esto, con el perfil todavía sin
  // cargar se entraba a la app —montando el mapa entero, mapbox incluido— y un
  // instante después saltaba a onboarding.
  if (!profileLoaded) return <Pending slow={slow} />;

  if (profile && !profile.onboarding_completed) return <><Onboarding /><BootReady /></>;

  // El <BootReady /> de la app va dentro de AppShell, junto a la pantalla de
  // la ruta (que es diferida y tiene su propio Suspense).
  return (
    <AppShell />
  );
}

const App = () => (
  <TooltipProvider>
    <Toaster />
    <BrowserRouter>
      <Suspense fallback={<PageSpinner />}>
        <Routes>
          {/* Pública: quien abre una invitación sin la app ni cuenta. */}
          <Route path="/i/:code" element={<><InviteLanding /><BootReady /></>} />
          <Route path="/*" element={<AuthGate />}>
            <Route index element={<MapHome />} />
            <Route path="events" element={<MyEvents />} />
            <Route path="friends" element={<Friends />} />
            <Route path="friends/find" element={<FindFriends />} />
            <Route path="groups/:id" element={<GroupChat />} />
            <Route path="events/:eventId/chat" element={<EventChat />} />
            <Route path="event/:id" element={<EventDetail />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="settings/notifications" element={<NotificationSettings />} />
            <Route path="profile" element={<Profile />} />
            {/* Dentro de AuthGate a propósito: la ruta padre es "/*" y captura
                todo, así que un "*" hermano nunca llegaba a evaluarse y una URL
                desconocida dejaba el Outlet vacío — pantalla en blanco con la
                barra de abajo. */}
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  </TooltipProvider>
);

export default App;
