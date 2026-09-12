// Social login nativo (iOS) con @capgo/capacitor-social-login → Supabase.
//
// Flujo: el plugin hace el sign-in nativo de Apple/Google y devuelve un
// idToken (JWT). Ese token se canjea con Supabase vía signInWithIdToken,
// que crea/recupera la sesión. Evita el OAuth por redirect (que se rompe
// en el webview de Capacitor).
//
// Config necesaria (ver APP_STORE.md):
// - Apple: capability "Sign in with Apple" en Xcode (usa el entitlement;
//   en iOS nativo NO requiere clientId) + proveedor Apple en Supabase.
// - Google: iOS + Web OAuth Client IDs en Google Cloud, puestos en las
//   env vars de abajo, + proveedor Google en Supabase con esos client IDs
//   como "Authorized Client IDs".
import { Capacitor } from '@capacitor/core';
import { SocialLogin } from '@capgo/capacitor-social-login';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';

const GOOGLE_IOS_CLIENT_ID = import.meta.env.VITE_GOOGLE_IOS_CLIENT_ID as string | undefined;
const GOOGLE_WEB_CLIENT_ID = import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID as string | undefined;

export const isNative = Capacitor.isNativePlatform();

// El botón de Google nativo solo se muestra si los client IDs están puestos.
// Apple no necesita config extra en iOS (usa el entitlement).
export const googleNativeConfigured = Boolean(GOOGLE_IOS_CLIENT_ID && GOOGLE_WEB_CLIENT_ID);

let initPromise: Promise<void> | null = null;

function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = SocialLogin.initialize({
      apple: {}, // iOS usa el entitlement; clientId/redirectUrl son para web/Android
      ...(googleNativeConfigured
        ? { google: { iOSClientId: GOOGLE_IOS_CLIENT_ID, webClientId: GOOGLE_WEB_CLIENT_ID } }
        : {}),
    });
  }
  return initPromise;
}

async function exchangeIdToken(provider: 'apple' | 'google', idToken: string | null) {
  if (!idToken) throw new Error(`No se recibió idToken de ${provider}`);
  const { error } = await supabase.auth.signInWithIdToken({ provider, token: idToken });
  if (error) throw error;
}

/** "Juan" + "Pérez" -> "Juan Pérez". null si el proveedor no mandó nada. */
function joinName(given: string | null, family: string | null): string | null {
  const full = [given, family].filter(Boolean).join(' ').trim();
  return full || null;
}

/**
 * Guarda el nombre que entrega el proveedor, si el perfil todavía no tiene uno.
 *
 * Esto NO es un adorno: Apple solo manda el nombre la PRIMERA vez que se
 * autoriza la app —en los inicios de sesión siguientes llega vacío, y no hay
 * forma de volver a pedirlo—. Si no se guarda en este instante se pierde para
 * siempre, y a la persona no le queda más que teclearlo. Eso es exactamente lo
 * que prohíbe la guideline 4 de Apple, y es por lo que rechazaron la 1.0 (18).
 *
 * El trigger de alta (handle_new_user) crea el perfil con `name` en null, así
 * que en un registro nuevo esto es lo único que lo rellena.
 */
async function saveProviderName(name: string | null): Promise<void> {
  if (!name) return;

  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;
    if (!user) return;

    const { data: existing, error: readError } = await supabase
      .from('profiles')
      .select('name')
      .eq('id', user.id)
      .single();
    if (readError) throw readError;

    // Lo que la persona haya escrito manda sobre lo que diga el proveedor: en
    // un alta esto es null, pero si ya editó su perfil no se le pisa.
    if (existing?.name) return;

    const { error } = await supabase.from('profiles').update({ name }).eq('id', user.id);
    if (error) throw error;

    // Releer: App.tsx dispara su fetchProfile en cuanto hay sesión, o sea
    // ANTES de que esta escritura exista. Sin este refresco el store se queda
    // con name en null y el onboarding pinta el campo vacío — el nombre estaría
    // guardado y aun así se le pediría a la persona, que es el fallo entero.
    await useAuthStore.getState().fetchProfile();
  } catch (err) {
    // Sin toast y sin throw: la sesión ya está abierta y tumbar el login por
    // esto sería peor. El onboarding sigue dejando escribir el nombre a mano.
    console.error('saveProviderName:', err);
  }
}

export async function signInWithAppleNative(): Promise<void> {
  await ensureInitialized();
  const { result } = await SocialLogin.login({
    provider: 'apple',
    options: { scopes: ['email', 'name'] },
  });
  await exchangeIdToken('apple', result.idToken);
  // Después del canje, no antes: hasta que no hay sesión no existe el perfil
  // que hay que rellenar, ni permiso de RLS para escribirlo.
  await saveProviderName(joinName(result.profile.givenName, result.profile.familyName));
}

export async function signInWithGoogleNative(): Promise<void> {
  await ensureInitialized();
  const { result } = await SocialLogin.login({
    provider: 'google',
    options: { scopes: ['email', 'profile'] },
  });
  // El plugin tiene dos formas de respuesta: la "online" trae idToken y la
  // "offline" solo un serverAuthCode. Pedimos la primera, pero el tipo
  // contempla ambas y sin distinguirlas `result.idToken` no existe. Además
  // el mensaje concreto ahorra adivinar si algún día llega la otra.
  if (result.responseType !== 'online') {
    throw new Error('Google devolvió un código de servidor, no un idToken');
  }
  await exchangeIdToken('google', result.idToken);
  // Google sí lo manda en cada inicio de sesión, pero se guarda igual para que
  // el onboarding se comporte igual con los dos proveedores.
  await saveProviderName(
    result.profile.name ?? joinName(result.profile.givenName, result.profile.familyName),
  );
}
