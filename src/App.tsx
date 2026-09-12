import { useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';
import { AppShell } from '@/components/layout/AppShell';
import Auth from '@/pages/Auth';
import { registerPush } from '@/lib/push';
import { initDeepLinks, setDeepLinkNavigator } from '@/lib/deepLinks';

// Rutas cargadas bajo demanda: mantienen el bundle inicial pequeño
// (importante en móvil). Auth se queda eager porque es el primer
// paint para usuarios sin sesión.
const Onboarding = lazy(() => import('@/pages/Onboarding'));
const MapHome = lazy(() => import('@/pages/MapHome'));
const MyEvents = lazy(() => import('@/pages/MyEvents'));
const Friends = lazy(() => import('@/pages/Friends'));
const Profile = lazy(() => import('@/pages/Profile'));
const GroupChat = lazy(() => import('@/pages/GroupChat'));
const NotFound = lazy(() => import('@/pages/NotFound'));
const ResetPassword = lazy(() => import('@/pages/ResetPassword'));

function PageSpinner() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function AuthGate() {
  const { user, session, profile, profileLoaded, loading, passwordRecovery, setPasswordRecovery, setSession, setLoading, fetchProfile } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    // Set up auth listener first
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // El enlace del correo abre sesión por su cuenta: sin esto el usuario
      // entraría directo a la app sin cambiar la contraseña.
      if (event === 'PASSWORD_RECOVERY') setPasswordRecovery(true);
      setSession(session);
      setLoading(false);
    });

    // Then check existing session
    supabase.auth.getSession().then(({ data: { session } }) => {
      // No pisar con null lo que ya haya en el store: en un arranque en frío
      // desde el enlace del correo, deepLinks.ts puede abrir la sesión mientras
      // esta lectura está en vuelo, y llegar después para dejarla en nada.
      if (session || !useAuthStore.getState().session) setSession(session);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, [setSession, setLoading, setPasswordRecovery]);

  // Fetch profile when user changes
  useEffect(() => {
    if (user) fetchProfile();
  }, [user, fetchProfile]);

  // Registro para push. En web no hace nada; en iOS pide permiso la primera
  // vez y renueva el token en cada arranque, que APNs los rota por su cuenta.
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

  if (loading) return <PageSpinner />;

  if (!session) return <Auth />;

  // Antes que el onboarding y que todo lo demás: la sesión existe, pero es la
  // que abrió el enlace de recuperación y solo sirve para cambiar la clave.
  if (passwordRecovery) return <ResetPassword />;

  // Esperar al perfil antes de decidir. Sin esto, con el perfil todavía sin
  // cargar se entraba a la app —montando el mapa entero, mapbox incluido— y un
  // instante después saltaba a onboarding.
  if (!profileLoaded) return <PageSpinner />;

  if (profile && !profile.onboarding_completed) return <Onboarding />;

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
          <Route path="/*" element={<AuthGate />}>
            <Route index element={<MapHome />} />
            <Route path="events" element={<MyEvents />} />
            <Route path="friends" element={<Friends />} />
            <Route path="groups/:id" element={<GroupChat />} />
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
