/**
 * Mis eventos, con Supabase simulado.
 *
 * Lo que se fija: al cerrar una ficha la lista se relee SIN cambiar las
 * tarjetas por esqueletos (eso acortaba la página y el scroll se iba
 * arriba), y «Cargar más» solo anima las tarjetas nuevas.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import i18n from '@/i18n';

type Evento = Record<string, unknown>;
let creados: Evento[] = [];
/** Si está puesto, la siguiente lectura de eventos espera a que se resuelva. */
let retener: Promise<void> | null = null;
const lecturas = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabla: string) => {
      const filas = () => (tabla === 'events' ? creados : []);
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        if (tabla === 'events') lecturas();
        return (retener ?? Promise.resolve()).then(() => ({ data: filas(), error: null })).then(res, rej);
      };
      return q;
    },
    rpc: () => Promise.resolve({ data: [], error: null }),
  },
}));
// La misma función en cada render, como la de verdad: de `toast` depende
// fetchMyEvents, y una nueva por render la haría releer sin parar.
const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
const AUTH = { user: { id: 'yo' } };
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel?: (s: typeof AUTH) => unknown) => (sel ? sel(AUTH) : AUTH),
}));
// La ficha de verdad trae medio mapa detrás; aquí solo importa que se cierra.
vi.mock('@/components/map/EventBottomSheet', () => ({
  EventBottomSheet: ({ event, onClose }: { event: { title: string }; onClose: () => void }) => (
    <div role="dialog" aria-label={event.title}>
      <button onClick={onClose}>cerrar ficha</button>
    </div>
  ),
}));

const { default: MyEvents } = await import('@/pages/MyEvents');

const evento = (n: number): Evento => {
  const inicio = new Date(Date.now() + n * 3600_000);
  return {
    id: `e${n}`, title: `Plan ${String(n).padStart(2, '0')}`, category: 'study', creator_id: 'yo', is_active: true,
    starts_at: inicio.toISOString(), ends_at: new Date(inicio.getTime() + 3600_000).toISOString(),
    lng: null, lat: null, current_spots: 1, max_spots: 10, privacy: 'public',
  };
};

const montar = () => render(
  <HelmetProvider>
    <MemoryRouter><MyEvents /></MemoryRouter>
  </HelmetProvider>,
);

const tarjeta = (titulo: string) => screen.getByText(titulo).closest('button')!;

beforeEach(async () => {
  cleanup();
  vi.clearAllMocks();
  retener = null;
  await i18n.changeLanguage('es');
});

describe('cerrar una ficha', () => {
  it('relee la lista sin quitar las tarjetas de la pantalla', async () => {
    creados = [evento(1), evento(2), evento(3)];
    const { container } = montar();
    fireEvent.click(await screen.findByText('Plan 02'));
    expect(screen.getByRole('dialog', { name: 'Plan 02' })).toBeInTheDocument();
    expect(lecturas).toHaveBeenCalledTimes(1);

    // La relectura se queda en el aire: es justo el momento que antes
    // enseñaba tres esqueletos en vez de la lista.
    let soltar!: () => void;
    retener = new Promise<void>((r) => { soltar = r; });
    fireEvent.click(screen.getByText('cerrar ficha'));
    await waitFor(() => expect(lecturas).toHaveBeenCalledTimes(2));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Plan 01')).toBeInTheDocument();
    expect(screen.getByText('Plan 02')).toBeInTheDocument();
    expect(screen.getByText('Plan 03')).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();

    // Y cuando llega, la lista refleja lo nuevo (aquí, un plan cancelado).
    creados = [evento(1), evento(3)];
    soltar();
    await waitFor(() => expect(screen.queryByText('Plan 02')).not.toBeInTheDocument());
    expect(screen.getByText('Plan 01')).toBeInTheDocument();
  });

  it('la primera carga sí enseña esqueletos', async () => {
    creados = [evento(1)];
    let soltar!: () => void;
    retener = new Promise<void>((r) => { soltar = r; });
    const { container } = montar();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    soltar();
    expect(await screen.findByText('Plan 01')).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

describe('«Cargar más»', () => {
  it('solo marca para animar las tarjetas nuevas', async () => {
    creados = Array.from({ length: 14 }, (_, i) => evento(i + 1));
    montar();
    await screen.findByText('Plan 01');
    // Al cargar entran todas las visibles.
    expect(tarjeta('Plan 01')).toHaveAttribute('data-reveal');
    expect(tarjeta('Plan 10')).toHaveAttribute('data-reveal');
    expect(screen.queryByText('Plan 11')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    expect(await screen.findByText('Plan 14')).toBeInTheDocument();
    expect(tarjeta('Plan 01')).not.toHaveAttribute('data-reveal');
    expect(tarjeta('Plan 10')).not.toHaveAttribute('data-reveal');
    expect(tarjeta('Plan 11')).toHaveAttribute('data-reveal');
    expect(tarjeta('Plan 14')).toHaveAttribute('data-reveal');
  });

  it('al cambiar de pestaña vuelven a entrar todas', async () => {
    creados = Array.from({ length: 14 }, (_, i) => evento(i + 1));
    montar();
    await screen.findByText('Plan 01');
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await screen.findByText('Plan 14');
    fireEvent.click(screen.getByRole('button', { name: 'Pasados' }));
    fireEvent.click(screen.getByRole('button', { name: 'Próximos' }));
    expect(tarjeta('Plan 01')).toHaveAttribute('data-reveal');
  });
});
