/**
 * Paginación de la lista de amigos.
 *
 * `friends_page` devuelve como mucho 100 filas por llamada (el servidor
 * recorta `_limit`). Recargar «lo que hay en pantalla» de una vez funcionaba
 * hasta los 100 amigos cargados; pasado eso la recarga se quedaba en 100, la
 * lista se encogía, y la página siguiente se calculaba redondeando a páginas
 * de 15: 100 filas eran «6 páginas y pico», la siguiente era la 7, el offset
 * 105, y las posiciones 101 a 105 no salían nunca.
 */

/** Lo más que devuelve `friends_page` de una vez. */
export const FRIENDS_CHUNK = 100;

export interface FirstRows<T> {
  /** Las filas, sin repetidos. */
  rows: T[];
  /**
   * Cuántas posiciones del servidor se han recorrido: el offset de la página
   * siguiente. Puede ser mayor que `rows.length` si entre un trozo y el
   * siguiente llegó un mensaje, el orden se movió y alguien vino dos veces.
   */
  consumed: number;
}

/**
 * Vuelve a pedir, desde el principio, las primeras `want` filas, en los
 * trozos que haga falta. Devuelve null si algún trozo falla: la lista que ya
 * había sigue valiendo, solo peor ordenada.
 */
export async function fetchFirstRows<T extends { id: string | null }>(
  fetchChunk: (limit: number, offset: number) => Promise<T[] | null>,
  want: number,
  chunk: number = FRIENDS_CHUNK,
): Promise<FirstRows<T> | null> {
  const rows: T[] = [];
  const seen = new Set<string | null>();
  let consumed = 0;
  while (consumed < want) {
    const limit = Math.min(chunk, want - consumed);
    const data = await fetchChunk(limit, consumed);
    if (!data) return null;
    for (const r of data) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push(r);
    }
    consumed += data.length;
    // Un trozo incompleto es el final de la lista.
    if (data.length < limit) break;
  }
  return { rows, consumed };
}
