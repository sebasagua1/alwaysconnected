import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import i18n from '@/i18n';
import { FindPeople } from '@/components/friends/FindPeople';
import { SEARCH_DEBOUNCE_MS } from '@/hooks/usePeopleSearch';

type Row = {
  id: string; name: string; avatar_url: string | null; major: string | null;
  relation: 'none' | 'outgoing' | 'incoming' | 'friends'; friendship_id: string | null; mutual_friends: number;
};

const persona = (id: string, name: string, extra: Partial<Row> = {}): Row => ({
  id, name, avatar_url: null, major: 'Ingeniería', relation: 'none', friendship_id: null, mutual_friends: 0, ...extra,
});

/** Una respuesta que el test resuelve cuando quiere, para simular red lenta. */
function diferida<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const toast = vi.fn();
const rpc = vi.fn();
const insertSingle = vi.fn();
const updateSelect = vi.fn();
const deleteEq = vi.fn();
const relacionActual = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => ({ abortSignal: () => rpc(name, args), then: (r: (v: unknown) => void) => rpc(name, args).then(r) }),
    from: (table: string) => {
      if (table === 'public_profiles') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => new Promise(() => {}) }) }) };
      }
      return {
        insert: (v: unknown) => ({ select: () => ({ single: () => insertSingle(v) }) }),
        update: (v: unknown) => ({ eq: (_c: string, id: string) => ({ select: () => updateSelect(v, id) }) }),
        delete: () => ({ eq: (_c: string, id: string) => ({ eq: () => deleteEq(id) }) }),
        select: () => ({ or: () => ({ maybeSingle: () => relacionActual() }) }),
      };
    },
  },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: () => ({ user: { id: 'yo' } }) }));

const SUGERENCIAS = [
  { ...persona('s1', 'Sofía Ruiz', { mutual_friends: 3 }), shared_groups: 0 },
  { ...persona('s2', 'Diego Mora', { major: null }), shared_groups: 2 },
];

const busquedas = () => rpc.mock.calls.filter(([n]) => n === 'search_people');

beforeEach(async () => {
  cleanup();
  vi.clearAllMocks();
  rpc.mockImplementation((name: string) =>
    Promise.resolve(name === 'people_suggestions' ? { data: SUGERENCIAS, error: null } : { data: [], error: null }),
  );
  await i18n.changeLanguage('es');
});

const montar = () => {
  const onFriendsChanged = vi.fn();
  const onMessage = vi.fn();
  render(
    <FindPeople onFriendsChanged={onFriendsChanged} onMessage={onMessage}>
      <p>Lista de amigos</p>
    </FindPeople>,
  );
  return { onFriendsChanged, onMessage, input: screen.getByRole('searchbox', { name: 'Buscar personas' }) };
};

const escribir = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });

