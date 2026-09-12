import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import Onboarding from '@/pages/Onboarding';
import i18n from '@/i18n';

// Por esto rechazaron la 1.0 (18): "users are required to provide their name
// after using Sign in with Apple even though that information is already
// provided by the Authentication Services framework" (guideline 4).
//
// Apple manda el nombre UNA sola vez, al autorizar la app. socialAuth.ts lo
// guarda en el perfil en ese instante; lo que fija este test es la otra mitad:
// que el onboarding lo use en vez de volver a pedirlo.

const eq = vi.fn().mockResolvedValue({ error: null });
const update = vi.fn(() => ({ eq }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn(() => ({ update })) },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const perfil = vi.fn();
const usuario = vi.fn();
vi.mock('@/stores/authStore', () => ({
  useAuthStore: () => ({
    user: usuario(),
    profile: perfil(),
    profileLoaded: true,
    fetchProfile: vi.fn(),
  }),
}));

const CON_APPLE = { id: 'u1', app_metadata: { provider: 'apple', providers: ['apple'] } };
const CON_CORREO = { id: 'u1', app_metadata: { provider: 'email', providers: ['email'] } };

const montar = () => render(<HelmetProvider><Onboarding /></HelmetProvider>);
const campoNombre = () => screen.getByLabelText(/Nombre completo/) as HTMLInputElement;
const siguiente = () => screen.getByRole('button', { name: /Siguiente/ });

beforeEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await i18n.changeLanguage('es');
});

describe('Onboarding: el nombre que ya dio el proveedor', () => {
  it('llega relleno, sin que haya que teclearlo', () => {
    usuario.mockReturnValue(CON_APPLE);
    perfil.mockReturnValue({ campus_id: 'c1', name: 'Ana Pérez' });
    montar();
    expect(campoNombre().value).toBe('Ana Pérez');
  });

  // Lo que de verdad prohíbe la guideline: que el avance dependa de escribirlo.
  it('deja avanzar de inmediato, sin tocar el campo', () => {
    usuario.mockReturnValue(CON_APPLE);
    perfil.mockReturnValue({ campus_id: 'c1', name: 'Ana Pérez' });
    montar();
    expect(siguiente()).toBeEnabled();
  });

  // El caso que rechazaron y que una nota al revisor no cubre: Apple entrega
  // el nombre UNA sola vez. Quien ya autorizó la app vuelve sin él, y no hay
  // nada con que rellenar el campo. Ahí no se puede bloquear.
  it('con Apple y sin nombre, NO bloquea: no hay dato que pedir', () => {
    usuario.mockReturnValue(CON_APPLE);
    perfil.mockReturnValue({ campus_id: 'c1', name: null });
    montar();
    expect(campoNombre().value).toBe('');
    expect(siguiente()).toBeEnabled();
  });

  // El contrapunto: en un alta con correo y contraseña no hay proveedor que
  // haya dado nada, así que el nombre sigue siendo obligatorio. Sin este test,
  // los de arriba pasarían igual si se hubiera borrado la validación entera.
  it('en un alta con correo, el nombre se sigue pidiendo', () => {
    usuario.mockReturnValue(CON_CORREO);
    perfil.mockReturnValue({ campus_id: 'c1', name: null });
    montar();
    expect(campoNombre().value).toBe('');
    expect(siguiente()).toBeDisabled();
  });
});
