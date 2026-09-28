import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, addDays, isSameDay, startOfDay } from 'date-fns';
import { es as esLocale, enUS } from 'date-fns/locale';
import { Button } from '@/components/ui/button';
import { WheelColumn, WHEEL_ITEM_HEIGHT } from '@/components/ui/wheel-column';
import { meridiemLabels, uses24h } from '@/lib/datetime';
import { useSheetDrag } from '@/hooks/useSheetDrag';

const ITEM_H = WHEEL_ITEM_HEIGHT;
const DAYS_AHEAD = 365;

interface Props {
  value: Date | null;
  /** Días anteriores a este no se ofrecen. */
  minDate?: Date;
  title: string;
  onCancel: () => void;
  onConfirm: (value: Date) => void;
}

export function DateTimeWheel({ value, minDate, title, onCancel, onConfirm }: Props) {
  const { t, i18n } = useTranslation();
  const { sheetRef, handleProps } = useSheetDrag<HTMLDivElement>({ onClose: onCancel });
  const locale = i18n.language?.startsWith('en') ? enUS : esLocale;

  // Con `value` a null esto sería un Date nuevo en cada render, y arrastraría
  // a recalcular la lista de 365 días detrás.
  const base = useMemo(() => value ?? new Date(), [value]);

  // El rango arranca en el más antiguo entre el mínimo y el valor actual: al
  // editar un evento pasado, su propia fecha tiene que seguir estando.
  const firstDay = useMemo(() => {
    const floor = startOfDay(minDate ?? new Date());
    const current = startOfDay(base);
    return current < floor ? current : floor;
  }, [minDate, base]);

  const days = useMemo(
    () => Array.from({ length: DAYS_AHEAD }, (_, i) => addDays(firstDay, i)),
    [firstDay]
  );

  const dayLabels = useMemo(
    () =>
      days.map((d) => {
        const today = new Date();
        if (isSameDay(d, today)) return t('when.today');
        if (isSameDay(d, addDays(today, 1))) return t('when.tomorrow');
        return format(d, 'EEE d MMM', { locale });
      }),
    [days, locale, t]
  );

  // 24 h o 12 h según la región, como el reloj del teléfono: «AM/PM» en una
  // pantalla en español no lo escribe nadie en México ni en Colombia.
  const lang = i18n.language ?? 'es';
  const is24h = useMemo(() => uses24h(lang), [lang]);
  const hours = useMemo(
    () => (is24h
      ? Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, '0'))
      : Array.from({ length: 12 }, (_, i) => `${i + 1}`)),
    [is24h],
  );
  const minutes = useMemo(
    () => Array.from({ length: 12 }, (_, i) => (i * 5).toString().padStart(2, '0')),
    []
  );
  const meridiems = useMemo(() => meridiemLabels(lang), [lang]);

  const [dayIdx, setDayIdx] = useState(() =>
    Math.max(0, days.findIndex((d) => isSameDay(d, base)))
  );
  const [hourIdx, setHourIdx] = useState(() => {
    if (is24h) return base.getHours();
    const h = base.getHours() % 12;
    return h === 0 ? 11 : h - 1;
  });
  const [minIdx, setMinIdx] = useState(() => Math.round(base.getMinutes() / 5) % 12);
  const [merIdx, setMerIdx] = useState(() => (base.getHours() >= 12 ? 1 : 0));

  const handleConfirm = () => {
    const d = new Date(days[dayIdx]);
    const picked = parseInt(hours[hourIdx], 10);
    const hour24 = is24h
      ? picked
      : merIdx === 1 ? (picked === 12 ? 12 : picked + 12) : picked === 12 ? 0 : picked;
    d.setHours(hour24, parseInt(minutes[minIdx], 10), 0, 0);
    onConfirm(d);
  };

  return (
    // stopPropagation: esta rueda se abre DENTRO de las hojas de crear y
    // editar, y el toque fuera de ella subía hasta el fondo de la hoja, que
    // lo tomaba como «cerrar el formulario» y tiraba todo lo escrito.
    <div className="fixed inset-0 z-[80] bg-scrim animate-fade-in" onClick={(e) => { e.stopPropagation(); onCancel(); }}>
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="absolute bottom-0 left-0 right-0 mx-auto sm:max-w-[430px] bg-card rounded-t-3xl shadow-lifted animate-slide-up safe-bottom"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Se baja con el dedo desde aquí; las columnas giran con su propio scroll. */}
        <div {...handleProps}>
          <div className="drag-handle" />
          <div className="px-5 pt-1 pb-3 text-center">
            <h2 className="text-base font-extrabold text-foreground">{title}</h2>
          </div>
        </div>

        <div className="relative px-4">
          {/* Banda de selección, como la de iOS. */}
          <div
            className="pointer-events-none absolute left-4 right-4 top-1/2 -translate-y-1/2 rounded-xl bg-muted"
            style={{ height: ITEM_H }}
            aria-hidden
          />
          <div className="relative flex gap-1">
            <WheelColumn items={dayLabels} index={dayIdx} onIndexChange={setDayIdx} label={t('when.date')} className="flex-[2]" />
            <WheelColumn items={hours} index={hourIdx} onIndexChange={setHourIdx} label={t('when.hour')} className="flex-1" />
            <WheelColumn items={minutes} index={minIdx} onIndexChange={setMinIdx} label={t('when.minute')} className="flex-1" />
            {!is24h && (
              <WheelColumn items={meridiems} index={merIdx} onIndexChange={setMerIdx} label={t('when.meridiem')} className="flex-1" />
            )}
          </div>
        </div>

        <div className="flex gap-3 px-5 pt-3 pb-5">
          <Button variant="outline" onClick={onCancel} className="h-12 rounded-xl px-6">
            {t('common.cancel')}
          </Button>
          <Button onClick={handleConfirm} className="flex-1 h-12 rounded-xl font-bold">
            {t('when.done')}
          </Button>
        </div>
      </div>
    </div>
  );
}
