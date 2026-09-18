import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { supabase } from '@/integrations/supabase/client';
import { useNotificationStore } from '@/stores/notificationStore';

/**
 * Registro del dispositivo para notificaciones push.
 *
 * Solo corre en nativo: en el navegador el plugin no existe y las push web
 * son otra tecnología (VAPID), que no es lo que estamos montando.
 */

const isNative = Capacitor.isNativePlatform();

/**
 * Último token que APNs nos dio. NO se borra al cerrar sesión: el token
 * pertenece al teléfono, no a la cuenta. Guardarlo permite reasignarlo a la
 * cuenta nueva sin depender de que iOS vuelva a emitir 'registration'.
 */
let deviceToken: string | null = null;

/** El token que está dado de alta en la base ahora mismo (para la baja). */
let registeredToken: string | null = null;

let listenersReady = false;

/** Una sola inicialización en vuelo: el efecto de React puede reentrar. */
let inFlight: Promise<void> | null = null;

/** Alta (o renovación) del token en la base. Idempotente por el lado del SQL. */
async function saveToken(token: string): Promise<void> {
  deviceToken = token;
  const { error } = await supabase.rpc('register_device_token', {
    _token: token,
    _platform: 'ios',
  });
  if (error) {
    // Sin esto el fallo es invisible: el teléfono cree estar registrado y la
    // base no tiene fila, así que push_send() ni llega a llamar a APNs.
    console.error('register_device_token:', error.message);
    return;
  }
  registeredToken = token;
}

async function attachListeners(): Promise<void> {
  await PushNotifications.addListener('registration', (token) => {
    saveToken(token.value).catch((err) => console.error('registration:', err));
  });

  await PushNotifications.addListener('registrationError', (err) => {
    // Lo más común aquí es que falte la capacidad Push Notifications en el
    // perfil de aprovisionamiento.
    console.error('Fallo al registrar en APNs:', JSON.stringify(err));
  });

  // Push recibida con la app abierta. iOS ya enseña el banner (ver
  // presentationOptions en capacitor.config.ts), pero los contadores de la
  // barra inferior no se enterarían: el aviso viaja por APNs, no por el
  // websocket de realtime, y varios de los disparos (invitación a grupo,
  // aprobación) tocan tablas que no publican cambios.
  await PushNotifications.addListener('pushNotificationReceived', () => {
    void useNotificationStore.getState().refresh();
  });
}

/**
 * Pide permiso y registra el dispositivo. Idempotente: APNs rota los tokens
 * por su cuenta, así que esto se llama en cada arranque con sesión abierta.
 */
export async function registerPush(): Promise<void> {
  if (!isNative) return;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      // checkPermissions primero: si ya se concedió, no se vuelve a preguntar,
      // y si el usuario lo denegó una vez, iOS ya no muestra el diálogo — pedirlo
      // otra vez no molesta pero tampoco sirve.
      let permission = await PushNotifications.checkPermissions();
      if (permission.receive === 'prompt' || permission.receive === 'prompt-with-rationale') {
        permission = await PushNotifications.requestPermissions();
      }
      if (permission.receive !== 'granted') {
        // El caso más habitual de "no me llegan": el permiso se denegó en su
        // día y iOS ya no vuelve a preguntar. Hay que ir a Ajustes.
        console.warn(`Push sin permiso del sistema (${permission.receive}).`);
        return;
      }

      if (!listenersReady) {
        // La bandera se levanta DESPUÉS de tener los oyentes puestos. Al
        // revés, una segunda llamada solapada se los saltaba y podía llamar a
        // register() antes de que existiera el oyente de 'registration': el
        // token se perdía y el fallo era mudo.
        await attachListeners();
        listenersReady = true;
      }

      await PushNotifications.register();

      // Reasignación tras cambiar de cuenta en el mismo teléfono. iOS suele
      // reemitir 'registration' con el token cacheado, pero no lo promete; si
      // ya conocemos el token, lo damos de alta igual. El ON CONFLICT del SQL
      // hace que sobre escribir dos veces no cueste nada.
      if (deviceToken && deviceToken !== registeredToken) {
        await saveToken(deviceToken);
      }
    } catch (err) {
      console.error('registerPush:', err);
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Baja del dispositivo. Sin esto, el teléfono seguiría recibiendo
 * notificaciones de la cuenta que acaba de cerrar sesión.
 */
export async function unregisterPush(): Promise<void> {
  if (!isNative) return;
  const token = registeredToken ?? deviceToken;
  if (!token) return;
  registeredToken = null;
  const { error } = await supabase.rpc('unregister_device_token', { _token: token });
  if (error) console.error('unregister_device_token:', error.message);
}
