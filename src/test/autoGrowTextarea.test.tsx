/**
 * El campo de escribir de los chats crece con el texto. Lo que se fija:
 * sigue al contenido, no pasa del tope, vuelve a encoger al borrar (por eso
 * primero se pone en `auto`), y medir no le quita a la lista de mensajes su
 * distancia al final.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { useRef, useState, type RefObject } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { COMPOSER_MAX_HEIGHT, useAutoGrowTextarea } from '@/hooks/useAutoGrowTextarea';

const UNA_LINEA = 44;
const contenido = (el: HTMLTextAreaElement) => UNA_LINEA + Math.floor(el.value.length / 20) * 22;
/** El alto que ocupa el campo: en `auto` vuelve a una línea, que es justo el problema. */
const altoDelCampo = (el: HTMLTextAreaElement) => (el.style.height === 'auto' || !el.style.height ? UNA_LINEA : parseInt(el.style.height, 10));

/**
 * jsdom no maqueta. Se finge el alto del contenido (una línea por cada 20
 * caracteres) y, como en un navegador, leerlo fuerza una maquetación: ahí
 * es donde la lista —si la hay— se estira y pierde desplazamiento.
 */
function fingirAlto(alMaquetar?: () => void) {
  const alturasAlMedir: string[] = [];
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLTextAreaElement) {
    alturasAlMedir.push(this.style.height);
    alMaquetar?.();
    return contenido(this);
  });
  return alturasAlMedir;
}

/**
 * Una lista de mensajes de mentira encima del campo: 2000 de contenido en
 * una pantalla de 600 que comparte con él. Recorta el desplazamiento al
 * maquetar, igual que el navegador.
 */
function listaFalsa(campo: () => HTMLTextAreaElement | null) {
  let top = 0;
  const lista = {
    scrollHeight: 2000,
    get clientHeight() { const c = campo(); return 600 - (c ? altoDelCampo(c) : UNA_LINEA); },
    get scrollTop() { return top; },
    set scrollTop(v: number) { top = Math.max(0, Math.min(v, lista.scrollHeight - lista.clientHeight)); },
    maquetar() { top = Math.min(top, lista.scrollHeight - lista.clientHeight); },
    alFinal() { top = lista.scrollHeight - lista.clientHeight; },
    distanciaAlFinal() { return lista.scrollHeight - top - lista.clientHeight; },
  };
  return lista;
}

function Campo({ max, lista }: { max?: number; lista?: RefObject<HTMLElement> }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  useAutoGrowTextarea(ref, text, lista, max);
  return <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} aria-label="campo" />;
}

const campoEnPantalla = () => document.querySelector('textarea');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useAutoGrowTextarea', () => {
  it('crece con el texto', () => {
    fingirAlto();
    render(<Campo />);
    const campo = screen.getByLabelText('campo');
    expect(campo.style.height).toBe('44px');
    fireEvent.change(campo, { target: { value: 'x'.repeat(45) } });
    expect(campo.style.height).toBe('88px');
  });

  it('no pasa del tope: a partir de ahí se desplaza por dentro', () => {
    fingirAlto();
    render(<Campo />);
    const campo = screen.getByLabelText('campo');
    fireEvent.change(campo, { target: { value: 'x'.repeat(400) } });
    expect(campo.style.height).toBe(`${COMPOSER_MAX_HEIGHT}px`);
  });

  it('vuelve a encoger al borrar, porque mide con el alto en auto', () => {
    const alturasAlMedir = fingirAlto();
    render(<Campo />);
    const campo = screen.getByLabelText('campo');
    fireEvent.change(campo, { target: { value: 'x'.repeat(100) } });
    fireEvent.change(campo, { target: { value: '' } });
    expect(campo.style.height).toBe('44px');
    // Si midiera con el alto anterior puesto, el contenido nunca mediría menos.
    expect(alturasAlMedir.every((h) => h === 'auto')).toBe(true);
  });

  it('el tope se puede cambiar', () => {
    fingirAlto();
    render(<Campo max={66} />);
    const campo = screen.getByLabelText('campo');
    fireEvent.change(campo, { target: { value: 'x'.repeat(400) } });
    expect(campo.style.height).toBe('66px');
  });
});

describe('la lista de mensajes de encima', () => {
  it('antes: sin avisar al hook de la lista, cada línea tapaba un poco más del último mensaje', () => {
    const lista = listaFalsa(campoEnPantalla);
    fingirAlto(() => lista.maquetar());
    render(<Campo />);
    lista.alFinal();
    const campo = screen.getByLabelText('campo');
    fireEvent.change(campo, { target: { value: 'x'.repeat(45) } });
    // Una letra más, sin cambiar de línea: al medir, el campo vuelve a una
    // línea, la lista se estira y pierde lo que había ganado.
    fireEvent.change(campo, { target: { value: 'x'.repeat(46) } });
    expect(lista.distanciaAlFinal()).toBe(44);
  });

  it('estando al final, sigue al final mientras el campo crece', () => {
    const lista = listaFalsa(campoEnPantalla);
    fingirAlto(() => lista.maquetar());
    render(<Campo lista={{ current: lista as unknown as HTMLElement }} />);
    lista.alFinal();
    const campo = screen.getByLabelText('campo');
    for (const n of [10, 25, 45, 46, 70, 90]) {
      fireEvent.change(campo, { target: { value: 'x'.repeat(n) } });
      expect(lista.distanciaAlFinal(), `con ${n} letras`).toBe(0);
    }
  });

  it('y al encoger (borrar o enviar) tampoco deja un hueco', () => {
    const lista = listaFalsa(campoEnPantalla);
    fingirAlto(() => lista.maquetar());
    render(<Campo lista={{ current: lista as unknown as HTMLElement }} />);
    lista.alFinal();
    const campo = screen.getByLabelText('campo');
    fireEvent.change(campo, { target: { value: 'x'.repeat(90) } });
    fireEvent.change(campo, { target: { value: 'x'.repeat(25) } });
    expect(lista.distanciaAlFinal()).toBe(0);
    fireEvent.change(campo, { target: { value: '' } });
    expect(lista.distanciaAlFinal()).toBe(0);
  });

  it('leyendo mensajes anteriores, conserva la misma distancia al final', () => {
    const lista = listaFalsa(campoEnPantalla);
    fingirAlto(() => lista.maquetar());
    render(<Campo lista={{ current: lista as unknown as HTMLElement }} />);
    lista.scrollTop = 1000;
    const antes = lista.distanciaAlFinal();
    const campo = screen.getByLabelText('campo');
    fireEvent.change(campo, { target: { value: 'x'.repeat(45) } });
    fireEvent.change(campo, { target: { value: 'x'.repeat(46) } });
    expect(lista.distanciaAlFinal()).toBe(antes);
  });
});
