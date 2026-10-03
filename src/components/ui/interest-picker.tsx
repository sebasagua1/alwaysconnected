import { useTranslation } from 'react-i18next';
import { INTEREST_GROUPS } from '@/lib/constants';
import { cn } from '@/lib/utils';

interface Props {
  selected: string[];
  onToggle: (item: string) => void;
}

/**
 * Intereses por categorías. Sueltos serían más de cincuenta chips seguidos y
 * nadie los lee; agrupados se ojean por bloques.
 */
export function InterestPicker({ selected, onToggle }: Props) {
  const { t } = useTranslation();

  return (
    <div className="space-y-5">
      {INTEREST_GROUPS.map((group) => (
        <div key={group.key}>
          <h3 className="text-[0.8125rem] font-bold text-muted-foreground mb-2">
            {t('interestGroups.' + group.key)}
          </h3>
          <div className="flex flex-wrap gap-2">
            {group.items.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => onToggle(item)}
                aria-pressed={selected.includes(item)}
                className={cn(
                  'inline-flex items-center justify-center min-h-[44px] px-4 rounded-full text-sm font-semibold transition-all active:scale-95',
                  selected.includes(item)
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {t('interests.' + item)}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
