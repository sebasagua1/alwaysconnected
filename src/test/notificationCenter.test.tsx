/**
 * Centro de notificaciones y preferencias, con Supabase simulado.
 *
 * Lo que se fija: el texto sale del mismo módulo que la push y en el idioma
 * de la app, tocar un aviso lo marca abierto y lleva a su pantalla exacta,
 * "marcar todo leído" deshace si el servidor falla, lo leído vive en el
 * historial y no mezclado con lo nuevo, archivar se puede deshacer, la
 * paginación no se deja avisos, lo que el servidor ya no tiene desaparece,
 * y cada preferencia se guarda sola y vuelve atrás si el servidor la rechaza.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import i18n from '@/i18n';

const rpc = vi.fn();
const update = vi.fn();
const toast = vi.fn();
let prefsRow: Record<string, unknown>;
/** El oyente de tiempo real que registra la bandeja, para dispararlo a mano. */
let enVivo: ((payload: Record<string, unknown>) => void) | null = null;

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => rpc(name, args),
    channel: () => {
      const ch = {
        on: (_tipo: string, _cfg: unknown, cb: (payload: Record<string, unknown>) => void) => { enVivo = cb; return ch; },
        subscribe: () => ch,
      };
      return ch;
    },
    removeChannel: vi.fn(),
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: prefsRow, error: null }) }) }),
      update: (patch: Record<string, unknown>) => ({
        eq: () => ({ select: () => ({ single: () => update(patch) }) }),
      }),
      insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: prefsRow, error: null }) }) }),
    }),
  },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
// Como Zustand: el mismo objeto en cada render, y selector opcional.
const AUTH = { user: { id: 'yo' } };
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel?: (s: typeof AUTH) => unknown) => (sel ? sel(AUTH) : AUTH),
}));

const { default: Notifications } = await import('@/pages/Notifications');
const { useNotificationStore } = await import('@/stores/notificationStore');
const { default: NotificationSettings } = await import('@/pages/NotificationSettings');

const EVENTO = '11111111-2222-4333-8444-555555555555';
const aviso = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'event_message', category: 'activity_messages', count: 3, created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(), read_at: null, data: {}, actor_id: 'a1', actor_name: 'Ana', actor_avatar: null,
  event_id: EVENTO, event_title: 'Fútbol', event_starts_at: null, group_id: null, group_name: null, is_dm: false, ...extra,
});

function Donde() {
  const l = useLocation();
  return <p>ruta: {l.pathname}</p>;
}

const montar = (ui: React.ReactNode, path = '/notifications') => render(
  <HelmetProvider>
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={path} element={ui} />
        <Route path="*" element={<Donde />} />
      </Routes>
    </MemoryRouter>
  </HelmetProvider>,
);

beforeEach(async () => {
  cleanup();
  vi.clearAllMocks();
  enVivo = null;
  useNotificationStore.getState().reset();
  prefsRow = {
    user_id: 'yo', activity_messages: true, mentions: true, event_updates: true, event_requests: true, reminders: true,
    reminder_minutes: 60, direct_messages: true, friend_requests: true, friend_activity: true, people_suggestions: true,
    activity_recommendations: true, digests: true, account_tips: true, promotional: false, promotional_consent_at: null,
    show_previews: true, quiet_hours_enabled: false, quiet_start: '23:00:00', quiet_end: '08:00:00',
    timezone: 'America/Mexico_City', locale: 'es', daily_social_limit: 3, created_at: '', updated_at: '',
  };
  await i18n.changeLanguage('es');
});

describe('centro de notificaciones', () => {
  it('pinta el aviso con el texto de la push y va a su pantalla exacta al tocarlo', async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(
      name === 'my_notifications' ? { data: [aviso('n1'), aviso('n2', { type: 'friend_request', category: 'friend_requests', event_id: null, read_at: new Date().toISOString() })], error: null }
        : { data: null, error: null }));
    montar(<Notifications />);
    expect(await screen.findByText('3 mensajes nuevos')).toBeInTheDocument();
    // El leído no se mezcla con lo nuevo: está en el historial.
    expect(screen.queryByText('Ana te quiere agregar')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Historial' }));
    expect(screen.getByText('Ana te quiere agregar')).toBeInTheDocument();
    expect(screen.queryByText('3 mensajes nuevos')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Sin leer/ }));

    fireEvent.click(screen.getByText('3 mensajes nuevos'));
    expect(await screen.findByText(`ruta: /events/${EVENTO}/chat`)).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith('mark_notification_opened', { _id: 'n1' });
  });

  it('en inglés, en inglés', async () => {
    await i18n.changeLanguage('en');
    rpc.mockImplementation((name: string) => Promise.resolve(
      name === 'my_notifications' ? { data: [aviso('n1', { type: 'event_cancelled', category: 'event_updates', count: 1 })], error: null } : { data: null, error: null }));
    montar(<Notifications />);
    expect(await screen.findByText('“Fútbol” was cancelled')).toBeInTheDocument();
  });

  it('marcar todo leído: si el servidor falla, vuelve atrás y lo dice', async () => {
    rpc.mockImplementation((name: string) => Promise.resolve(
      name === 'my_notifications' ? { data: [aviso('n1')], error: null }
        : name === 'mark_notifications_read' ? { data: null, error: { message: 'sin red' } }
          : { data: null, error: null }));
    montar(<Notifications />);
    fireEvent.click(await screen.findByRole('button', { name: /Marcar todo leído/ }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })));
    expect(screen.getByRole('button', { name: /Marcar todo leído/ })).toBeInTheDocument();
  });

  it('vacío: lo dice en vez de enseñar una lista en blanco', async () => {
    rpc.mockImplementation(() => Promise.resolve({ data: [], error: null }));
    montar(<Notifications />);
    expect(await screen.findByText('No tienes notificaciones todavía')).toBeInTheDocument();
  });
});

