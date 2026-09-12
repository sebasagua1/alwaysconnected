import { describe, expect, it } from 'vitest';
import { MEXICO_STATES, formatOrigin, residenceFromOrigin } from '@/lib/origin';

// residence_type y origin decían lo mismo en dos columnas y podían
// contradecirse. Ahora solo se pregunta origin y de ahí se deriva la otra, así
// que esta función es la que sostiene el dato: si se equivoca, un perfil queda
// clasificado mal para siempre.

describe('residenceFromOrigin', () => {
  it('sin origen es de aquí', () => {
    expect(residenceFromOrigin(null)).toBe('local');
    expect(residenceFromOrigin(undefined)).toBe('local');
    // Cadena vacía incluida: es lo que dejaría un <input> vaciado a mano.
    expect(residenceFromOrigin('')).toBe('local');
  });

  it('dos letras mayúsculas es un país', () => {
    expect(residenceFromOrigin('CO')).toBe('international');
    expect(residenceFromOrigin('US')).toBe('international');
  });

  it('un nombre de estado es foráneo', () => {
    expect(residenceFromOrigin('Jalisco')).toBe('foraneo');
    expect(residenceFromOrigin('Nuevo León')).toBe('foraneo');
  });

  // Lo que hace que la deducción sea segura: ningún estado puede confundirse
  // con un código ISO. Si algún día se añade uno de dos letras, esto avisa.
  it('ningún estado de México colisiona con un código de país', () => {
    const colisionan = MEXICO_STATES.filter((s) => residenceFromOrigin(s) !== 'foraneo');
    expect(colisionan).toEqual([]);
  });

  it('es coherente con cómo formatOrigin ya distinguía los dos casos', () => {
    // Un país se traduce; un estado se devuelve tal cual.
    expect(formatOrigin('CO', 'es')).not.toBe('CO');
    expect(formatOrigin('Jalisco', 'es')).toBe('Jalisco');
  });
});

// --- El selector combinado ---

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PlacePicker } from '@/components/ui/place-picker';
import i18n from '@/i18n';
import { beforeEach, vi } from 'vitest';

beforeEach(async () => {
  cleanup();
  await i18n.changeLanguage('es');
});

describe('PlacePicker: estados y países en una sola lista', () => {
  it('ofrece «soy de aquí» y devuelve null, que es lo que se guarda', () => {
    const alCambiar = vi.fn();
    render(<PlacePicker value={undefined} onChange={alCambiar} />);
    fireEvent.click(screen.getByRole('button', { name: 'Soy de aquí' }));
    expect(alCambiar).toHaveBeenCalledWith(null);
  });

  it('busca sin acentos: «mexico» encuentra «México»', () => {
    render(<PlacePicker value={undefined} onChange={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Buscar estado o país/), {
      target: { value: 'mexico' },
    });
    expect(screen.getByRole('button', { name: 'Estado de México' })).toBeInTheDocument();
  });

  // Dejar «soy de aquí» fijo arriba mientras se teclea «Jalisco» es ruido.
  it('«soy de aquí» desaparece al buscar otra cosa', () => {
    render(<PlacePicker value={undefined} onChange={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Buscar estado o país/), {
      target: { value: 'Jalisco' },
    });
    expect(screen.queryByRole('button', { name: 'Soy de aquí' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Jalisco' })).toBeInTheDocument();
  });
});
