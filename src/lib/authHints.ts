/**
 * Si en este dispositivo ya se ha iniciado sesión alguna vez.
 *
 * Sirve para una sola cosa: con qué pestaña abre la pantalla de acceso. Quien
 * abre la app por primera vez viene a crear una cuenta, y antes veía un
 * formulario de «Iniciar sesión» con el «Regístrate» escondido bajo el pliegue.
 * Quien ya tuvo sesión (cerró sesión, reinstaló desde copia) vuelve a entrar.
 */
const KEY = 'ac_has_signed_in';

export function hasSignedInBefore(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function markSignedIn(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    // Sin almacenamiento: la próxima vez abrirá en «Crear cuenta», nada más.
  }
}