const leido = (id: string, extra: Record<string, unknown> = {}) =>
  aviso(id, { type: 'friend_request', category: 'friend_requests', event_id: null, read_at: new Date().toISOString(), ...extra });
const bandeja = (filas: unknown[], otras: (name: string, args: unknown) => unknown = () => ({ data: null, error: null })) =>
  rpc.mockImplementation((name: string, args: unknown) => Promise.resolve(
    name === 'my_notifications' ? { data: filas, error: null } : otras(name, args)));

describe('sin leer e historial', () => {
  it('sin nada pendiente se abre en el historial, no en una pantalla vacía', async () => {
    bandeja([leido('n1')]);
    montar(<Notifications />);
    expect(await screen.findByText('Ana te quiere agregar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Historial' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('al dejarlo todo leído dice que estás al día y ofrece el historial', async () => {
    bandeja([aviso('n1'), leido('n2')]);
    useNotificationStore.setState({ notificationsUnread: 1 });
    montar(<Notifications />);
    fireEvent.click(await screen.findByRole('button', { name: /Marcar todo leído/ }));
    expect(await screen.findByText('Estás al día.')).toBeInTheDocument();
    // La campana baja a la vez, sin esperar al recuento del servidor.
    expect(useNotificationStore.getState().notificationsUnread).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Ver historial' }));
    expect(screen.getByText('3 mensajes nuevos')).toBeInTheDocument();
    expect(screen.getByText('Ana te quiere agregar')).toBeInTheDocument();
  });

  it('si marcar leído falla, la campana recupera su número', async () => {
    bandeja([aviso('n1')], (name) => (name === 'mark_notifications_read' ? { data: null, error: { message: 'sin red' } } : { data: null, error: null }));
    useNotificationStore.setState({ notificationsUnread: 1 });
    montar(<Notifications />);
    fireEvent.click(await screen.findByRole('button', { name: /Marcar todo leído/ }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })));
    expect(useNotificationStore.getState().notificationsUnread).toBe(1);
  });
});

describe('archivar', () => {
  it('quita el aviso, baja la campana y se puede deshacer', async () => {
    bandeja([aviso('n1'), aviso('n2', { event_title: 'Vóley' })]);
    useNotificationStore.setState({ notificationsUnread: 2 });
    montar(<Notifications />);
    await screen.findAllByText('3 mensajes nuevos');
    expect(screen.getByText('Fútbol')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Archivar aviso' })[0]);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('archive_notifications', { _ids: ['n1'] }));
    await waitFor(() => expect(screen.queryByText('Fútbol')).not.toBeInTheDocument());
    expect(screen.getByText('Vóley')).toBeInTheDocument();
    expect(useNotificationStore.getState().notificationsUnread).toBe(1);

    // El aviso de abajo trae «Deshacer».
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Aviso archivado' })));
    const { action } = toast.mock.calls.at(-1)![0] as { action: React.ReactElement<{ onClick: () => void }> };
    action.props.onClick();
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('unarchive_notifications', { _ids: ['n1'] }));
    expect(await screen.findByText('Fútbol')).toBeInTheDocument();
    expect(useNotificationStore.getState().notificationsUnread).toBe(2);
  });

  it('si el servidor falla, el aviso vuelve y lo dice', async () => {
    bandeja([aviso('n1')], (name) => (name === 'archive_notifications' ? { data: null, error: { message: 'sin red' } } : { data: null, error: null }));
    useNotificationStore.setState({ notificationsUnread: 1 });
    montar(<Notifications />);
    fireEvent.click(await screen.findByRole('button', { name: 'Archivar aviso' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })));
    expect(screen.getByText('3 mensajes nuevos')).toBeInTheDocument();
    expect(useNotificationStore.getState().notificationsUnread).toBe(1);
  });

  it('lo archivado no reaparece aunque una recarga en vivo todavía lo traiga', async () => {
    bandeja([aviso('n1')]);
    montar(<Notifications />);
    fireEvent.click(await screen.findByRole('button', { name: 'Archivar aviso' }));
    await waitFor(() => expect(screen.queryByText('3 mensajes nuevos')).not.toBeInTheDocument());
    enVivo!({ eventType: 'UPDATE', new: { id: 'n1' } });
    await new Promise((r) => setTimeout(r, 450));
    expect(screen.queryByText('3 mensajes nuevos')).not.toBeInTheDocument();
  });
});

describe('paginación y tiempo real', () => {
  const pagina = (desde: number, n: number, fecha = '2026-10-01T10:00:00.123456+00:00') =>
    Array.from({ length: n }, (_, i) => leido(`n${String(desde + i).padStart(3, '0')}`, { updated_at: fecha, actor_name: `P${desde + i}` }));

  it('«Cargar más» manda la fecha Y el id del último, que es el orden de la lista', async () => {
    const primera = pagina(100, 30).reverse();
    rpc.mockImplementation((name: string, args: { _before?: string }) => Promise.resolve(
      name !== 'my_notifications' ? { data: null, error: null }
        : args._before ? { data: pagina(60, 5).reverse(), error: null } : { data: primera, error: null }));
    montar(<Notifications />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cargar más' }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('my_notifications', {
      _before: '2026-10-01T10:00:00.123456+00:00', _before_id: 'n100', _limit: 30,
    }));
    expect(await screen.findByText('P60 te quiere agregar')).toBeInTheDocument();
    // La página corta era la última.
    expect(screen.queryByRole('button', { name: 'Cargar más' })).not.toBeInTheDocument();
  });

  it('con la base de antes (sin _before_id) pagina como antes en vez de fallar', async () => {
    rpc.mockImplementation((name: string, args: { _before?: string; _before_id?: string }) => Promise.resolve(
      name !== 'my_notifications' ? { data: null, error: null }
        : args._before_id ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
          : args._before ? { data: pagina(60, 5, '2026-09-30T10:00:00+00:00').reverse(), error: null }
            : { data: pagina(100, 30).reverse(), error: null }));
    montar(<Notifications />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cargar más' }));
    expect(await screen.findByText('P60 te quiere agregar')).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });

  it('un borrado en vivo quita la tarjeta sin volver a pedir nada', async () => {
    bandeja([leido('n1'), leido('n2', { actor_name: 'Luis' })]);
    montar(<Notifications />);
    await screen.findByText('Ana te quiere agregar');
    const antes = rpc.mock.calls.length;
    enVivo!({ eventType: 'DELETE', old: { id: 'n1' } });
    await waitFor(() => expect(screen.queryByText('Ana te quiere agregar')).not.toBeInTheDocument());
    expect(screen.getByText('Luis te quiere agregar')).toBeInTheDocument();
    expect(rpc.mock.calls.length).toBe(antes);
  });

  it('lo que el servidor ya no trae desaparece al recargar en vivo', async () => {
    let filas: unknown[] = [leido('n1'), leido('n2', { actor_name: 'Luis' })];
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'my_notifications' ? { data: filas, error: null } : { data: null, error: null }));
    montar(<Notifications />);
    await screen.findByText('Ana te quiere agregar');
    // Archivado desde otro teléfono: la primera página ya no lo incluye.
    filas = [leido('n2', { actor_name: 'Luis' })];
    enVivo!({ eventType: 'UPDATE', new: { id: 'n1' } });
    await waitFor(() => expect(screen.queryByText('Ana te quiere agregar')).not.toBeInTheDocument());
    expect(screen.getByText('Luis te quiere agregar')).toBeInTheDocument();
  });
});

