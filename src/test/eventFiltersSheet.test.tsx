import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { EventFiltersSheet } from '@/components/map/EventFiltersSheet';
import { ActiveFilterChips } from '@/components/map/ActiveFilterChips';
import { useEventStore, type MapEvent } from '@/stores/eventStore';
import { DEFAULT_ADVANCED_FILTERS } from '@/lib/eventFilter';
import i18n from '@/i18n';

const at = (d: number, h: number) => new Date(2026, 8, d, h).toISOString();
const ev = (id: string, d: number, h: number, over: Partial<MapEvent> = {}): MapEvent => ({
  id, creator_id: 'c', title: `Evento ${id}`, category: 'social', location: { lng: 0, lat: 0 },
  address: null, description: null, starts_at: at(d, h), ends_at: at(d, h + 1),
  max_spots: 6, current_spots: 0, privacy: 'open', is_active: true, ...over,
});

beforeEach(async () => {
  cleanup();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 15, 10, 0));
  useEventStore.setState({ filterCategory: null, advancedFilters: DEFAULT_ADVANCED_FILTERS });
  await i18n.changeLanguage('es');
});
afterEach(() => vi.useRealTimers());

describe('EventFiltersSheet', () => {
  const events = [ev('hoy', 15, 18), ev('manana', 16, 9), ev('lleno', 16, 20, { max_spots: 2, current_spots: 2 })];

  it('aplica al momento y dice cuántos eventos quedan', () => {
    render(<EventFiltersSheet open onOpenChange={vi.fn()} events={events} searchQuery="" />);
    expect(screen.getByRole('button', { name: 'Ver 3 eventos' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mañana' }));
    expect(useEventStore.getState().advancedFilters.when).toBe('tomorrow');
    expect(screen.getByRole('button', { name: 'Ver 2 eventos' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Solo con lugares disponibles' }));
    expect(screen.getByRole('button', { name: 'Ver 1 evento' })).toBeInTheDocument();

    // Tocar otra vez el mismo atajo lo quita.
    fireEvent.click(screen.getByRole('button', { name: 'Mañana' }));
    expect(useEventStore.getState().advancedFilters.when).toBe('any');
  });

  it('"Quitar filtros" no toca la categoría elegida fuera de la hoja', () => {
    useEventStore.setState({ filterCategory: 'sports', advancedFilters: { ...DEFAULT_ADVANCED_FILTERS, when: 'today', size: 'small' } });
    render(<EventFiltersSheet open onOpenChange={vi.fn()} events={events} searchQuery="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Quitar filtros' }));
    expect(useEventStore.getState().advancedFilters).toEqual(DEFAULT_ADVANCED_FILTERS);
    expect(useEventStore.getState().filterCategory).toBe('sports');
  });
});

describe('ActiveFilterChips', () => {
  it('enseña cada filtro activo y la X quita solo ese', () => {
    useEventStore.setState({ advancedFilters: { ...DEFAULT_ADVANCED_FILTERS, when: 'now', dayParts: ['morning', 'evening'] } });
    const { container } = render(<ActiveFilterChips onOpen={vi.fn()} />);
    expect(within(container).getByText('Ahora')).toBeInTheDocument();
    expect(within(container).getByText('Por la mañana, Por la noche')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Quitar filtro Ahora' }));
    expect(useEventStore.getState().advancedFilters.when).toBe('any');
    expect(useEventStore.getState().advancedFilters.dayParts).toEqual(['morning', 'evening']);
  });

  it('sin filtros no ocupa sitio', () => {
    const { container } = render(<ActiveFilterChips onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
