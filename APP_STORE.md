# Publicar Always Connected en la App Store (iOS)

La app es una **PWA** que se empaqueta como app nativa con **Capacitor**. El proyecto
JS ya está preparado (deps + `capacitor.config.ts` + scripts). Faltan pasos que dependen
de tu Mac y de tu cuenta de Apple.

---

## 0. Prerrequisitos (los instalas tú, una vez)

1. **Xcode** (completo, no solo Command Line Tools) — desde la **Mac App Store** (~15 GB).
   Luego apúntalo como toolchain activa:
   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept
   ```
2. **Cuenta de Apple Developer Program** — inicia sesión en
   Xcode → Settings → Accounts.

Verifica que quedó todo:
```bash
xcodebuild -version
```

> **Nada de CocoaPods.** Las dependencias nativas van por **Swift Package
> Manager**, que viene dentro de Xcode: no hay `Podfile` ni `pod install` en
> este proyecto. `npx cap sync ios` escribe `ios/App/CapApp-SPM/Package.swift`
> y Xcode resuelve los paquetes al abrir. Si el build falla con algo de
> paquetes, la salida suele ser **File → Packages → Reset Package Caches**.

---

## 1. Confirma el Bundle ID

En `capacitor.config.ts`, `appId` es `com.alwaysconnected.app`. Es el identificador que
registrarás en Apple. **Decídelo ahora** — cambiarlo después de crear el proyecto iOS
obliga a regenerarlo. Debe ser DNS inverso y único.

---

## 2. Sincroniza el proyecto iOS

La carpeta `ios/` **ya está en el repositorio**, así que no hay que generarla: sus
capacidades, entitlements y número de build están versionados. Basta con:

```bash
cd ~/Developer/tec-spotter-app
npm run ios:sync    # build web + copia el dist al proyecto nativo
```

> `ios:sync` = `npm run build && npx cap sync ios`. Córrelo **cada vez** que cambies
> el código web, y en particular **justo antes de archivar**: si no, el build que
> subes lleva los assets de la última sincronización, no los de ahora.

`npx cap add ios` solo haría falta para regenerar el proyecto desde cero, y
borraría la configuración nativa que ya está commiteada. No lo corras salvo que
sepas que quieres exactamente eso.

---

## 3. Configura capacidades nativas (Info.plist)

Abre el proyecto: `npm run ios:open`. En Xcode, target **App → Info**, agrega:

- **`NSLocationWhenInUseUsageDescription`** (OBLIGATORIO — la app usa el GPS para el mapa
  y el check-in):
  > "Always Connected usa tu ubicación para mostrarte eventos cercanos y validar tu asistencia."

Sin esta clave, iOS mata la app al pedir ubicación **y** Apple rechaza el envío.

---

## 4. Social login (Apple + Google) — setup

El código ya está implementado: en iOS nativo se usa el plugin
`@capgo/capacitor-social-login` (sign-in nativo → `signInWithIdToken` de Supabase,
sin el redirect que se rompe en el webview). Falta la config de cuentas/proveedores.

### 4.1 Sign in with Apple (obligatorio si ofreces Google — guideline 4.8)
1. **Xcode** (`npm run ios:open`) → target **App → Signing & Capabilities** →
   **+ Capability → "Sign in with Apple"**. Esto añade el entitlement y registra la
   capability en tu App ID del portal de Apple Developer.
2. **Supabase** → Authentication → Providers → **Apple** → activar. En *Authorized Client IDs*
   agrega tu Bundle ID: `com.alwaysconnected.app`. (Para el flujo nativo por idToken basta el
   Bundle ID; el Services ID/secret solo hace falta para Apple en web.)

### 4.2 Google Sign-In nativo
1. **Google Cloud** → Credentials → crea **dos** OAuth Client IDs:
   - Tipo **iOS** → Bundle ID `com.alwaysconnected.app`. Copia el *iOS client ID*.
   - Tipo **Web** → copia el *Web client ID* (y su secret, para Supabase).
2. **Env vars** (se hornean en el build; ponlas ANTES de `npm run ios:sync`):
   ```
   VITE_GOOGLE_IOS_CLIENT_ID=xxxx.apps.googleusercontent.com
   VITE_GOOGLE_WEB_CLIENT_ID=yyyy.apps.googleusercontent.com
   ```
   Sin ambas, el botón de Google en iOS no se muestra (Apple sí aparece igual).
3. **Info.plist** → agrega el URL scheme del *iOS client ID invertido* (para el callback):
   ```xml
   <key>CFBundleURLTypes</key>
   <array><dict><key>CFBundleURLSchemes</key>
     <array><string>com.googleusercontent.apps.xxxx</string></array>
   </dict></array>
   ```
4. **Supabase** → Providers → **Google** → activar, y en *Authorized Client IDs* agrega
   **ambos** (iOS y Web) para que `signInWithIdToken` acepte el token del dispositivo.

### 4.3 Google en web
Client ID/Secret **Web** en Supabase (Providers → Google) + redirect
`https://<proyecto>.supabase.co/auth/v1/callback` en Google Cloud. La Redirect URL de la
app ya está configurada.

