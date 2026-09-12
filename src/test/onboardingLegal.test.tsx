import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import Onboarding from '@/pages/Onboarding';
import i18n from '@/i18n';

// La app se publica con clasificacion 18+ y los terminos exigen 18 anos. Hasta
// que existio este paso eso solo estaba ESCRITO: nadie lo confirmaba. Estos
// tests fijan que no se pueda terminar el perfil sin confirmarlo, que es lo que
// un refactor del onboarding podria romper sin que se note.
//
// El fallo concreto que casi se cuela: el boton final solo miraba `loading`,
// no `canProceed()`. Con el paso legal al final, eso dejaba terminar sin marcar
// nada.

const actualizar = vi.fn().mockResolvedValue({ error: null });
const eq = vi.fn(() => actualizar());
// El argumento va declarado a proposito: sin el, `update.mock.calls[0][0]` es
// un error de tipos porque la tupla de argumentos queda vacia, y lo que este
// test comprueba es justamente QUE se guarda.
const update = vi.fn((_datos: Record<string, unknown>) => ({ eq }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn(() => ({ update })) },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: () => ({
    user: { id: 'u1' },
    // Con campus_id ya asignado no aparece el paso de elegir institucion, asi
    // que el recorrido es: basicos, residencia, intereses, idiomas, legal.
    profile: { campus_id: 'c1' },
    profileLoaded: true,
    fetchProfile: vi.fn(),
  }),
}));

const montar = () => render(<HelmetProvider><Onboarding /></HelmetProvider>);

const siguiente = () => fireEvent.click(screen.getByRole('button', { name: /Siguiente/ }));

/** Rellena los pasos previos y deja la pantalla en el paso legal. */
const llegarAlPasoLegal = () => {
  montar();
  fireEvent.change(screen.getByLabelText(/Nombre completo/), { target: { value: 'Ana' } });
  siguiente();
  // Un solo paso de procedencia: «Soy de aquí» guarda origin=null, y de ahi se
  // deriva residence_type. Antes eran dos pantallas.
  fireEvent.click(screen.getByRole('button', { name: 'Soy de aquí' }));
  siguiente();
  siguiente(); // intereses, opcionales
  siguiente(); // idiomas, opcionales
};

// `onboarding.getStarted`. Exacto y no una alternancia de posibles: si algun
// dia cambia la etiqueta, es mejor que el test falle y se mire, a que encaje
// por casualidad con otro boton de la pantalla.
const botonFinal = () => screen.getByRole('button', { name: 'Comenzar' });

beforeEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await i18n.changeLanguage('es');
});

describe('Onboarding: la puerta legal', () => {
  it('el paso legal es el ULTIMO, no uno del que se pueda seguir adelante', () => {
    llegarAlPasoLegal();
    expect(screen.getByText('Una última cosa')).toBeInTheDocument();
    // Si hubiera un "Siguiente" es que el paso legal no es el final y se podria
    // rebasar sin marcar nada.
    expect(screen.queryByRole('button', { name: /Siguiente/ })).not.toBeInTheDocument();
  });

  it('sin marcar nada, no deja terminar', () => {
    llegarAlPasoLegal();
    expect(botonFinal()).toBeDisabled();
  });

  it('con solo la edad marcada, sigue sin dejar', () => {
    llegarAlPasoLegal();
    fireEvent.click(screen.getByLabelText('Tengo 18 años o más'));
    expect(botonFinal()).toBeDisabled();
  });

  it('con solo los términos marcados, sigue sin dejar', () => {
    llegarAlPasoLegal();
    fireEvent.click(screen.getByLabelText(/He leído y acepto los/));
    expect(botonFinal()).toBeDisabled();
  });

  it('con las dos marcadas, deja terminar y guarda la constancia', async () => {
    llegarAlPasoLegal();
    fireEvent.click(screen.getByLabelText('Tengo 18 años o más'));
    fireEvent.click(screen.getByLabelText(/He leído y acepto los/));
    expect(botonFinal()).toBeEnabled();

    fireEvent.click(botonFinal());
    // waitFor de RTL y no el de vitest: envuelve la espera en act(), asi que
    // el setLoading(false) de despues del await no deja el aviso de React.
    await waitFor(() => expect(update).toHaveBeenCalled());

    // Las dos fechas van en el MISMO update que marca el perfil como
    // terminado: o queda todo, o no queda nada.
    const guardado = update.mock.calls[0][0] as Record<string, unknown>;
    expect(guardado.onboarding_completed).toBe(true);
    expect(typeof guardado.terms_accepted_at).toBe('string');
    expect(typeof guardado.age_confirmed_at).toBe('string');
    expect(Date.parse(guardado.terms_accepted_at as string)).not.toBeNaN();
  });

  it('las casillas empiezan sin marcar: un consentimiento por defecto no lo es', () => {
    llegarAlPasoLegal();
    expect(screen.getByLabelText('Tengo 18 años o más')).not.toBeChecked();
    expect(screen.getByLabelText(/He leído y acepto los/)).not.toBeChecked();
  });

  it('los términos y la privacidad se pueden leer ANTES de aceptarlos', () => {
    llegarAlPasoLegal();
    // Enlaces de verdad, fuera de la etiqueta de la casilla: si estuvieran
    // dentro, pulsarlos marcaria la casilla ademas de abrir el enlace.
    const terminos = screen.getByRole('link', { name: /Términos de uso/ });
    const privacidad = screen.getByRole('link', { name: /Aviso de privacidad/ });
    expect(terminos).toHaveAttribute('href', expect.stringContaining('/terms'));
    expect(privacidad).toHaveAttribute('href', expect.stringContaining('/privacy'));
    fireEvent.click(terminos);
    expect(screen.getByLabelText(/He leído y acepto los/)).not.toBeChecked();
  });
});