describe('preferencias', () => {
  beforeEach(() => {
    rpc.mockImplementation(() => Promise.resolve({ data: [], error: null }));
  });

  it('cada interruptor se guarda solo', async () => {
    update.mockImplementation((patch: Record<string, unknown>) => Promise.resolve({ data: { ...prefsRow, ...patch }, error: null }));
    montar(<NotificationSettings />, '/settings/notifications');
    const sw = await screen.findByRole('switch', { name: /Planes recomendados/ });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ activity_recommendations: false }));
    expect(screen.getByRole('switch', { name: /Planes recomendados/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('si el servidor rechaza el cambio, vuelve atrás', async () => {
    update.mockResolvedValue({ data: null, error: { message: 'INVALID_TIMEZONE' } });
    montar(<NotificationSettings />, '/settings/notifications');
    const sw = await screen.findByRole('switch', { name: /Menciones/ });
    fireEvent.click(sw);
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(screen.getByRole('switch', { name: /Menciones/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('promocionales apagados hasta dar el consentimiento, y la seguridad no se puede apagar', async () => {
    montar(<NotificationSettings />, '/settings/notifications');
    expect(await screen.findByRole('switch', { name: /Recibir novedades y promociones/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/Apagado hasta que lo actives/)).toBeInTheDocument();
    expect(screen.getByText(/avisos de seguridad .* siempre llegan/)).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /seguridad/i })).not.toBeInTheDocument();
  });

  it('el horario silencioso y el recordatorio aparecen al activarlos', async () => {
    update.mockImplementation((patch: Record<string, unknown>) => Promise.resolve({ data: { ...prefsRow, ...patch }, error: null }));
    montar(<NotificationSettings />, '/settings/notifications');
    expect(await screen.findByLabelText('Avisarme antes de empezar')).toBeInTheDocument();
    expect(screen.queryByLabelText('Desde')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: /Activar horario silencioso/ }));
    expect(await screen.findByLabelText('Desde')).toHaveValue('23:00');
  });
});