> **Nota (nonce):** si el sign-in de Apple falla con error de *nonce*, es un mismatch entre
> el token del plugin y Supabase; se resuelve pasando el mismo nonce a ambos. Para
> email/contraseña y Google no aplica.

El login por **email/contraseña funciona sin nada de lo anterior**.

---

## 5. Íconos y splash

```bash
npm install -D @capacitor/assets
# coloca un icon.png (1024x1024) y splash.png (2732x2732) en assets/
npx capacitor-assets generate --ios
```

---

## 6. Ejecutar y firmar

1. En Xcode, target **App → Signing & Capabilities** → selecciona tu **Team** (tu cuenta
   Apple Developer). Xcode gestiona el provisioning automáticamente.
2. Corre en un simulador o en tu iPhone conectado (Cmd+R) para probar.

---

## 7. App Store Connect y envío

1. En **appstoreconnect.apple.com** → Apps → **+** → crea la app con el mismo Bundle ID.
2. Rellena ficha: nombre, descripción, categoría, política de privacidad (URL obligatoria),
   capturas de pantalla (usa el simulador), y el **cuestionario de privacidad**.
   Lo que hay que declarar está ya escrito en dos sitios que **tienen que coincidir**:
   `ios/App/App/PrivacyInfo.xcprivacy` y `public/privacy.html` §2. Hoy son: ubicación
   precisa, correo, nombre, foto, contenido de usuario, actividad e identificador de
   dispositivo (token de push). Nada de eso se usa para rastreo. Lee antes el aviso
   sobre el SDK de Facebook, más abajo.
3. En Xcode: **Product → Archive** → **Distribute App → App Store Connect → Upload**.
4. En App Store Connect, asigna el build a la versión y envía a **revisión**.

### El SDK de Facebook entra en el binario sin que la app lo use

Pendiente de decisión antes de rellenar el cuestionario de privacidad (IOS-02 de la
auditoría del 2026-09-18). Los hechos, comprobados:

- `@capgo/capacitor-social-login` declara **FacebookCore y FacebookLogin como
  dependencias fijas** de su único target de SPM. No hay forma de excluirlas por
  configuración: lo comprobé en su `Package.swift`. Por eso `Package.resolved` lista
  `facebook-ios-sdk`, y con él `app-check`, `appauth-ios` y `alamofire`.
- La app **no lo usa ni lo inicializa**: `socialAuth.ts` solo llama a `initialize()`
  con `apple` y `google`, y el plugin únicamente arranca el proveedor de Facebook si
  se le pasa `facebook: { appId }`, cosa que no ocurre. Tampoco se llama nunca a
  `setAdvertiserTrackingEnabled`.
- El flag `providers: { facebook: false }` de la configuración de Capacitor **no
  serviría**: en iOS el plugin solo lo respeta para `apple` y `twitter`.

Apple clasifica el SDK de Facebook como SDK de *tracking*, así que su mera presencia
obliga a contestar el cuestionario con cuidado, y `public/privacy.html` hoy no lo
menciona. Dos salidas:

| Opción | Qué implica |
|---|---|
| Quedarse como está | Declarar en el cuestionario que no se hace tracking (es cierto, no se inicializa) y añadir una línea a `privacy.html` explicando que el SDK viaja en el binario sin usarse. Cero riesgo de romper el login. |
| Cambiar de plugin | `@capacitor-community/apple-sign-in` + `@codetrix-studio/capacitor-google-auth` no arrastran Facebook. Adelgaza el binario, pero **toca el inicio de sesión de una app ya publicada**: hay que reprobar los dos flujos de extremo a extremo en dispositivo real, incluido el caso del correo oculto de Apple. |

### Notas de revisión de Apple para esta app
- Apple pide justificar el uso de ubicación → el texto del Info.plist debe ser claro.
- Si ofreces login con Google, Apple **exige** también ofrecer **Sign in with Apple**
  (guideline 4.8). **Ya está hecho**: la app ofrece los tres métodos (correo, Google y
  Apple) y `socialAuth.ts` implementa los dos sociales. El consejo que había aquí
  —«para el primer envío, lo más simple es email+contraseña solo»— quedó obsoleto
  cuando se implementó el login social, y contradecía lo que la app hace de verdad.
- Ten a la mano una **cuenta de prueba institucional** para los revisores (si el registro está
  restringido a un dominio institucional).

---

## Resumen de comandos (cuando ya tengas Xcode)

```bash
cd ~/Developer/tec-spotter-app
npm run ios:sync
npm run ios:open
# …destino "Any iOS Device (arm64)" → Product → Archive → Distribute App
```
