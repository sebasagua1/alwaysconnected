/**
 * Recargar la lista de amigos sin encogerla ni saltarse a nadie. Lo que se
 * fija: con más de 100 cargados se piden todos (en trozos, que el servidor
 * no da más de 100), y la página siguiente empieza donde acaba lo pedido.
 */
import { describe, it, expect } from 'vitest';
import { fetchFirstRows, FRIENDS_CHUNK } from '@/lib/friendsPaging';

const PAGINA = 15;
type Fila = { id: string };

/** Un servidor como friends_page: ordenado, con tope de 100 por llamada. */
function servidor(total: number) {
  const filas: Fila[] = Array.from({ length: total }, (_, i) => ({ id: `amigo-${String(i + 1).padStart(3, '0')}` }));
  const llamadas: Array<[number, number]> = [];
  return {
    filas,
    llamadas,
    pedir: async (limit: number, offset: number) => {
      llamadas.push([limit, offset]);
      return filas.slice(offset, offset + Math.min(limit, FRIENDS_CHUNK));
    },
  };
}

describe('fetchFirstRows', () => {
  it('con 120 cargados de 130: los trae todos y la página siguiente no se salta a nadie', async () => {
    const s = servidor(130);
    // Ocho páginas de 15 ya cargadas: 120 posiciones recorridas.
    const r = await fetchFirstRows(s.pedir, 8 * PAGINA);
    expect(r!.rows).toHaveLength(120);
    expect(r!.consumed).toBe(120);
    expect(s.llamadas).toEqual([[100, 0], [20, 100]]);

    // «Cargar más» pide desde lo recorrido, no desde una página redondeada.
    const siguiente = await s.pedir(PAGINA, r!.consumed);
    expect(siguiente.map((f) => f.id)).toEqual(s.filas.slice(120, 130).map((f) => f.id));
    const todos = [...r!.rows, ...siguiente].map((f) => f.id);
    expect(todos).toEqual(s.filas.map((f) => f.id));
  });

  it('antes: recortar a 100 y redondear a páginas de 15 se dejaba del 101 al 105', async () => {
    const s = servidor(130);
    const recarga = await s.pedir(100, 0);
    const pagina = Math.max(Math.ceil(recarga.length / PAGINA) - 1, 0);
    const siguiente = await s.pedir(PAGINA, (pagina + 1) * PAGINA);
    const vistos = new Set([...recarga, ...siguiente].map((f) => f.id));
    expect(['amigo-101', 'amigo-102', 'amigo-103', 'amigo-104', 'amigo-105'].filter((id) => !vistos.has(id))).toHaveLength(5);
  });

  it('hasta 100 es una sola llamada, como siempre', async () => {
    const s = servidor(40);
    const r = await fetchFirstRows(s.pedir, 30);
    expect(r!.rows).toHaveLength(30);
    expect(s.llamadas).toEqual([[30, 0]]);
  });

  it('si la lista es más corta de lo pedido, para en el trozo incompleto', async () => {
    const s = servidor(110);
    const r = await fetchFirstRows(s.pedir, 250);
    expect(r).toMatchObject({ consumed: 110 });
    expect(r!.rows).toHaveLength(110);
    expect(s.llamadas).toEqual([[100, 0], [100, 100]]);
  });

  it('si un trozo falla no devuelve media lista', async () => {
    const s = servidor(130);
    const r = await fetchFirstRows(async (limit, offset) => (offset === 0 ? s.pedir(limit, offset) : null), 120);
    expect(r).toBeNull();
  });

  it('si el orden se mueve entre dos trozos, nadie sale dos veces y el offset sigue siendo el recorrido', async () => {
    const s = servidor(130);
    const r = await fetchFirstRows(async (limit, offset) => {
      const filas = await s.pedir(limit, offset);
      // Tras el primer trozo llega un mensaje del amigo 130: sube al principio
      // y todo lo demás baja un puesto.
      if (offset === 0) s.filas.unshift(s.filas.pop()!);
      return filas;
    }, 120);
    expect(r!.consumed).toBe(120);
    expect(new Set(r!.rows.map((f) => f.id)).size).toBe(r!.rows.length);
    // El 100 vino en los dos trozos: uno menos de los recorridos.
    expect(r!.rows).toHaveLength(119);
  });
});
