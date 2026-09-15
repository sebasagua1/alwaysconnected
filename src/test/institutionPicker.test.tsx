import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import i18n from '@/i18n';
import { InstitutionPicker } from '@/components/ui/institution-picker';
import Onboarding from '@/pages/Onboarding';
import { groupByCountry, matchesQuery, type CampusOption } from '@/lib/institutions';

// Lo que devuelve campus_options para alguien con correo genérico, con los
// mismos nombres que siembra 20260915000000_catalogo-universidades.sql. Que
// la base devuelva exactamente esto lo prueba institutionCatalog.sql.test.ts;
// aquí se prueba que la pantalla lo pinte bien.
const op = (o: Partial<CampusOption> & Pick<CampusOption, 'slug' | 'name' | 'university_slug' | 'university_name' | 'country_code'>): CampusOption => ({
  id: `id-${o.slug}`,
  campus_name: null,
  city: null,
  short_name: null,
  university_short_name: o.university_slug,
  email_verified: false,
  ...o,
});

const TEC = { university_slug: 'tec', university_name: 'Tecnológico de Monterrey', university_short_name: 'Tec', country_code: 'MX' };

const CATALOGO: CampusOption[] = [
  op({ ...TEC, slug: 'tec-queretaro', name: 'Tecnológico de Monterrey, Campus Querétaro', campus_name: 'Querétaro', city: 'Querétaro', short_name: 'Tec QRO' }),
  op({ ...TEC, slug: 'tec-guadalajara', name: 'Tecnológico de Monterrey, Campus Guadalajara', campus_name: 'Guadalajara', city: 'Zapopan', short_name: 'Tec GDL' }),
  op({ ...TEC, slug: 'tec-monterrey', name: 'Tecnológico de Monterrey, Campus Monterrey', campus_name: 'Monterrey', city: 'Monterrey', short_name: 'Tec MTY' }),
  op({ ...TEC, slug: 'tec-ciudad-de-mexico', name: 'Tecnológico de Monterrey, Campus Ciudad de México', campus_name: 'Ciudad de México', city: 'Ciudad de México', short_name: 'Tec CCM' }),
  op({ slug: 'florida-state', name: 'Florida State University', university_slug: 'florida-state', university_name: 'Florida State University', university_short_name: 'FSU', country_code: 'US', city: 'Tallahassee', short_name: 'FSU' }),
  op({ slug: 'purdue', name: 'Purdue University', university_slug: 'purdue', university_name: 'Purdue University', university_short_name: 'Purdue', country_code: 'US', city: 'West Lafayette', short_name: 'Purdue' }),
  op({ slug: 'icesi', name: 'Universidad Icesi', university_slug: 'icesi', university_name: 'Universidad Icesi', university_short_name: 'Icesi', country_code: 'CO', city: 'Cali', short_name: 'Icesi' }),
  op({ slug: 'javeriana', name: 'Pontificia Universidad Javeriana', university_slug: 'javeriana', university_name: 'Pontificia Universidad Javeriana', university_short_name: 'Javeriana', country_code: 'CO', city: 'Bogotá', short_name: 'Javeriana' }),
  op({ slug: 'cesa', name: 'CESA — Colegio de Estudios Superiores de Administración', university_slug: 'cesa', university_name: 'Colegio de Estudios Superiores de Administración', university_short_name: 'CESA', country_code: 'CO', city: 'Bogotá', short_name: 'CESA' }),
];

const rpc = vi.fn();
const eq = vi.fn().mockResolvedValue({ error: null });
const update = vi.fn((_datos: Record<string, unknown>) => ({ eq }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), from: vi.fn(() => ({ update })) },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: () => ({
    user: { id: 'u1' },
    // Sin campus: el primer paso es elegirlo.
    profile: { campus_id: null },
    profileLoaded: true,
    fetchProfile: vi.fn(),
  }),
}));

beforeEach(async () => {
  cleanup();
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: CATALOGO, error: null });
  await i18n.changeLanguage('es');
});

const opciones = () => screen.getAllByRole('button', { pressed: false }).concat(screen.queryAllByRole('button', { pressed: true }));

