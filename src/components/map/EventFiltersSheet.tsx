import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { format } from 'date-fns';
import { es as esLocale, enUS } from 'date-fns/locale';
import type { DateRange } from 'react-day-picker';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { useEventStore, type MapEvent } from '@/stores/eventStore';
import {
  DEFAULT_ADVANCED_FILTERS,
  DAY_PARTS,
  DURATION_BUCKETS,
  WHEN_PRESETS,
  filterEvents,
  fromDateKey,
  toDateKey,
  type AccessKind,
  type GroupSize,
} from '@/lib/eventFilter';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  events: MapEvent[];
  searchQuery: string;
}

function Chip({
  active,
  onClick,
  children,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'min-h-[44px] px-4 py-2 rounded-2xl text-sm font-semibold text-left transition-colors border',
        active ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-foreground border-border',
      )}
    >
      <span className="block">{children}</span>
      {hint && (
        <span className={cn('block text-xs font-normal', active ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
          {hint}
        </span>
      )}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-bold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

const toggle = <T,>(list: T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

/**
 * Hoja de filtros: cuándo, hora de inicio, duración y tipo de experiencia.
 *
 * Los cambios se aplican al momento (el mapa y la lista de detrás ya van
 * filtrados) y el botón de abajo dice cuántos eventos quedan, para no tener
 * que cerrar la hoja y volver a abrirla a ver si el filtro dejó algo.
 */
export function EventFiltersSheet({ open, onOpenChange, events, searchQuery }: Props) {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language?.startsWith('en') ? enUS : esLocale;
  const filterCategory = useEventStore((s) => s.filterCategory);
  const filters = useEventStore((s) => s.advancedFilters);
  const setFilters = useEventStore((s) => s.setAdvancedFilters);

  const count = useMemo(
    () => filterEvents(events, { category: filterCategory, query: searchQuery, ...filters }).length,
    [events, filterCategory, searchQuery, filters],
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const range: DateRange | undefined = filters.rangeFrom
    ? { from: fromDateKey(filters.rangeFrom) ?? undefined, to: filters.rangeTo ? fromDateKey(filters.rangeTo) ?? undefined : undefined }
    : undefined;

  const setAccess = (a: AccessKind) => setFilters({ access: filters.access === a ? null : a });
  const setSize = (s: GroupSize) => setFilters({ size: filters.size === s ? null : s });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="rounded-t-3xl p-0 max-h-[88vh] flex flex-col sm:max-w-[520px] sm:mx-auto"
      >
        <SheetHeader className="px-5 pt-5 pb-3 text-left border-b border-border">
          <SheetTitle>{t('map.filters.title')}</SheetTitle>
          <SheetDescription className="sr-only">{t('map.filters.title')}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          <Section title={t('map.filters.when')}>
            <div className="flex flex-wrap gap-2">
              {WHEN_PRESETS.map((p) => (
                <Chip
                  key={p}
                  active={filters.when === p}
                  onClick={() =>
                    setFilters(
                      filters.when === p
                        ? { when: 'any' }
                        : p === 'range'
                          ? { when: 'range' }
                          : { when: p },
                    )
                  }
                >
                  {t(`map.filters.whenOptions.${p}`)}
                </Chip>
              ))}
            </div>
            {(filters.when === 'now' || filters.when === 'next3h') && (
              <p className="text-xs text-muted-foreground">{t(`map.filters.whenHints.${filters.when}`)}</p>
            )}
            {filters.when === 'range' && (
              <div className="rounded-2xl border border-border bg-card">
                <p className="px-4 pt-3 text-xs text-muted-foreground">
                  {range?.from
                    ? range.to && range.to.getTime() !== range.from.getTime()
                      ? t('map.filters.rangeMany', {
                          from: format(range.from, 'EEE d MMM', { locale: dateLocale }),
                          to: format(range.to, 'EEE d MMM', { locale: dateLocale }),
                        })
                      : t('map.filters.rangeOne', { from: format(range.from, 'EEE d MMM', { locale: dateLocale }) })
                    : t('map.filters.rangePick')}
                </p>
                <Calendar
                  mode="range"
                  locale={dateLocale}
                  weekStartsOn={1}
                  selected={range}
                  defaultMonth={range?.from ?? today}
                  disabled={{ before: today }}
                  onSelect={(r) =>
                    setFilters({
                      rangeFrom: r?.from ? toDateKey(r.from) : null,
                      rangeTo: r?.to ? toDateKey(r.to) : null,
                    })
                  }
                  className="mx-auto w-fit"
                />
              </div>
            )}
          </Section>

          <Section title={t('map.filters.dayPart')}>
            <div className="grid grid-cols-3 gap-2">
              {DAY_PARTS.map((d) => (
                <Chip
                  key={d}
                  active={filters.dayParts.includes(d)}
                  onClick={() => setFilters({ dayParts: toggle(filters.dayParts, d) })}
                  hint={t(`map.filters.dayPartHints.${d}`)}
                >
                  {t(`map.filters.dayParts.${d}`)}
                </Chip>
              ))}
            </div>
          </Section>

          <Section title={t('map.filters.duration')}>
            <div className="flex flex-wrap gap-2">
              {DURATION_BUCKETS.map((d) => (
                <Chip
                  key={d}
                  active={filters.durations.includes(d)}
                  onClick={() => setFilters({ durations: toggle(filters.durations, d) })}
                >
                  {t(`map.filters.durations.${d}`)}
                </Chip>
              ))}
            </div>
          </Section>

          <Section title={t('map.filters.experience')}>
            <div className="grid grid-cols-2 gap-2">
              {(['direct', 'approval'] as const).map((a) => (
                <Chip key={a} active={filters.access === a} onClick={() => setAccess(a)}>
                  {t(`map.filters.access.${a}`)}
                </Chip>
              ))}
              {(['small', 'large'] as const).map((s) => (
                <Chip key={s} active={filters.size === s} onClick={() => setSize(s)} hint={t(`map.filters.sizeHints.${s}`)}>
                  {t(`map.filters.size.${s}`)}
                </Chip>
              ))}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={filters.onlyWithSpots}
              onClick={() => setFilters({ onlyWithSpots: !filters.onlyWithSpots })}
              className="w-full min-h-[48px] flex items-center justify-between gap-3 px-4 rounded-2xl border border-border bg-card text-sm font-semibold text-foreground"
            >
              <span>{t('map.filters.onlyWithSpots')}</span>
              <span
                aria-hidden="true"
                className={cn(
                  'w-6 h-6 rounded-md border-2 flex items-center justify-center',
                  filters.onlyWithSpots ? 'bg-primary border-primary text-primary-foreground' : 'border-border',
                )}
              >
                {filters.onlyWithSpots && <Check className="w-4 h-4" />}
              </span>
            </button>
          </Section>
        </div>

        <div className="flex gap-3 px-5 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] border-t border-border bg-background">
          <button
            type="button"
            onClick={() => setFilters(DEFAULT_ADVANCED_FILTERS)}
            className="min-h-[48px] px-4 rounded-xl bg-muted text-foreground text-sm font-semibold"
          >
            {t('map.filters.clear')}
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="flex-1 min-h-[48px] px-4 rounded-xl bg-primary text-primary-foreground text-sm font-bold"
          >
            {count === 0 ? t('map.filters.showNone') : t('map.filters.show', { count })}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
