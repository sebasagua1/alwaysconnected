/**
 * El perfil propio y la ficha de otra persona, con Supabase simulado.
 *
 * Lo que se fija: en la interfaz solo hay una moneda, los puntos. Ni anillo,
 * ni niveles, ni cifra de «Reputación» en ninguna de las dos pantallas, y la
 * ficha ajena ni siquiera la pide. Y que el perfil trae la fecha de cada
 * insignia para poder enseñarla en su detalle.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import i18n from '@/i18n';

/** Qué columnas se pidieron de cada tabla. */
const pedidos: Array<[string, string]> = [];
const TABLAS: Record<string, unknown[]> = {
  badges: [{ badge_type: 'organizer', earned_at: '2026-09-12T12:00:00+00:00' }],
  event_participants: [
    { status: 'joined', checked_in: true, joined_at: '2026-09-01T10:00:00+00:00', events: { category: 'study' } },
    { status: 'joined', checked_in: false, joined_at: '2026-09-02T10:00:00+00:00', events: { category: 'sports' } },
  ],
  point_events: [{ id: 'p1', points: 25, reason: 'organize', created_at: '2026-09-12T12:00:00+00:00' }],
  public_profiles: [{
    id: 'otra', name: 'Lucía', avatar_url: null, major: 'Diseño', semester: 3, residence_type: null, interests: [],
    languages: [], points: 340, origin: null, institution_verified: false, university_name: null, campus_name: null,
    institution_type: null,
  }],
};

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabla: string) => {
      const filas = TABLAS[tabla] ?? [];
      const q: Record<string, unknown> = {};
      q.select = (cols: string) => { pedidos.push([tabla, cols]); return q; };
      for (const m of ['eq', 'order', 'limit']) q[m] = () => q;
      q.maybeSingle = () => Promise.resolve({ data: filas[0] ?? null, error: null });
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve({ data: filas, error: null, count: 4 }).then(res, rej);
      return q;
    },
    rpc: () => Promise.resolve({ data: [], error: null }),
  },
}));
const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
const AUTH = {
  profile: {
    id: 'yo', name: 'Sebastián', avatar_url: null, major: 'Ingeniería', semester: 5, residence_type: null,
    origin: null, interests: [], languages: [], student_id: null, points: 480, reputation: 37,
  },
  signOut: vi.fn(),
  fetchProfile: vi.fn(),
};
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (sel?: (s: typeof AUTH) => unknown) => (sel ? sel(AUTH) : AUTH),
}));
// Lo que rodea a lo que se mira y trae medio mundo detrás.
vi.mock('@/components/notifications/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/profile/EditProfileSheet', () => ({ EditProfileSheet: () => null }));
vi.mock('@/components/profile/VerificationCard', () => ({ VerificationCard: () => null }));
vi.mock('@/components/profile/VerifyInstitutionSheet', () => ({ VerifyInstitutionSheet: () => null }));
vi.mock('@/components/moderation/BlockedUsersSheet', () => ({ BlockedUsersSheet: () => null }));
vi.mock('@/components/LanguageSwitcher', () => ({ LanguageSwitcher: () => null }));

const { default: Profile } = await import('@/pages/Profile');
const { UserProfileSheet } = await import('@/components/profile/UserProfileSheet');

const SIN_REPUTACION = /reputaci[oó]n|reputation|siguiente nivel|next level/i;

beforeEach(async () => {
  cleanup();
  vi.clearAllMocks();
  pedidos.length = 0;
  await i18n.changeLanguage('es');
});

describe('perfil propio', () => {
  const montar = () => render(<HelmetProvider><MemoryRouter><Profile /></MemoryRouter></HelmetProvider>);

  it('enseña los puntos y nada de reputación: ni anillo, ni niveles, ni cifra', async () => {
    montar();
    await screen.findByText('Organizaste un evento');
    // La cifra de puntos, con su etiqueta.
    const puntos = screen.getByText('Puntos').parentElement!;
    expect(within(puntos).getByText('480')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(SIN_REPUTACION);
    // El 37 era la cifra del centro del anillo.
    expect(screen.queryByText('37')).not.toBeInTheDocument();
    for (const nivel of ['Nuevo', 'Regular', 'Activo', 'Leyenda']) {
      expect(screen.queryByText(nivel)).not.toBeInTheDocument();
    }
  });

  it('en inglés tampoco', async () => {
    await i18n.changeLanguage('en');
    montar();
    await screen.findByText('Points');
    expect(document.body.textContent).not.toMatch(SIN_REPUTACION);
  });

  it('los textos de reputación ya no existen en ningún idioma', async () => {
    for (const lang of ['es', 'en']) {
      await i18n.changeLanguage(lang);
      for (const key of ['profile.reputation', 'profile.rank.newcomer', 'profile.rank.legend', 'profile.ptsToNext']) {
        expect(i18n.exists(key), `${lang}: ${key}`).toBe(false);
      }
      expect(i18n.t('profile.metaDesc', { app: 'X' })).not.toMatch(SIN_REPUTACION);
    }
  });

  it('pide la fecha de cada insignia y la enseña en su detalle', async () => {
    montar();
    const tarjeta = await screen.findByRole('button', { name: 'Organizador. ¡Conseguida!' });
    expect(pedidos).toContainEqual(['badges', 'badge_type, earned_at']);
    fireEvent.click(tarjeta);
    expect(within(screen.getByRole('dialog', { name: 'Organizador' })).getByText('Conseguida el 12 de septiembre de 2026')).toBeInTheDocument();
  });

  it('el historial de puntos sigue ahí', async () => {
    montar();
    expect(await screen.findByText('Organizaste un evento')).toBeInTheDocument();
    expect(screen.getByText('+25')).toBeInTheDocument();
  });
});

describe('ficha de otra persona', () => {
  it('enseña sus puntos, no reputación, y ni siquiera la pide', async () => {
    render(<UserProfileSheet userId="otra" onClose={() => {}} />);
    const puntos = (await screen.findByText('Puntos')).parentElement!;
    expect(within(puntos).getByText('340')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(SIN_REPUTACION);
    const [, columnas] = pedidos.find(([t]) => t === 'public_profiles')!;
    expect(columnas).toContain('points');
    expect(columnas).not.toContain('reputation');
  });
});
