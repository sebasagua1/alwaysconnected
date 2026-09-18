import type { CapacitorConfig } from '@capacitor/cli';

// NOTA: `appId` es el Bundle ID que registrarás en tu cuenta de
// Apple Developer. Cámbialo si prefieres otro identificador; debe
// ser único y en formato DNS inverso. Una vez creado el proyecto
// iOS, cambiarlo implica regenerarlo, así que decídelo antes de
// correr `npx cap add ios`.
const config: CapacitorConfig = {
  appId: 'com.alwaysconnected.app',
  appName: 'Always Connected',
  webDir: 'dist',
  plugins: {
    PushNotifications: {
      // Sin esto iOS NO enseña nada mientras la app está abierta: el plugin
      // arranca con la lista de opciones vacía y le dice al sistema que no
      // presente el aviso. La push llega, dispara 'pushNotificationReceived'
      // y muere ahí, sin banner ni sonido. Es el motivo más común de "no me
      // llegan las notificaciones" cuando en realidad sí llegaban.
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
