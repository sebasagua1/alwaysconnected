import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import type { MapEvent } from '@/stores/eventStore';

const rpc = vi.fn();
const chain: Record<string, unknown> = {};
Object.assign(chain, {
  select: () => chain, eq: () => chain, in: () => chain,
  maybeSingle: async () => ({ data: null, error: null }),
  then: (r: (v: unknown) => void) => r({ data: [], error: null }),
});
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a), from: () => chain } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: () => ({ user: { id: 'yo' } }) }));
vi.mock('@/components/profile/UserProfileSheet', () => ({
  UserProfileSheet: ({ userId }: { userId: string }) => <div role="dialog">perfil de {userId}</div>,
}));

const { EventBottomSheet } = await import('@/components/map/EventBottomSheet');

const evento: MapEvent = {
  id: 'e1', creator_id: 'org', title: 'Pádel', category: 'sports', location: { lng: 0, lat: 0 },
  address: null, description: null, starts_at: new Date(Date.now() + 3_600_000).toISOString(),
  ends_at: new Date(Date.now() + 7_200_000).toISOString(), max_spots: 4, current_spots: 2, privacy: 'open', is_active: true,
};

beforeEach(async () => { cleanup(); rpc.mockReset(); await i18n.changeLanguage('es'); });

describe('EventBottomSheet: quién va', () => {
  it('lo ve quien todavía no se ha unido, con quien organiza marcado', async () => {
    rpc.mockResolvedValue({
      data: [
        { user_id: 'org', name: 'Sebastián Villegas', avatar_url: null, is_creator: true },
        { user_id: 'ana', name: 'Ana López', avatar_url: null, is_creator: false },
        { user_id: 'yo', name: 'Luis Pérez', avatar_url: null, is_creator: false },
      ],
      error: null,
    });
    render(<MemoryRouter><EventBottomSheet event={evento} onClose={vi.fn()} /></MemoryRouter>);
    expect(rpc).toHaveBeenCalledWith('event_attendees', { _event_id: 'e1' });
    expect(await screen.findByRole('button', { name: 'Sebastián Villegas, organiza' })).toBeInTheDocument();
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('Tú')).toBeInTheDocument();
    expect(screen.getByText(/2 personas unidas/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Ana López' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('perfil de ana');
  });

  it('enseña 5 caras y un "+N" que despliega el resto', async () => {
    const gente = Array.from({ length: 12 }, (_, i) => ({
      user_id: `u${i}`, name: `Persona${i} Apellido`, avatar_url: null, is_creator: i === 0,
    }));
    rpc.mockResolvedValue({ data: gente, error: null });
    render(<MemoryRouter><EventBottomSheet event={{ ...evento, max_spots: 20, current_spots: 11 }} onClose={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByText('Persona4')).toBeInTheDocument();
    expect(screen.queryByText('Persona5')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ver a las 7 personas más' }));
    expect(screen.getByText('Persona11')).toBeInTheDocument();
    expect(screen.queryByText('+7')).not.toBeInTheDocument();
  });

  it('sin nadie más que quien organiza, invita a ser la primera persona', async () => {
    rpc.mockResolvedValue({ data: [{ user_id: 'org', name: 'Org', avatar_url: null, is_creator: true }], error: null });
    render(<MemoryRouter><EventBottomSheet event={{ ...evento, current_spots: 0 }} onClose={vi.fn()} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Aún no se ha unido nadie. Sé la primera persona.')).toBeInTheDocument());
  });
});
