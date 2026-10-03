/**
 * Las insignias del perfil y su detalle.
 *
 * Lo que se fija: cada insignia es un botón con nombre legible, tocarla abre
 * una hoja con qué significa, cómo se consigue, cuánto llevas y desde cuándo
 * la tienes; la hoja se cierra con su botón y con Escape, y devuelve el foco
 * a la insignia; y sin dato de avance no se inventa un «0 de 5».
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import i18n from '@/i18n';
import { BadgeGrid } from '@/components/profile/BadgeGrid';
import { BADGE_DEFINITIONS } from '@/lib/constants';
import type { BadgeType } from '@/lib/categoryIcons';

const AVANCE: Record<BadgeType, number> = { organizer: 3, explorer: 0, study_buddy: 1, team_player: 5, streak_7: 2 };
// Mediodía UTC: el mismo día en cualquier huso donde corra la prueba.
const GANADAS = { team_player: '2026-09-12T12:00:00+00:00' };

beforeEach(async () => {
  cleanup();
  await i18n.changeLanguage('es');
});

describe('la tarjeta', () => {
  it('cada insignia es un botón, con nombre entero para el lector de pantalla', () => {
    render(<BadgeGrid earned={GANADAS} progress={AVANCE} />);
    expect(screen.getAllByRole('button')).toHaveLength(BADGE_DEFINITIONS.length);
    expect(screen.getByRole('button', { name: 'Organizador. Crea 5 eventos. 3 de 5' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Jugador en equipo. ¡Conseguida!' })).toBeInTheDocument();
  });

  it('sigue enseñando el requisito y el avance sin abrir nada', () => {
    render(<BadgeGrid earned={{}} progress={AVANCE} />);
    const tarjeta = screen.getByRole('button', { name: /^Organizador/ });
    expect(within(tarjeta).getByText('Crea 5 eventos')).toBeInTheDocument();
    expect(within(tarjeta).getByText('3/5')).toBeInTheDocument();
  });
});

describe('el detalle', () => {
  it('bloqueada: qué significa, cómo se consigue y cuánto llevas', () => {
    render(<BadgeGrid earned={GANADAS} progress={AVANCE} />);
    fireEvent.click(screen.getByRole('button', { name: /^Organizador/ }));

    const hoja = screen.getByRole('dialog', { name: 'Organizador' });
    expect(within(hoja).getByText('Aún no la tienes')).toBeInTheDocument();
    expect(within(hoja).getByText('Reconoce a quien organiza eventos para los demás.')).toBeInTheDocument();
    expect(within(hoja).getByText('Cómo se consigue')).toBeInTheDocument();
    expect(within(hoja).getByText('Crea 5 eventos')).toBeInTheDocument();
    const barra = within(hoja).getByRole('progressbar', { name: '3 de 5' });
    expect(barra).toHaveAttribute('aria-valuenow', '3');
    expect(barra).toHaveAttribute('aria-valuemax', '5');
  });

  it('conseguida: dice desde cuándo, y el avance sale completo', () => {
    render(<BadgeGrid earned={GANADAS} progress={AVANCE} />);
    fireEvent.click(screen.getByRole('button', { name: /^Jugador en equipo/ }));

    const hoja = screen.getByRole('dialog', { name: 'Jugador en equipo' });
    expect(within(hoja).getByText('Conseguida el 12 de septiembre de 2026')).toBeInTheDocument();
    expect(within(hoja).queryByText('Aún no la tienes')).not.toBeInTheDocument();
    expect(within(hoja).getByRole('progressbar', { name: '5 de 5' })).toHaveAttribute('aria-valuenow', '5');
  });

  it('conseguida sin fecha legible: lo dice igual, sin inventar un día', () => {
    render(<BadgeGrid earned={{ team_player: '' }} progress={AVANCE} />);
    fireEvent.click(screen.getByRole('button', { name: /^Jugador en equipo/ }));
    const hoja = screen.getByRole('dialog');
    expect(within(hoja).getByText('¡Conseguida!')).toBeInTheDocument();
    expect(within(hoja).queryByText(/Conseguida el/)).not.toBeInTheDocument();
  });

  it('sin dato de avance no pinta un «0 de 5» que sería mentira', () => {
    render(<BadgeGrid earned={{}} progress={null} />);
    fireEvent.click(screen.getByRole('button', { name: /^Organizador/ }));
    const hoja = screen.getByRole('dialog');
    expect(within(hoja).getByText('Crea 5 eventos')).toBeInTheDocument();
    expect(within(hoja).queryByRole('progressbar')).not.toBeInTheDocument();
    expect(within(hoja).queryByText('Tu avance')).not.toBeInTheDocument();
  });

  it('en inglés, en inglés (también la fecha y el botón de cerrar)', async () => {
    await i18n.changeLanguage('en');
    render(<BadgeGrid earned={GANADAS} progress={AVANCE} />);
    fireEvent.click(screen.getByRole('button', { name: /^Team Player/ }));
    const hoja = screen.getByRole('dialog', { name: 'Team Player' });
    expect(within(hoja).getByText('Earned on September 12, 2026')).toBeInTheDocument();
    expect(within(hoja).getByText('How to earn it')).toBeInTheDocument();
    // Los dos: el botón de abajo y la X de la esquina, que antes decía
    // «Close» también en español.
    expect(within(hoja).getAllByRole('button', { name: 'Close' })).toHaveLength(2);
  });

  it('las cinco tienen su explicación en los dos idiomas', async () => {
    for (const lang of ['es', 'en']) {
      await i18n.changeLanguage(lang);
      for (const { type } of BADGE_DEFINITIONS) {
        expect(i18n.exists(`badges.about.${type}`), `${lang}/${type}`).toBe(true);
        expect(i18n.exists(`badges.how.${type}`), `${lang}/${type}`).toBe(true);
      }
    }
  });
});

describe('cerrar', () => {
  it('con el botón, y el foco vuelve a la insignia', async () => {
    render(<BadgeGrid earned={GANADAS} progress={AVANCE} />);
    const tarjeta = screen.getByRole('button', { name: /^Organizador/ });
    tarjeta.focus();
    fireEvent.click(tarjeta);
    const hoja = screen.getByRole('dialog');

    // El de abajo, el grande. La X de la esquina se llama igual.
    fireEvent.click(within(hoja).getAllByRole('button', { name: 'Cerrar' })[0]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(tarjeta).toHaveFocus());
  });

  it('con Escape', async () => {
    render(<BadgeGrid earned={GANADAS} progress={AVANCE} />);
    fireEvent.click(screen.getByRole('button', { name: /^Explorador/ }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('se puede abrir otra después: no se queda pegada la anterior', async () => {
    render(<BadgeGrid earned={GANADAS} progress={AVANCE} />);
    fireEvent.click(screen.getByRole('button', { name: /^Explorador/ }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Racha de 7 días/ }));
    const hoja = screen.getByRole('dialog', { name: 'Racha de 7 días' });
    expect(within(hoja).getByText(/No hace falta que sean seguidos/)).toBeInTheDocument();
  });
});
