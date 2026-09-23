import { useTranslation } from 'react-i18next';
import { Clock, MapPin, Users, Flame, Plus, SearchX } from 'lucide-react';
import { format } from 'date-fns';
import { es as esLocale, enUS } from 'date-fns/locale';
import { EVENT_CATEGORIES } from '@/lib/constants';
import { CATEGORY_ICONS } from '@/lib/categoryIcons';
import { cn } from '@/lib/utils';
import type { MapEvent } from '@/stores/eventStore';
import { filterEvents, dayGroupKey, startsSoon, fromDateKey, type EventFilter } from '@/lib/eventFilter';
import { useStaggerReveal } from '@/hooks/useStaggerReveal';

interface Props {
  events: MapEvent[];
  filter: EventFilter;
  /** La hora con la que se filtra; la pasa el mapa para que ambos coincidan. */
  now?: Date;
  onSelect: (event: MapEvent) => void;
  onCreate: () => void;
  onClearFilters: () => void;
}

export function EventListView({ events, filter, now = new Date(), onSelect, onCreate, onClearFilters }: Props) {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language?.startsWith('en') ? enUS : esLocale;

  // Mismo criterio que los marcadores del mapa, y a propósito el mismo código:
  // por duplicado, mapa y lista acababan enseñando cosas distintas.
  const visible = filterEvents(events, filter, now);

  // Antes del return temprano de la lista vacía que hay más abajo: un hook
  // declarado después de él no se ejecutaría siempre. Depende del número de
  // eventos visibles para rehacer la cascada al cambiar de filtro.
  const listScope = useStaggerReveal<HTMLDivElement>([visible.length]);

  // Una cabecera por día ("Hoy", "Mañana", "jue 17 sep"): con la lista de
  // aquí a fin de mes seguida, encontrar qué hay el jueves era contar tarjetas.
  // La lista ya llega ordenada por inicio, así que basta con cortar.
  const groups: Array<{ key: string; items: MapEvent[] }> = [];
  for (const e of visible) {
    const key = dayGroupKey(e, now);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(e);
    else groups.push({ key, items: [e] });
  }
  const groupLabel = (key: string) => {
    if (key === 'today') return t('map.filters.today');
    if (key === 'tomorrow') return t('map.filters.tomorrow');
    const d = fromDateKey(key);
    if (!d) return key;
    // "Jueves 17 de septiembre", no "Jueves 17 Septiembre": text-transform
    // capitalize ponía mayúscula también al mes.
    const label = format(d, dateLocale === enUS ? 'EEEE, MMMM d' : "EEEE d 'de' MMMM", { locale: dateLocale });
    return label.charAt(0).toUpperCase() + label.slice(1);
  };

  // Dos vacios distintos, y decirlo importa: "crea el primero" cuando en
  // realidad hay treinta eventos y solo esta mal el filtro es mentira, y deja
  // a la persona pensando que su campus esta muerto.
  if (visible.length === 0) {
    const noHayNada = events.length === 0;
    return (
      <div className="flex flex-col items-center justify-center min-h-64 text-center px-8 py-12">
        {noHayNada ? (
          <>
            <Users aria-hidden="true" className="w-12 h-12 text-muted-foreground/30 mb-3" />
            <p className="text-base font-bold text-foreground">{t('map.emptyTitle')}</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-xs">{t('map.emptyBody')}</p>
            <button
              onClick={onCreate}
              className="mt-5 inline-flex items-center gap-2 min-h-[44px] px-5 rounded-xl bg-primary text-primary-foreground text-sm font-bold"
            >
              <Plus aria-hidden="true" className="w-4 h-4" />
              {t('map.emptyCta')}
            </button>
          </>
        ) : (
          <>
            <SearchX aria-hidden="true" className="w-12 h-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm font-medium text-muted-foreground max-w-xs">{t('map.noEventsFilter')}</p>
            <button
              onClick={onClearFilters}
              className="mt-4 inline-flex items-center min-h-[44px] px-5 rounded-xl bg-muted text-foreground text-sm font-semibold"
            >
              {t('map.clearFilters')}
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div ref={listScope} className="pb-6">
      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`day-${group.key}`} className="mb-5">
          <h2 id={`day-${group.key}`} className="text-sm font-bold text-foreground mb-2 px-1">
            {groupLabel(group.key)}
          </h2>
          <div className="space-y-3">
            {group.items.map((event) => {
              const cat = EVENT_CATEGORIES.find((c) => c.key === event.category);
              const spotsLeft = event.max_spots - event.current_spots;
              const Icon = cat ? CATEGORY_ICONS[cat.key] : null;
              const soon = startsSoon(event, now);

              return (
                <button
                  key={event.id}
                  data-reveal
                  onClick={() => onSelect(event)}
                  className="w-full bg-card rounded-2xl shadow-soft overflow-hidden text-left active:scale-[0.98] transition-transform"
                >
                  {/* Category color bar */}
                  <div className="h-1.5 w-full" style={{ background: cat?.color ?? 'hsl(var(--muted))' }} />

                  <div className="p-4">
                    {/* Category chip */}
                    <div
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold text-white mb-2"
                      style={{ background: cat?.color ?? 'hsl(var(--muted))' }}
                    >
                      {Icon && <Icon className="w-3 h-3" />}
                      <span>{cat ? t('categories.' + cat.key) : event.category}</span>
                    </div>

                    <h3 className="font-bold text-foreground text-base leading-tight mb-2">{event.title}</h3>

                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                        <span>{format(new Date(event.starts_at), 'EEE d MMM · HH:mm', { locale: dateLocale })}</span>
                        {soon && (
                          <span className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary font-bold">
                            {soon.kind === 'live' && (
                              <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                            )}
                            {soon.kind === 'live'
                              ? t('map.filters.live')
                              : t('map.filters.startsIn', {
                                  count: soon.minutes,
                                })}
                          </span>
                        )}
                      </div>

                      {event.address && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                          <span className="truncate">{event.address}</span>
                        </div>
                      )}

                      <div className="flex items-center justify-between mt-2">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Users className="w-3.5 h-3.5" />
                          <span>
                            {spotsLeft <= 0
                              ? t('event.full')
                              : spotsLeft === 1
                              ? t('event.spotLeftOne')
                              : t('event.spotLeftOther', { count: spotsLeft })}
                          </span>
                        </div>
                        {/* "Casi lleno" no puede ser solo el color: quien no
                      distingue verde de ámbar veía el mismo 3/10 en los dos
                      casos. La llama lo dice con una forma y el sr-only con
                      una palabra, para el lector de pantalla. */}
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full',
                            spotsLeft <= 0
                              ? 'bg-destructive/10 text-destructive'
                              : spotsLeft <= 3
                              ? 'bg-warning/10 text-warning'
                              : 'bg-success/10 text-success'
                          )}
                        >
                          {spotsLeft <= 0 ? (
                            t('event.full')
                          ) : (
                            <>
                              {spotsLeft <= 3 && (
                                <>
                                  <Flame className="w-3 h-3" aria-hidden="true" />
                                  <span className="sr-only">{t('event.almostFull')}</span>
                                </>
                              )}
                              {`${event.current_spots}/${event.max_spots}`}
                            </>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
