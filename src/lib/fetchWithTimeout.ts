/**
 * `fetch` con tiempo máximo, para el cliente de Supabase.
 *
 * Sin esto una petición podía quedarse colgada PARA SIEMPRE: ni `fetch` ni
 * supabase-js ponen límite, y WebKit tampoco lo pone por su cuenta. Y la que
 * se colgaba era justo la peor: al abrir la app con el token caducado (basta
 * con no abrirla en una hora), supabase-js lo renueva DENTRO de `initialize()`,
 * y `getSession()` y `onAuthStateChange` esperan a esa promesa sin límite. Con
 * mala cobertura, la renovación no volvía nunca y la app se quedaba en la
 * rueda del arranque sin salida.
 *
 * Con el límite, la petición colgada falla como un error de red normal, que
 * supabase-js ya sabe tratar (reintenta con espera y, si no hay manera,
 * devuelve el error en vez de quedarse esperando).
 */

/** Auth y PostgREST: respuestas pequeñas. Si en 15 s no ha llegado nada, no va a llegar. */
export const SUPABASE_TIMEOUT_MS = 15_000;

/**
 * Qué peticiones llevan límite y cuál. `null` = sin límite.
 *
 * Solo auth y la API REST. Storage sube fotos de perfil y las funciones
 * cruzan la agenda de contactos: con mala red pueden tardar de verdad, y
 * cortarlas a los 15 s rompería algo que iba a terminar bien.
 */
export function supabaseTimeoutFor(url: string): number | null {
  return /\/(auth|rest)\/v1\//.test(url) ? SUPABASE_TIMEOUT_MS : null;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Envuelve un `fetch` para que aborte pasado el límite.
 *
 * Respeta la señal de quien llama (la búsqueda de personas cancela la anterior
 * con `.abortSignal()`): si esa se aborta, se aborta también esta. Se hace a
 * mano y no con `AbortSignal.any` / `AbortSignal.timeout` porque la app admite
 * iOS 15, y esos llegaron a Safari en la 17.4 y la 16.
 */
export function createTimeoutFetch(
  baseFetch: typeof fetch = (...args) => fetch(...args),
  timeoutFor: (url: string) => number | null = supabaseTimeoutFor,
): typeof fetch {
  return async (input, init) => {
    const ms = timeoutFor(urlOf(input));
    if (ms === null) return baseFetch(input, init);

    const controller = new AbortController();
    const outer = init?.signal;
    const forward = () => controller.abort(outer?.reason);
    if (outer) {
      if (outer.aborted) forward();
      else outer.addEventListener('abort', forward, { once: true });
    }
    const timer = setTimeout(() => {
      controller.abort(new DOMException(`Sin respuesta en ${ms / 1000} s`, 'TimeoutError'));
    }, ms);

    try {
      return await baseFetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', forward);
    }
  };
}