describe('FindPeople', () => {
  it('al tocar el buscador enseña sugerencias con recuentos, sin datos privados; Cancelar vuelve a la lista', async () => {
    const { input } = montar();
    expect(screen.getByText('Lista de amigos')).toBeInTheDocument();
    fireEvent.focus(input);
    expect(await screen.findByText('Personas que quizá conozcas')).toBeInTheDocument();
    expect(await screen.findByText('3 amigos en común · Ingeniería')).toBeInTheDocument();
    expect(screen.getByText('2 grupos en común')).toBeInTheDocument();
    expect(screen.queryByText('Lista de amigos')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByText('Lista de amigos')).toBeInTheDocument();
  });

  it('busca sola al escribir, una vez por ráfaga de letras y sin pulsar nada', async () => {
    rpc.mockImplementation((name: string, args: { _query?: string }) =>
      Promise.resolve(name === 'search_people'
        ? { data: [persona('a1', `Ana ${args._query}`)], error: null }
        : { data: [], error: null }),
    );
    const { input } = montar();
    fireEvent.focus(input);
    escribir(input, 'a');
    escribir(input, 'an');
    escribir(input, 'ana');
    expect(busquedas()).toHaveLength(0);
    expect(await screen.findByText('Ana ana', {}, { timeout: SEARCH_DEBOUNCE_MS + 1000 })).toBeInTheDocument();
    expect(busquedas()).toHaveLength(1);
    expect(busquedas()[0][1]).toMatchObject({ _query: 'ana', _limit: 21, _offset: 0 });
  });

  it('una respuesta vieja que llega tarde no pisa la de lo último escrito', async () => {
    const lenta = diferida<unknown>();
    const rapida = diferida<unknown>();
    rpc.mockImplementation((name: string, args: { _query?: string }) => {
      if (name !== 'search_people') return Promise.resolve({ data: [], error: null });
      return args._query === 'jo' ? lenta.promise : rapida.promise;
    });
    const { input } = montar();
    fireEvent.focus(input);
    escribir(input, 'jo');
    await waitFor(() => expect(busquedas()).toHaveLength(1), { timeout: 2000 });
    escribir(input, 'jose');
    await waitFor(() => expect(busquedas()).toHaveLength(2), { timeout: 2000 });

    await act(async () => { rapida.resolve({ data: [persona('j2', 'José Nuevo')], error: null }); });
    expect(await screen.findByText('José Nuevo')).toBeInTheDocument();
    await act(async () => { lenta.resolve({ data: [persona('j1', 'Jorge Viejo')], error: null }); });
    expect(screen.queryByText('Jorge Viejo')).not.toBeInTheDocument();
    expect(screen.getByText('José Nuevo')).toBeInTheDocument();
  });

  it('sin resultados y con error lo dice distinto, y Reintentar busca otra vez', async () => {
    rpc.mockImplementation((name: string) =>
      Promise.resolve(name === 'search_people' ? { data: null, error: { message: 'network' } } : { data: [], error: null }),
    );
    const { input } = montar();
    fireEvent.focus(input);
    escribir(input, 'zzz');
    const aviso = await screen.findByRole('alert', {}, { timeout: 2000 });
    expect(aviso).toHaveTextContent('No se pudo buscar');

    rpc.mockImplementation(() => Promise.resolve({ data: [], error: null }));
    fireEvent.click(within(aviso).getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('No encontramos a nadie llamado «zzz» en tu campus.', {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it('pinta cada estado de relación con su acción', async () => {
    rpc.mockImplementation((name: string) =>
      Promise.resolve(name === 'search_people'
        ? { data: [
            persona('n', 'Nadia Ninguna'),
            persona('o', 'Óscar Enviada', { relation: 'outgoing', friendship_id: 'f-o' }),
            persona('i', 'Iris Recibida', { relation: 'incoming', friendship_id: 'f-i' }),
            persona('f', 'Fer Amigo', { relation: 'friends' }),
          ], error: null }
        : { data: [], error: null }),
    );
    const { input, onMessage } = montar();
    fireEvent.focus(input);
    escribir(input, 'test');
    await screen.findByText('Nadia Ninguna', {}, { timeout: 2000 });
    expect(screen.getByRole('button', { name: 'Enviar solicitud de amistad a Nadia Ninguna' })).toHaveTextContent('Agregar');
    expect(screen.getByRole('button', { name: /Solicitud enviada a Óscar Enviada/ })).toHaveTextContent('Enviada');
    expect(screen.getByRole('button', { name: 'Aceptar la solicitud de amistad de Iris Recibida' })).toHaveTextContent('Aceptar');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar mensaje a Fer Amigo' }));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'f' }));
  });

  it('agregar cambia a Enviada al momento, y si falla vuelve a Agregar y avisa', async () => {
    rpc.mockImplementation((name: string) =>
      Promise.resolve(name === 'search_people' ? { data: [persona('n', 'Nadia')], error: null } : { data: [], error: null }),
    );
    const envio = diferida<unknown>();
    insertSingle.mockReturnValue(envio.promise);
    const { input } = montar();
    fireEvent.focus(input);
    escribir(input, 'nadia');
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar solicitud de amistad a Nadia' }, { timeout: 2000 }));

    expect(await screen.findByRole('button', { name: /Solicitud enviada a Nadia/ })).toBeDisabled();
    expect(insertSingle).toHaveBeenCalledWith({ requester_id: 'yo', addressee_id: 'n', status: 'pending' });

    await act(async () => { envio.resolve({ data: null, error: { message: 'FRIEND_RATE_LIMIT', code: 'P0001' } }); });
    expect(await screen.findByRole('button', { name: 'Enviar solicitud de amistad a Nadia' })).toBeEnabled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      description: 'Enviaste muchas solicitudes seguidas. Inténtalo más tarde.', variant: 'destructive',
    }));
  });

  it('si la otra persona ya había pedido amistad, enseña Aceptar en vez de un error', async () => {
    rpc.mockImplementation((name: string) =>
      Promise.resolve(name === 'search_people' ? { data: [persona('n', 'Nadia')], error: null } : { data: [], error: null }),
    );
    insertSingle.mockResolvedValue({ data: null, error: { message: 'FRIEND_REQUEST_INCOMING', code: 'P0001' } });
    relacionActual.mockResolvedValue({ data: { id: 'f-x', status: 'pending', requester_id: 'n' }, error: null });
    const { input } = montar();
    fireEvent.focus(input);
    escribir(input, 'nadia');
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar solicitud de amistad a Nadia' }, { timeout: 2000 }));
    expect(await screen.findByRole('button', { name: 'Aceptar la solicitud de amistad de Nadia' })).toBeInTheDocument();
  });

  it('aceptar desde el resultado deja Mensaje y refresca la lista de amigos', async () => {
    rpc.mockImplementation((name: string) =>
      Promise.resolve(name === 'search_people'
        ? { data: [persona('i', 'Iris', { relation: 'incoming', friendship_id: 'f-i' })], error: null }
        : { data: [], error: null }),
    );
    updateSelect.mockResolvedValue({ data: [{ id: 'f-i' }], error: null });
    const { input, onFriendsChanged } = montar();
    fireEvent.focus(input);
    escribir(input, 'iris');
    fireEvent.click(await screen.findByRole('button', { name: 'Aceptar la solicitud de amistad de Iris' }, { timeout: 2000 }));
    expect(await screen.findByRole('button', { name: 'Enviar mensaje a Iris' })).toBeInTheDocument();
    expect(updateSelect).toHaveBeenCalledWith({ status: 'accepted' }, 'f-i');
    await waitFor(() => expect(onFriendsChanged).toHaveBeenCalled());
  });

  it('cancelar una solicitud enviada pide confirmación antes de borrarla', async () => {
    rpc.mockImplementation((name: string) =>
      Promise.resolve(name === 'search_people'
        ? { data: [persona('o', 'Óscar', { relation: 'outgoing', friendship_id: 'f-o' })], error: null }
        : { data: [], error: null }),
    );
    deleteEq.mockResolvedValue({ error: null });
    const { input } = montar();
    fireEvent.focus(input);
    escribir(input, 'oscar');
    fireEvent.click(await screen.findByRole('button', { name: /Solicitud enviada a Óscar/ }, { timeout: 2000 }));
    expect(deleteEq).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar solicitud' }));
    expect(await screen.findByRole('button', { name: 'Enviar solicitud de amistad a Óscar' })).toBeInTheDocument();
    expect(deleteEq).toHaveBeenCalledWith('f-o');
  });

  it('al tocar la tarjeta abre la ficha, con la misma acción que la fila', async () => {
    const { input } = montar();
    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el perfil de Sofía Ruiz' }));
    expect(await screen.findAllByRole('button', { name: 'Enviar solicitud de amistad a Sofía Ruiz' })).toHaveLength(2);
  });
});
