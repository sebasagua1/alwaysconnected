/**
 * Centro de notificaciones y preferencias, con Supabase simulado.
 *
 * Lo que se fija: el texto sale del mismo módulo que la push y en el idioma
 * de la app, tocar un aviso lo marca abierto y lleva a su pantalla exacta,
 * "marcar todo leído" deshace si el servidor falla, y cada preferencia se
 * guarda sola y vuelve atrás si el servidor la rechaza.
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

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => rpc(name, args),
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch };
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
    expect(screen.getByText('Ana te quiere agregar')).toBeInTheDocument();

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