describe('lib/institutions', () => {
  it('agrupa por país con México primero, luego Estados Unidos y Colombia', () => {
    const grupos = groupByCountry(CATALOGO, 'es');
    expect(grupos.map((g) => g.code)).toEqual(['MX', 'US', 'CO']);
    expect(grupos.map((g) => g.options.length)).toEqual([4, 2, 3]);
  });

  it('busca por nombre, abreviatura, ciudad y campus, sin acentos', () => {
    const buscar = (q: string) => CATALOGO.filter((o) => matchesQuery(o, q)).map((o) => o.slug);
    expect(buscar('fsu')).toEqual(['florida-state']);
    expect(buscar('cali')).toEqual(['icesi']);
    expect(buscar('guadalajara')).toEqual(['tec-guadalajara']);
    expect(buscar('queretaro')).toEqual(['tec-queretaro']);
    expect(buscar('CCM')).toEqual(['tec-ciudad-de-mexico']);
    expect(buscar('bogota').sort()).toEqual(['cesa', 'javeriana']);
    expect(buscar('   ')).toHaveLength(9);
  });
});

describe('InstitutionPicker', () => {
  it('muestra los nueve campus agrupados por país, sin nombres repetidos', async () => {
    render(<InstitutionPicker value={null} onChange={vi.fn()} />);
    await waitFor(() => expect(opciones()).toHaveLength(9));

    const mexico = screen.getByRole('region', { name: 'México' });
    expect(within(mexico).getAllByRole('button')).toHaveLength(4);
    expect(within(screen.getByRole('region', { name: 'Estados Unidos' })).getAllByRole('button')).toHaveLength(2);
    expect(within(screen.getByRole('region', { name: 'Colombia' })).getAllByRole('button')).toHaveLength(3);

    const nombres = opciones().map((b) => b.querySelector('span')?.textContent);
    expect(nombres).toContain('Campus Guadalajara');
    expect(new Set(nombres).size).toBe(9);
  });

  it('filtra con la búsqueda', async () => {
    render(<InstitutionPicker value={null} onChange={vi.fn()} />);
    await waitFor(() => expect(opciones()).toHaveLength(9));
    fireEvent.change(screen.getByRole('textbox', { name: /Buscar/ }), { target: { value: 'purdue' } });
    expect(opciones()).toHaveLength(1);
    fireEvent.change(screen.getByRole('textbox', { name: /Buscar/ }), { target: { value: 'harvard' } });
    expect(screen.getByText('No se encontraron campus')).toBeInTheDocument();
  });

  it('avisa del error de carga y permite reintentar', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'network' } });
    render(<InstitutionPicker value={null} onChange={vi.fn()} />);
    const aviso = await screen.findByRole('alert');
    fireEvent.click(within(aviso).getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(opciones()).toHaveLength(9));
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('con correo del Tec explica por qué solo salen sus campus', async () => {
    rpc.mockResolvedValue({ data: CATALOGO.slice(0, 4).map((o) => ({ ...o, email_verified: true })), error: null });
    render(<InstitutionPicker value={null} onChange={vi.fn()} />);
    expect(await screen.findByText(/Tu correo es de Tecnológico de Monterrey/)).toBeInTheDocument();
    expect(opciones()).toHaveLength(4);
  });
});

describe('Onboarding con el nuevo catálogo', () => {
  it.each(CATALOGO.map((o) => [o.slug, o] as const))('guarda %s como campus del perfil', async (_slug, opcion) => {
    render(<HelmetProvider><Onboarding /></HelmetProvider>);
    const boton = await screen.findByRole('button', { name: new RegExp(opcion.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
    fireEvent.click(boton);
    expect(boton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: /Siguiente/ }));
    fireEvent.change(screen.getByLabelText(/Nombre completo/), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByRole('button', { name: /Siguiente/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Local' }));
    fireEvent.click(screen.getByRole('button', { name: /Siguiente/ }));
    fireEvent.click(screen.getByRole('button', { name: /Siguiente/ }));
    fireEvent.click(screen.getByRole('button', { name: /Siguiente/ }));
    fireEvent.click(screen.getByLabelText('Tengo 18 años o más'));
    fireEvent.click(screen.getByLabelText(/He leído y acepto los/));
    fireEvent.click(screen.getByRole('button', { name: 'Comenzar' }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0]).toMatchObject({ campus_id: opcion.id, onboarding_completed: true });
  });
});
