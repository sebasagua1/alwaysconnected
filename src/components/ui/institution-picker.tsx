import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BadgeCheck, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import { groupByCountry, matchesQuery, type CampusOption } from '@/lib/institutions';
import { cn } from '@/lib/utils';

interface Props {
  value: string | null;
  onChange: (institutionId: string) => void;
}

/**
 * Selector de universidad y campus del alta.
 *
 * Mismo aspecto que OriginPicker (buscador arriba, botones con borde), con los
 * campus agrupados por país. Las opciones vienen de `campus_options`, que ya
 * filtra por el correo: quien entra con @tec.mx solo ve los campus del Tec.
 */
export function InstitutionPicker({ value, onChange }: Props) {
  const { t, i18n } = useTranslation();
  const [options, setOptions] = useState<CampusOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setFailed(false);
    setOptions(null);
    const { data, error } = await supabase.rpc('campus_options');
    if (error) {
      setFailed(true);
      return;
    }
    setOptions(data ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const locale = i18n.language || 'es';
  const groups = useMemo(
    () => groupByCountry((options ?? []).filter((o) => matchesQuery(o, query)), locale),
    [options, query, locale],
  );

  // Todas las opciones de una misma universidad acreditada por el correo:
  // se le dice por qué no ve las demás.
  const verifiedUniversity =
    options && options.length > 0 && options.every((o) => o.email_verified)
      ? options[0].university_name
      : null;

  if (failed) {
    return (
      <div role="alert" className="rounded-xl border-2 border-border bg-card p-4 text-center space-y-3">
        <p className="text-sm text-muted-foreground">{t('onboarding.campusLoadError')}</p>
        <Button variant="outline" className="rounded-xl" onClick={load}>
          {t('onboarding.campusRetry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {verifiedUniversity && (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <BadgeCheck className="w-4 h-4 mt-0.5 shrink-0 text-primary" aria-hidden="true" />
          {t('onboarding.campusVerifiedHint', { university: verifiedUniversity })}
        </p>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('onboarding.campusSearch')}
          aria-label={t('onboarding.campusSearch')}
          className="h-12 rounded-xl text-base pl-10"
          disabled={options === null}
        />
      </div>

      <div className="space-y-4 max-h-[340px] overflow-y-auto" aria-busy={options === null}>
        {options === null ? (
          [1, 2, 3].map((i) => <Skeleton key={i} className="h-[68px] w-full rounded-xl" />)
        ) : groups.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-4">{t('onboarding.campusEmpty')}</p>
        ) : (
          groups.map((group) => (
            <section key={group.code} aria-label={group.label} className="space-y-2">
              <h3 className="text-[13px] font-bold text-muted-foreground px-1">{group.label}</h3>
              {group.options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => onChange(o.id)}
                  aria-pressed={value === o.id}
                  // El nombre completo para el lector de pantalla; a la vista,
                  // el campus arriba y la universidad debajo, para no repetir
                  // "Tecnológico de Monterrey" en cuatro botones seguidos.
                  aria-label={o.name}
                  className={cn(
                    'w-full p-3.5 rounded-xl text-left transition-all border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    value === o.id
                      ? 'border-primary bg-primary/5 text-foreground'
                      : 'border-border bg-card text-foreground/80'
                  )}
                >
                  <span className="block font-semibold">
                    {o.campus_name ? t('onboarding.campusLabel', { campus: o.campus_name }) : o.university_name}
                  </span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    {[o.campus_name ? o.university_name : o.short_name, o.city].filter(Boolean).join(' · ')}
                  </span>
                </button>
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  );
}
