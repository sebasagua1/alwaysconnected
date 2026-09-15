import { create } from 'zustand';
import { DEFAULT_ADVANCED_FILTERS, type AdvancedFilters } from '@/lib/eventFilter';

export interface MapEvent {
  id: string;
  creator_id: string;
  title: string;
  category: string;
  location: { lng: number; lat: number } | null;
  address: string | null;
  description: string | null;
  starts_at: string;
  ends_at: string;
  max_spots: number;
  current_spots: number;
  privacy: string;
  is_active: boolean;
  creator_name?: string;
  creator_avatar?: string;
  participants?: Array<{ user_id: string; name: string; avatar_url: string | null }>;
}

interface EventState {
  events: MapEvent[];
  /**
   * Se guarda el id y no el objeto. Guardando el objeto, la hoja abierta
   * enseñaba una copia congelada: si el aforo cambiaba por tiempo real había
   * que cerrarla y volver a abrirla para ver la cifra nueva. Quien lo consume
   * busca el evento en `events`, que sí se refresca.
   */
  selectedEventId: string | null;
  filterCategory: string | null;
  /**
   * Cuándo, duración y tipo. En el store y no en la pantalla del mapa para
   * que sobrevivan a ir a otra pestaña y volver.
   */
  advancedFilters: AdvancedFilters;
  setEvents: (events: MapEvent[]) => void;
  upsertEvent: (event: MapEvent) => void;
  removeEvent: (id: string) => void;
  setSelectedEvent: (event: MapEvent | null) => void;
  setFilterCategory: (cat: string | null) => void;
  setAdvancedFilters: (patch: Partial<AdvancedFilters>) => void;
  /** Vuelve a enseñarlo todo: categoría y filtros avanzados. */
  resetFilters: () => void;
}

export const useEventStore = create<EventState>((set) => ({
  events: [],
  selectedEventId: null,
  filterCategory: null,
  advancedFilters: DEFAULT_ADVANCED_FILTERS,
  setEvents: (events) => set({ events }),
  /**
   * Mete el evento si es nuevo y lo reemplaza EN SU SITIO si ya estaba.
   *
   * La posición importa: es lo que consume la vista de lista, y mover una
   * fila porque a alguien le cambió el aforo haría saltar las tarjetas bajo
   * el dedo de quien está leyendo.
   */
  upsertEvent: (event) => set((s) => {
    const i = s.events.findIndex((e) => e.id === event.id);
    if (i === -1) return { events: [event, ...s.events] };
    const events = s.events.slice();
    events[i] = event;
    return { events };
  }),
  // Al cancelar un evento hay que sacarlo del store a mano: los marcadores del
  // mapa son DOM imperativo que solo se reconstruye cuando cambia `events`, y
  // esperar al refetch por realtime deja el pin visible mientras tanto.
  removeEvent: (id) => set((s) => ({
    events: s.events.filter((e) => e.id !== id),
    selectedEventId: s.selectedEventId === id ? null : s.selectedEventId,
  })),
  // Sigue recibiendo el evento entero por comodidad de quien llama; lo que se
  // guarda es solo su id.
  setSelectedEvent: (event) => set({ selectedEventId: event?.id ?? null }),
  setFilterCategory: (filterCategory) => set({ filterCategory }),
  setAdvancedFilters: (patch) => set((s) => ({ advancedFilters: { ...s.advancedFilters, ...patch } })),
  resetFilters: () => set({ filterCategory: null, advancedFilters: DEFAULT_ADVANCED_FILTERS }),
}));

/**
 * El evento abierto, resuelto contra la lista viva. Es un selector y no un
 * campo del store precisamente para que no haya nada que se quede congelado:
 * cada render lo vuelve a buscar. Devuelve null si el evento ya no está —lo
 * cancelaron mientras lo mirabas—, con lo que la hoja se cierra sola.
 */
export const selectSelectedEvent = (s: EventState): MapEvent | null =>
  s.selectedEventId ? s.events.find((e) => e.id === s.selectedEventId) ?? null : null;
