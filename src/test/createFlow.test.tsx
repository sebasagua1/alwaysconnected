import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PrivacySelector } from '@/components/ui/privacy-selector';
import { EventListView } from '@/components/map/EventListView';
import type { MapEvent } from '@/stores/eventStore';
import i18n from '@/i18n';

// vi.mock se ELEVA al principio del archivo, asi que estas cuatro valen para
// todo el modulo aunque solo las necesite el ultimo describe. Van aqui para
// que se vea, y no escondidas a mitad del archivo.
vi.mock('@/lib/geocode', () => ({ reverseGeocode: vi.fn().mockResolvedValue(null) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: () => ({ user: { id: 'u1' } }) }));

const evento = (over: Partial<MapEvent> = {}): MapEvent => ({
  id: 'e1', creator_id: 'u1', title: 'Estudio de cálculo', category: 'study',
  location: { lng: -98.2, lat: 19 }, address: null, description: null,
  starts_at: new Date(Date.now() + 3_600_000).toISOString(),
  ends_at: new Date(Date.now() + 7_200_000).toISOString(),
  max_spots: 10, current_spots: 1, privacy: 'open', is_active: true, ...over,
});

beforeEach(async () => { cleanup(); await i18n.changeLanguage('es'); });

describe('PrivacySelector', () => {
  it('enseña las TRES descripciones a la vez, no solo la marcada', () => {
    render(<PrivacySelector value="open" onChange={() => {}} />);
    // Antes solo se veía la de la opción activa: para comparar había que ir
    // tocando una por una, justo lo que se está decidiendo.
    expect(screen.getByText('Lo ve todo el mundo y cualquiera puede unirse.')).toBeInTheDocument();
    expect(screen.getByText('Solo lo ven tus amigos, y entran directo.')).toBeInTheDocument();
    expect(screen.getByText('Lo ve todo el mundo, pero tú apruebas quién entra.')).toBeInTheDocument();
  });

  it('son excluyentes: radiogroup con una sola marcada', () => {
    render(<PrivacySelector value="friends" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios.filter(r => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    expect(screen.getByRole('radio', { name: /Amigos/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('avisa del cambio con la clave, no con la etiqueta traducida', () => {
    const onChange = vi.fn();
    render(<PrivacySelector value="open" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: /Privado/ }));
    expect(onChange).toHaveBeenCalledWith('private');
  });
});

describe('EventListView: los dos vacíos', () => {
  const props = { filter: { category: null, query: '' }, onSelect: vi.fn() };

  it('sin NINGÚN evento: invita a crear el primero', () => {
    const onCreate = vi.fn();
    render(<EventListView {...props} events={[]} onCreate={onCreate} onClearFilters={vi.fn()} />);
    expect(screen.getByText('Todavía no hay nada por aquí')).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: /Crear el primero/ });
    fireEvent.click(cta);
    expect(onCreate).toHaveBeenCalled();
  });

  it('con eventos que el filtro descarta: NO dice que no haya nada', () => {
    const onClear = vi.fn();
    render(
      <EventListView
        {...props}
        filter={{ category: 'sports', query: '' }}
        events={[evento({ category: 'study' })]}
        onCreate={vi.fn()}
        onClearFilters={onClear}
      />
    );
    // El error que se está evitando: decir "crea el primero" cuando el campus
    // sí tiene eventos y lo único mal puesto es el filtro.
    expect(screen.queryByText('Todavía no hay nada por aquí')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Crear el primero/ })).not.toBeInTheDocument();
    expect(screen.getByText('Ningún evento coincide con lo que buscas')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Quitar filtros/ }));
    expect(onClear).toHaveBeenCalled();
  });

  it('la búsqueda sin resultados también es un vacío de filtro', () => {
    render(
      <EventListView
        {...props}
        filter={{ category: null, query: 'zzzz' }}
        events={[evento()]}
        onCreate={vi.fn()}
        onClearFilters={vi.fn()}
      />
    );
    expect(screen.getByText('Ningún evento coincide con lo que buscas')).toBeInTheDocument();
  });

  it('con eventos visibles no enseña ningún vacío', () => {
    render(<EventListView {...props} events={[evento()]} onCreate={vi.fn()} onClearFilters={vi.fn()} />);
    expect(screen.getByText('Estudio de cálculo')).toBeInTheDocument();
    expect(screen.queryByText('Todavía no hay nada por aquí')).not.toBeInTheDocument();
  });

  it('agrupa por día y marca lo que está en curso o empieza pronto', () => {
    const now = new Date(2026, 8, 15, 10, 0);
    const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString();
    render(
      <EventListView
        {...props}
        now={now}
        events={[
          evento({ id: 'a', title: 'Pádel', starts_at: at(15, 9, 30), ends_at: at(15, 11) }),
          evento({ id: 'b', title: 'Café', starts_at: at(15, 10, 25), ends_at: at(15, 11) }),
          evento({ id: 'c', title: 'Comida', starts_at: at(16, 13), ends_at: at(16, 14) }),
          evento({ id: 'd', title: 'Estudio', starts_at: at(23, 14, 5), ends_at: at(23, 16) }),
        ]}
        onCreate={vi.fn()}
        onClearFilters={vi.fn()}
      />
    );
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Hoy', 'Mañana', 'Miércoles 23 de septiembre']);
    expect(screen.getByText('En curso')).toBeInTheDocument();
    expect(screen.getByText('Empieza en 25 min')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Regresión: ir a marcar la ubicación borraba el formulario entero.
//
// La hoja guarda título, fecha, hora, descripción, aforo… en su propio estado.
// MapHome la montaba con `{showCreate && <CreateEventSheet/>}` y ponía
// showCreate en false al saltar al mapa, así que React la DESMONTABA y con
// ella todo lo escrito. Al volver aparecía un formulario en blanco.
//
// El arreglo es apartarla de la vista sin desmontarla. Esto fija esa parte del
// contrato: `hidden` oculta, y ocultar NO es desmontar.
// ---------------------------------------------------------------------------
describe('CreateEventSheet: no se pierde lo escrito al ir a por la ubicación', () => {
  const props = { onClose: vi.fn(), onPickLocation: vi.fn(), pickedLocation: null };

  it('oculta la hoja sin desmontarla: lo escrito sigue ahí', async () => {
    const { CreateEventSheet } = await import('@/components/map/CreateEventSheet');
    const { rerender } = render(<CreateEventSheet {...props} />);

    const titulo = screen.getByPlaceholderText('Título del evento');
    fireEvent.change(titulo, { target: { value: 'Estudiar para el final' } });
    fireEvent.change(screen.getByPlaceholderText(/Descripción corta/i), {
      target: { value: 'Traigan calculadora' },
    });

    // Salta al mapa a marcar el sitio.
    rerender(<CreateEventSheet {...props} hidden />);

    // Sigue montada —ese es el punto— y conserva los valores.
    expect(screen.getByDisplayValue('Estudiar para el final')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Traigan calculadora')).toBeInTheDocument();

    // Vuelve del mapa: nada se ha perdido.
    rerender(<CreateEventSheet {...props} hidden={false} />);
    expect(screen.getByDisplayValue('Estudiar para el final')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Traigan calculadora')).toBeInTheDocument();
  });

  it('mientras está oculta no tapa el mapa ni se puede tocar', async () => {
    const { CreateEventSheet } = await import('@/components/map/CreateEventSheet');
    const { container, rerender } = render(<CreateEventSheet {...props} />);
    const raiz = () => container.querySelector('.fixed.inset-0') as HTMLElement;

    expect(raiz().className).not.toMatch(/invisible/);
    expect(raiz()).toHaveAttribute('aria-hidden', 'false');

    rerender(<CreateEventSheet {...props} hidden />);

    // Sin esto los toques para poner el pin se los comía la hoja.
    expect(raiz().className).toMatch(/invisible/);
    expect(raiz().className).toMatch(/pointer-events-none/);
    expect(raiz()).toHaveAttribute('aria-hidden', 'true');
  });
});
