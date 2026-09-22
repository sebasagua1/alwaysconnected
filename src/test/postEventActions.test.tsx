import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import i18n from '@/i18n';
import type { MapEvent } from '@/stores/eventStore';

const navigate = vi.fn();
const rpc = vi.fn();
const insert = vi.fn();
const toast = vi.fn();
let friendships: Array<{ requester_id: string; addressee_id: string; status: string }> = [];

vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: () => ({
      select: () => ({ or: async () => ({ data: friendships, error: null }) }),
      insert: (row: unknown) => insert(row),
    }),
  },
}));

const { PostEventActions } = await import('@/components/map/PostEventActions');

const evento: MapEvent = {
  id: 'e1', creator_id: 'org', title: 'Pádel', category: 'sports', location: { lng: 1, lat: 2 },
  address: null, description: null, starts_at: new Date(Date.now() - 3 * 3600e3).toISOString(),
  ends_at: new Date(Date.now() - 2 * 3600e3).toISOString(), max_spots: 4, current_spots: 3, privacy: 'open', is_active: true,
};
const gente = [
  { user_id: 'org', name: 'Sebastián Villegas', avatar_url: null, is_creator: true },
  { user_id: 'yo', name: 'Luis', avatar_url: null, is_creator: false },
  { user_id: 'ana', name: 'Ana López', avatar_url: null, is_creator: false },
];

beforeEach(async () => {
  cleanup(); navigate.mockReset(); rpc.mockReset(); insert.mockReset(); toast.mockReset();
  friendships = [];
  await i18n.changeLanguage('es');
});

describe('PostEventActions', () => {
  it('ofrece agregar solo a quien todavía no es amigo, y marca la solicitud como enviada', async () => {
    friendships = [{ requester_id: 'yo', addressee_id: 'org', status: 'accepted' }];
    insert.mockResolvedValue({ error: null });
    render(<PostEventActions event={evento} attendees={gente} myId="yo" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Agregar a Sebastián/ })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Agregar a Ana López como amigo' }));
    await waitFor(() => expect(screen.getByText('Enviada')).toBeInTheDocument());
    expect(insert).toHaveBeenCalledWith({ requester_id: 'yo', addressee_id: 'ana', status: 'pending' });
  });

  it('"Repetir el plan" lleva al mapa con el borrador', () => {
    const onClose = vi.fn();
    render(<PostEventActions event={evento} attendees={gente} myId="yo" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Repetir el plan/ }));
    const [path, opts] = navigate.mock.calls[0];
    expect(path).toBe('/');
    expect(opts.state.repeat).toMatchObject({ repeatedFrom: 'e1', title: 'Pádel', maxSpots: 4 });
    expect(new Date(opts.state.repeat.startsAt).getTime()).toBeGreaterThan(Date.now());
    expect(onClose).toHaveBeenCalled();
  });

  it('crear el grupo invita a los demás y abre el chat', async () => {
    rpc.mockResolvedValue({ data: 'g1', error: null });
    render(<PostEventActions event={evento} attendees={gente} myId="yo" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Crear un grupo con quienes fueron/ }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/groups/g1', { state: { from: 'groups' } }));
    expect(rpc).toHaveBeenCalledWith('create_group_from_event', { _event_id: 'e1' });
    expect(toast).toHaveBeenCalledWith({ title: 'Grupo creado. Invitamos a 2 personas.' });
  });

  it('sin nadie más, no ofrece grupo', () => {
    render(<PostEventActions event={evento} attendees={[gente[1]]} myId="yo" onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Crear un grupo/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Repetir el plan/ })).toBeInTheDocument();
  });
});
