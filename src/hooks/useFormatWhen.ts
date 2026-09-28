import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { formatEventWhen } from '@/lib/datetime';

/** formatEventWhen con los textos del idioma activo. */
export function useFormatWhen() {
  const { t, i18n } = useTranslation();
  return useCallback(
    (startIso: string, endIso: string | null, opts?: { range?: boolean; now?: Date }) =>
      formatEventWhen(
        startIso,
        endIso,
        i18n.language ?? 'es',
        {
          now: t('when.now'),
          today: t('when.today'),
          tomorrow: t('when.tomorrow'),
          until: (time) => t('when.until', { time }),
        },
        opts,
      ),
    [t, i18n.language],
  );
}
