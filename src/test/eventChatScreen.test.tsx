/**
 * La pantalla del chat de actividad, con Supabase simulado.
 *
 * Lo que se fija: el mensaje se ve al instante y no se duplica cuando llega
 * por tiempo real; si falla, queda marcado y se reintenta con el MISMO id
 * (así un reintento nunca crea dos filas); sin acceso no se enseña nada; y
 * la suscripción se cierra al salir.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '@/i18n';
import EventChat from '@/pages/EventChat';

const EVENTO = '11111111-2222-4333-8444-555555555555';

type Row = Record<string, unknown>;
type Handler = (payload: { new: Row }) => void;

const toast = vi.fn();
const rpc = vi.fn();
const insertSingle = vi.fn();
const removeChannel = vi.fn();
let messagesRows: Row[] = [];
let handlers: Record<string, Handler> = {};

const fila = (id: string, extra: Row = {}): Row => ({
  id, content: `texto ${id}`, created_at: '2026-09-22T10:00:00.000Z', sender_id: 'ana', edited_at: null,
  deleted_at: null, deleted_by: null, mentions: [], is_announcement: false, ...extra,
});

vi.mock('@/integrations/supabase/client', () => {
  const chain = (result: () => Promise<unknown>) => {
    const c: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'order', 'lt', 'gt', 'in']) c[k] = () => c;
    c.limit = () => result();
    c.maybeSingle = () => result();
    c.then = (r: (v: unknown) => void) => result().then(r);
    return c;
  };
  return {
    supabase: {
      rpc: (name: string, args: unknown) => rpc(name, args),
      from: (table: string) => {
        if (table === 'events') {
          return chain(() => Promise.resolve({
            data: { id: EVENTO, title: 'Fútbol del jueves', starts_at: '2026-09-25T18:00:00Z', creator_id: 'org', is_active: true },
            error: null,
          }));
        }
        if (table === 'public_profiles') return chain(() => Promise.resolve({ data: [], error: null }));
        // Pedir un mensaje por id (tras un 23505) devuelve esa fila del "servidor".
        let porId: string | null = null;
        const msgs = chain(() => Promise.resolve({ data: messagesRows.slice().reverse(), error: null }));
        msgs.eq = (col: string, v: string) => { if (col === 'id') porId = v; return msgs; };
        msgs.maybeSingle = () => Promise.resolve({ data: messagesRows.find((m) => m.id === porId) ?? null, error: null });
        return {
          ...msgs,
          insert: (v: Row) => ({ select: () => ({ single: () => insertSingle(v) }) }),
        };
      },
      channel: () => {
        const ch = {
          on: (_t: string, filter: { event: string; table: string }, cb: Handler) => {
            handlers[`${filter.table}:${filter.event}`] = cb;
            return ch;
          },
          subscribe: (cb?: (s: string) => void) => { cb?.('SUBSCRIBED'); return ch; },
        };
        return ch;
      },
      removeChannel: (c: unknown) => removeChannel(c),
    },
  };
});
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: () => ({ user: { id: 'yo' } }) }));

const resumen = (extra: Row = {}) => ({
  data: [{ can_access: true, is_organizer: false, removed: false, muted: false, last_read_at: '2026-09-22T09:00:00Z', unread: 1, member_count: 3, ...extra }],
  error: null,
});

beforeEach(async () => {
  cleanup();
  vi.clearAllMocks();
  handlers = {};
  messagesRows = [fila('m1')];
  rpc.mockImplementation((name: string) => {
    if (name === 'event_chat_summary') return Promise.resolve(resumen());
    if (name === 'event_chat_members') {
      return Promise.resolve({
        data: [
          { user_id: 'org', name: 'Org Ana', avatar_url: null, is_organizer: true },
          { user_id: 'ana', name: 'Ana López', avatar_url: null, is_organizer: false },
          { user_id: 'yo', name: 'Yo', avatar_url: null, is_organizer: false },
        ],
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  });
  await i18n.changeLanguage('es');
});

const montar = () =>
  render(
    <MemoryRouter initialEntries={[`/events/${EVENTO}/chat`]}>
      <Routes>
        <Route path="/events/:eventId/chat" element={<EventChat />} />
      </Routes>
    </MemoryRouter>,
  );

const escribirYEnviar = (texto: string) => {
  const input = screen.getByLabelText('Mensaje para el grupo');
  fireEvent.change(input, { target: { value: texto } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
};

describe('EventChat', () => {
  it('carga el chat con nombre del remitente y la raya de nuevos', async () => {
    montar();
    expect(await screen.findByText('texto m1')).toBeInTheDocument();
    expect(screen.getByText('Ana López')).toBeInTheDocument();
    expect(screen.getByText('Mensajes nuevos')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Fútbol del jueves' })).toBeInTheDocument();
  });

  it('el mensaje propio se ve al instante y no se duplica al llegar por tiempo real', async () => {
    let resolver!: (v: unknown) => void;
    insertSingle.mockImplementation(() => new Promise((r) => { resolver = r; }));
    montar();
    await screen.findByText('texto m1');

    escribirYEnviar('Llevo balón');
    expect(await screen.findByText('Llevo balón')).toBeInTheDocument();
    expect(screen.getByText(/Enviando/)).toBeInTheDocument();

    const enviado = insertSingle.mock.calls[0][0] as Row;
    const delServidor = fila(enviado.id as string, { content: 'Llevo balón', sender_id: 'yo', created_at: '2026-09-22T10:01:00.000Z' });

    // El tiempo real gana la carrera a la respuesta del INSERT.
    act(() => handlers['messages:INSERT']({ new: delServidor }));
    await act(async () => { resolver({ data: delServidor, error: null }); });

    expect(screen.getAllByText('Llevo balón')).toHaveLength(1);
    expect(screen.queryByText(/Enviando/)).not.toBeInTheDocument();
  });

  it('si falla, lo marca y el reintento usa el mismo id', async () => {
    insertSingle
      .mockResolvedValueOnce({ data: null, error: { code: 'NETWORK', message: 'Failed to fetch' } })
      .mockImplementationOnce((v: Row) => Promise.resolve({ data: fila(v.id as string, { content: v.content, sender_id: 'yo' }), error: null }));
    montar();
    await screen.findByText('texto m1');

    escribirYEnviar('¿A qué hora?');
    expect(await screen.findByText('No se envió')).toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'No se pudo enviar el mensaje', variant: 'destructive' }));

    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(screen.queryByText('No se envió')).not.toBeInTheDocument());
    expect(insertSingle).toHaveBeenCalledTimes(2);
    expect((insertSingle.mock.calls[0][0] as Row).id).toBe((insertSingle.mock.calls[1][0] as Row).id);
    expect(screen.getAllByText('¿A qué hora?')).toHaveLength(1);
  });

  it('un reintento cuyo primer intento sí llegó (23505) no duplica ni marca error', async () => {
    // El servidor ya tiene la fila (el primer envío llegó y se cortó la respuesta).
    insertSingle.mockImplementationOnce((v: Row) => {
      messagesRows.push(fila(v.id as string, { content: v.content, sender_id: 'yo', created_at: '2026-09-22T10:02:00.000Z' }));
      return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } });
    });
    montar();
    await screen.findByText('texto m1');
    escribirYEnviar('hola');
    await waitFor(() => expect(screen.queryByText(/Enviando/)).not.toBeInTheDocument());
    expect(screen.queryByText('No se envió')).not.toBeInTheDocument();
    expect(screen.getAllByText('hola')).toHaveLength(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it('sin acceso no enseña mensajes y dice por qué', async () => {
    rpc.mockImplementation((name: string) =>
      Promise.resolve(name === 'event_chat_summary' ? resumen({ can_access: false, removed: true }) : { data: [], error: null }));
    montar();
    expect(await screen.findByText('Ya no formas parte de esta actividad')).toBeInTheDocument();
    expect(screen.queryByText('texto m1')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Mensaje para el grupo')).not.toBeInTheDocument();
  });

  it('solo quien organiza ve el botón de aviso importante', async () => {
    montar();
    await screen.findByText('texto m1');
    expect(screen.queryByRole('button', { name: 'Enviar como aviso importante' })).not.toBeInTheDocument();
    cleanup();

    rpc.mockImplementation((name: string) =>
      Promise.resolve(name === 'event_chat_summary' ? resumen({ is_organizer: true }) : { data: [], error: null }));
    montar();
    expect(await screen.findByRole('button', { name: 'Enviar como aviso importante' })).toBeInTheDocument();
  });

  it('avisa de que lo está viendo y cierra la suscripción al salir', async () => {
    const { unmount } = montar();
    await screen.findByText('texto m1');
    expect(rpc).toHaveBeenCalledWith('set_event_chat_presence', { _event_id: EVENTO, _active: true });
    unmount();
    expect(removeChannel).toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('set_event_chat_presence', { _event_id: EVENTO, _active: false });
  });
});
