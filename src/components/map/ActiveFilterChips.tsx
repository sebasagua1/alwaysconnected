import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { format } from 'date-fns';
import { es as esLocale, enUS } from 'date-fns/locale';
import { useEventStore } from '@/stores/eventStore';
import { fromDateKey, whenInterval, type AdvancedFilters } from '@/lib/eventFilter';

interface Props {
  /** Tocar el texto de un filtro reabre la hoja para ajustarlo. */
  onOpen: () => void;
}

/**
 * Los filtros activos, a la vista y cada uno con su X.
 *
 * Sin esta fila, un filtro de "Mañana" olvidado dejaba el mapa medio vacío y
 * nada en pantalla explicaba por qué.
 */
export function ActiveFilterChips({ onOpen }: Props) {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language?.startsWith('en') ? enUS : esLocale;
  const filters = useEventStore((s) => s.advancedFilters);
  const setFilters = useEventStore((s) => s.setAdvancedFilters);

  const chips: Array<{ key: string; label: string; clear: Partial<AdvancedFilters> }> = [];

  if (filters.when !== 'any' && whenInterval(filters, new Date())) {
    let label = t(`map.filters.whenOptions.${filters.when}`);
    if (filters.when === 'range' && filters.rangeFrom) {
      const from = fromDateKey(filters.rangeFrom);
      const to = filters.rangeTo ? fromDateKey(filters.rangeTo) : null;
      if (from) {
        label = to && to.getTime() !== from.getTime()
          ? t('map.filters.rangeMany', { from: format(from, 'd MMM', { locale: dateLocale }), to: format(to, 'd MMM', { locale: dateLocale }) })
          : t('map.filters.rangeOne', { from: format(from, 'EEE d MMM', { locale: dateLocale }) });
      }
    }
    chips.push({ key: 'when', label, clear: { when: 'any', rangeFrom: null, rangeTo: null } });
  }
  if (filters.dayParts.length) {
    chips.push({ key: 'dayParts', label: filters.dayParts.map((d) => t(`map.filters.dayParts.${d}`)).join(', '), clear: { dayParts: [] } });
  }
  if (filters.durations.length) {
    chips.push({ key: 'durations', label: filters.durations.map((d) => t(`map.filters.durations.${d}`)).join(', '), clear: { durations: [] } });
  }
  if (filters.access) chips.push({ key: 'access', label: t(`map.filters.access.${filters.access}`), clear: { access: null } });
  if (filters.size) chips.push({ key: 'size', label: t(`map.filters.size.${filters.size}`), clear: { size: null } });
  if (filters.onlyWithSpots) chips.push({ key: 'spots', label: t('map.filters.onlyWithSpots'), clear: { onlyWithSpots: false } });

  if (chips.length === 0) return null;

  return (
    <div className="flex gap-2 overflow-x-auto no-scrollbar pt-2 -mb-1">
      {chips.map((c) => (
        <span
          key={c.key}
          className="flex-shrink-0 inline-flex items-center rounded-full bg-primary/10 text-primary border border-primary/30 text-xs font-semibold"
        >
          <button type="button" onClick={onOpen} className="min-h-[36px] pl-3 pr-1 whitespace-nowrap">
            {c.label}
          </button>
          <button
            type="button"
            onClick={() => setFilters(c.clear)}
            aria-label={t('map.filters.removeChip', { label: c.label })}
            className="w-9 h-9 inline-flex items-center justify-center"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </span>
      ))}
    </div>
  );
}
