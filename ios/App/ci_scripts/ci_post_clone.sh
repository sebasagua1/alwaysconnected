#!/bin/sh

# Xcode Cloud ejecuta este script justo despues de clonar el repo y ANTES de
# que xcodebuild resuelva las dependencias de Swift Package Manager.
#
# Hace falta porque Package.swift (lo genera Capacitor, no se toca a mano)
# apunta a los plugins por ruta local:
#
#   .package(name: "CapacitorApp", path: "../../../node_modules/@capacitor/app")
#
# node_modules no esta en el repo (.gitignore), asi que sin este script
# xcodebuild falla con "the package at '.../node_modules/@capacitor/app'
# cannot be accessed". Lo mismo con dist/ y ios/App/App/public: los assets
# web tampoco se commitean, hay que construirlos aqui.
#
# Apple busca la carpeta ci_scripts junto al .xcodeproj, por eso vive en
# ios/App/ y no en la raiz.

set -e

# Xcode Cloud corre el script con ci_scripts/ como directorio de trabajo,
# no con la raiz del repo. CI_PRIMARY_REPOSITORY_PATH es /Volumes/workspace/repository.
cd "${CI_PRIMARY_REPOSITORY_PATH:?no definida; este script solo corre en Xcode Cloud}"

echo "--- Comprobando variables de entorno del build web"
# Sin estas, `vite build` no falla: genera un bundle que apunta a undefined y
# la app arranca en blanco. Mejor romper aqui, con un mensaje claro.
# Se ponen en Xcode Cloud: workflow -> Environment -> Environment Variables.
faltan=""
for var in VITE_SUPABASE_URL VITE_SUPABASE_PUBLISHABLE_KEY VITE_MAPBOX_TOKEN; do
  eval "valor=\$$var"
  if [ -z "$valor" ]; then
    faltan="$faltan $var"
  fi
done
if [ -n "$faltan" ]; then
  echo "error: faltan variables de entorno en el workflow de Xcode Cloud:$faltan" >&2
  exit 1
fi
# El boton nativo de Google solo aparece si estan las dos; no es fatal.
if [ -z "$VITE_GOOGLE_IOS_CLIENT_ID" ] || [ -z "$VITE_GOOGLE_WEB_CLIENT_ID" ]; then
  echo "aviso: sin VITE_GOOGLE_IOS_CLIENT_ID y VITE_GOOGLE_WEB_CLIENT_ID el boton de Google no saldra en la app"
fi

echo "--- Instalando Node"
# Las imagenes de Xcode Cloud no traen Node, pero si Homebrew.
if ! command -v node >/dev/null 2>&1; then
  export HOMEBREW_NO_AUTO_UPDATE=1
  export HOMEBREW_NO_INSTALL_CLEANUP=1
  brew install node
fi
node --version
npm --version

echo "--- npm ci"
npm ci

echo "--- Build web (tsc + vite)"
npm run build

echo "--- npx cap sync ios"
# Copia dist/ a ios/App/App/public, regenera capacitor.config.json y
# reescribe Package.swift con los plugins que hay en node_modules.
npx cap sync ios

echo "--- Listo: node_modules y assets web en su sitio"
