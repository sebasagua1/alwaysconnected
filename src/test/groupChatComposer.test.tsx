/**
 * El campo de escribir del chat de grupos y de amigos, con Supabase simulado.
 *
 * Lo que se fija: es un campo de varias líneas que crece con el texto en
 * vez de desplazarse de lado, Intro envía y Mayús+Intro no, no deja pasar
 * del tope de la base, y tocar el botón de enviar no le quita el foco al
 * campo (en iOS eso cerraba el teclado después de cada mensaje).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '@/i18n';

type Row = Record<string, unknown>;
const insertSingle = vi.fn();
const toast = vi.fn();
let mensajes: Row[] = [];

vi.mock('@/integrations/supabase/client', () => {
  const chain = (result: () => Promise<unknown>) => {
    const c: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'order', 'lt', 'in', 'or']) c[k] = () => c;
    c.limit = () => result();
    c.single = () => result();
    c.maybeSingle = () => result();
    c.then = (r: (v: unknown) => void) => result().then(r);
    return c;
  };
  return {
    supabase: {
      rpc: () => Promise.resolve({ data: null, error: null }),
      from: (table: string) => {
        if (table === 'groups') return chain(() => Promise.resolve({ data: { name: 'Estudio Cálculo II' }, error: null }));
        if (table === 'public_profiles') return chain(() => Promise.resolve({ data: [{ id: 'ana', name: 'Ana' }], error: null }));
        if (table === 'messages') {
          return {
            ...chain(() => Promise.resolve({ data: mensajes.slice().reverse(), error: null })),
            insert: (v: Row) => ({ select: () => ({ single: () => insertSingle(v) }) }),
          };
        }
        return chain(() => Promise.resolve({ data: [], error: null }));
      },
      channel: () => {
        const ch = { on: () => ch, subscribe: () => ch };
        return ch;
      },
      removeChannel: () => {},
    },
  };
});
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
const AUTH = { user: { id: 'yo' } };
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel?: (s: typeof AUTH) => unknown) => (sel ? sel(AUTH) : AUTH),
}));

const { default: GroupChat } = await import('@/pages/GroupChat');

const montar = async () => {
  render(
    <MemoryRouter initialEntries={['/groups/g1']}>
      <Routes><Route path="/groups/:id" element={<GroupChat />} /></Routes>
    </MemoryRouter>,
  );
  await screen.findByText('hola a todos');
  return screen.getByPlaceholderText('Mensaje…') as HTMLTextAreaElement;
};

beforeEach(async () => {
  cleanup();
  vi.clearAllMocks();
  mensajes = [{ id: 'm1', content: 'hola a todos', created_at: '2026-10-01T10:00:00.000Z', sender_id: 'ana', edited_at: null, deleted_at: null }];
  insertSingle.mockImplementation((v: Row) => Promise.resolve({
    data: { id: 'nuevo', created_at: '2026-10-01T10:05:00.000Z', edited_at: null, deleted_at: null, ...v }, error: null,
  }));
  await i18n.changeLanguage('es');
});

afterEach(() => vi.restoreAllMocks());

describe('campo de escribir', () => {
  it('es de varias líneas, con nombre, y no deja pasar del tope de la base', async () => {
    const campo = await montar();
    expect(campo.tagName).toBe('TEXTAREA');
    expect(campo).toHaveAttribute('aria-label', 'Mensaje…');
    expect(campo).toHaveAttribute('maxlength', '2000');
    // La tecla de retorno de iOS dice «enviar».
    expect(campo).toHaveAttribute('enterkeyhint', 'send');
  });

  it('crece con un borrador largo en vez de quedarse en una línea', async () => {
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLTextAreaElement) {
      return 44 + Math.floor(this.value.length / 30) * 22;
    });
    const campo = await montar();
    fireEvent.change(campo, { target: { value: 'Nos vemos a las seis en la biblioteca, tercer piso, mesas del fondo; llevo los apuntes.' } });
    expect(campo.style.height).toBe('88px');
    expect(campo.value).toMatch(/^Nos vemos a las seis/);
  });

  it('Intro envía el texto recortado y vacía el campo', async () => {
    const campo = await montar();
    fireEvent.change(campo, { target: { value: '  voy para allá  ' } });
    fireEvent.keyDown(campo, { key: 'Enter' });
    await waitFor(() => expect(insertSingle).toHaveBeenCalledWith({ group_id: 'g1', sender_id: 'yo', content: 'voy para allá' }));
    expect(campo.value).toBe('');
    expect(await screen.findByText('voy para allá')).toBeInTheDocument();
  });

  it('Mayús+Intro no envía: es un salto de línea', async () => {
    const campo = await montar();
    fireEvent.change(campo, { target: { value: 'primera línea' } });
    fireEvent.keyDown(campo, { key: 'Enter', shiftKey: true });
    expect(insertSingle).not.toHaveBeenCalled();
    expect(campo.value).toBe('primera línea');
  });

  it('a mitad de una composición (teclado japonés, por ejemplo) Intro no envía', async () => {
    const campo = await montar();
    fireEvent.change(campo, { target: { value: 'にほん' } });
    fireEvent.keyDown(campo, { key: 'Enter', isComposing: true });
    expect(insertSingle).not.toHaveBeenCalled();
  });

  it('si el envío falla, el texto vuelve al campo', async () => {
    insertSingle.mockResolvedValueOnce({ data: null, error: { message: 'sin red' } });
    const campo = await montar();
    fireEvent.change(campo, { target: { value: 'no llega' } });
    fireEvent.keyDown(campo, { key: 'Enter' });
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })));
    expect(campo.value).toBe('no llega');
  });
});

describe('botón de enviar', () => {
  it('tocarlo no le quita el foco al campo: el teclado se queda abierto', async () => {
    const campo = await montar();
    fireEvent.change(campo, { target: { value: 'hola' } });
    const boton = screen.getByRole('button', { name: 'Enviar' });
    // fireEvent devuelve false cuando el manejador llamó a preventDefault,
    // que es lo que evita que el foco salte al botón.
    expect(fireEvent.mouseDown(boton)).toBe(false);
    fireEvent.click(boton);
    await waitFor(() => expect(insertSingle).toHaveBeenCalledTimes(1));
  });

  it('está apagado sin texto', async () => {
    await montar();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
  });
});
