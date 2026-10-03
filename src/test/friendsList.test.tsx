/**
 * La lista de amigos con más de 100 cargados, con Supabase simulado.
 *
 * Lo que se fija: cuando un mensaje reordena la lista, se vuelven a pedir
 * TODOS los que había (no solo los 100 primeros), y el «Cargar más» de
 * después sigue donde tocaba. Antes la recarga encogía la lista a 100 y la
 * página siguiente se saltaba del 101 al 105.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import i18n from '@/i18n';

const TOTAL = 130;
const AMIGOS = Array.from({ length: TOTAL }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  name: `Amigo ${String(i + 1).padStart(3, '0')}`,
  avatar_url: null, major: null, total: TOTAL, dm_group_id: null,
  last_message_at: null, last_content: null, last_sender_id: null,
}));

const rpc = vi.fn((name: string, args?: { _limit?: number; _offset?: number }) => {
  if (name === 'friends_page') {
    // Como el servidor: nunca más de 100 por llamada.
    const limit = Math.min(args?._limit ?? 15, 100);
    const offset = args?._offset ?? 0;
    return Promise.resolve({ data: AMIGOS.slice(offset, offset + limit), error: null });
  }
  return Promise.resolve({ data: [], error: null });
});
/** Los oyentes de tiempo real de la pantalla, para simular un mensaje. */
const enVivo: Array<() => void> = [];

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (name: string, args?: { _limit?: number; _offset?: number }) => rpc(name, args),
    channel: () => {
      const ch = { on: (_t: string, _c: unknown, cb: () => void) => { enVivo.push(cb); return ch; }, subscribe: () => ch };
      return ch;
    },
    removeChannel: vi.fn(),
  },
}));
const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
const AUTH = { user: { id: 'yo' }, profile: { id: 'yo', name: 'Yo', avatar_url: null, points: 0 } };
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel?: (s: typeof AUTH) => unknown) => (sel ? sel(AUTH) : AUTH),
}));
// Lo que rodea a la lista y no viene al caso.
vi.mock('@/components/friends/FindPeople', () => ({ FindPeople: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/chat/GroupInvites', () => ({ GroupInvites: () => null }));
vi.mock('@/components/moderation/ModerationMenu', () => ({ ModerationMenu: () => null }));
vi.mock('@/components/profile/UserProfileSheet', () => ({ UserProfileSheet: () => null }));

const { default: Friends } = await import('@/pages/Friends');

const paginas = () => rpc.mock.calls.filter(([n]) => n === 'friends_page').map(([, a]) => [a?._limit, a?._offset]);

beforeEach(async () => {
  cleanup();
  vi.clearAllMocks();
  enVivo.length = 0;
  await i18n.changeLanguage('es');
});

describe('amigos: más de 100 cargados', () => {
  it('un mensaje nuevo no encoge la lista ni hace que «Cargar más» se salte a nadie', async () => {
    render(<HelmetProvider><MemoryRouter><Friends /></MemoryRouter></HelmetProvider>);
    await screen.findByText('Amigo 001');

    // Siete «Cargar más»: de 15 a 120.
    for (let pagina = 2; pagina <= 8; pagina++) {
      fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
      await screen.findByText(`Amigo ${String(pagina * 15).padStart(3, '0')}`);
    }
    expect(screen.queryByText('Amigo 121')).not.toBeInTheDocument();
    expect(paginas().at(-1)).toEqual([15, 105]);

    // Llega un mensaje: la lista se vuelve a pedir desde el principio.
    rpc.mockClear();
    enVivo.forEach((cb) => cb());
    await waitFor(() => expect(paginas()).toEqual([[100, 0], [20, 100]]));
    // Siguen los 120, no solo los 100 primeros.
    await waitFor(() => expect(screen.getByText('Amigo 120')).toBeInTheDocument());
    expect(screen.getByText('Amigo 101')).toBeInTheDocument();

    // Y la página siguiente empieza en el 121.
    rpc.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await screen.findByText('Amigo 130');
    expect(paginas()).toEqual([[15, 120]]);
    for (let i = 1; i <= TOTAL; i++) {
      expect(screen.getByText(`Amigo ${String(i).padStart(3, '0')}`)).toBeInTheDocument();
    }
    // Página incompleta: no hay más.
    expect(screen.queryByRole('button', { name: 'Cargar más' })).not.toBeInTheDocument();
  });
});
