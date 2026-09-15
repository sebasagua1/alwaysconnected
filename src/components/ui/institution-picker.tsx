import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BadgeCheck, Search, X, Plus } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import {
  CATALOG_COUNTRIES,
  countryLabel,
  describeInstitution,
  type InstitutionResult,
} from '@/lib/institutions';
import { RequestInstitutionDialog } from '@/components/ui/request-institution-dialog';
import { cn } from '@/lib/utils';

interface Props {
  value: string | null;
  onChange: (campusId: string, result: InstitutionResult) => void;
}

export const INSTITUTION_SEARCH_DEBOUNCE_MS = 200;
const PAGE = 20;

type Status = 'loading' | 'ready' | 'error';

/**
 * Buscador de institución y campus.
 *
 * Busca en el servidor mientras se escribe (sin botón): nombre, abreviatura,
 * alias, ciudad, sin acentos. Con el campo vacío muestra las más usadas. Una
 * fila por campus, con ciudad, país y tipo para no confundir nombres parecidos.
 * Nunca elige nada solo: la base decide qué opciones hay para cada quien.
 */
export function InstitutionPicker({ value, onChange }: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'es';
  const [query, setQuery] = useState('');
  const [country, setCountry] = useState<string | null>(null);
  const [results, setResults] = useState<InstitutionResult[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [requestOpen, setRequestOpen] = useState(false);
  const seq = useRef(0);

  const fetchPage = useCallback(
    (offset: number, signal: AbortSignal) =>
      supabase
        .rpc('search_institutions', {
          _query: query.trim() || null,
          _country_code: country,
          _limit: PAGE + 1,
          _offset: offset,
        })
        .abortSignal(signal),
    [query, country],
  );

  useEffect(() => {
    const mine = ++seq.current;
    const controller = new AbortController();
    setStatus('loading');
    const timer = setTimeout(async () => {
      const { data, error } = await fetchPage(0, controller.signal);
      if (mine !== seq.current) return;
      if (error) {
        setStatus('error');
        return;
      }
      const rows = data ?? [];
      setResults(rows.slice(0, PAGE));
      setHasMore(rows.length > PAGE);
      setStatus('ready');
    }, query ? INSTITUTION_SEARCH_DEBOUNCE_MS : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [fetchPage, attempt, query]);

  const loadMore = async () => {
    const mine = seq.current;
    setLoadingMore(true);
    const { data, error } = await fetchPage(results.length, new AbortController().signal);
    setLoadingMore(false);
    if (mine !== seq.current || error) return;
    const rows = data ?? [];
    setResults((prev) => [...prev, ...rows.slice(0, PAGE).filter((r) => !prev.some((p) => p.campus_id === r.campus_id))]);
    setHasMore(rows.length > PAGE);
  };

  // Todas las opciones de una misma universidad acreditada por el correo.
  const verifiedUniversity = results.length > 0 && results[0].email_verified ? results[0].university_name : null;

  return (
    <div className="space-y-3">
      {verifiedUniversity && (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <BadgeCheck className="w-4 h-4 mt-0.5 shrink-0 text-primary" aria-hidden="true" />
          {t('onboarding.campusVerifiedHint', { university: verifiedUniversity })}
        </p>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" aria-hidden="true" />
        <Input
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={100}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('onboarding.campusSearch')}
          aria-label={t('onboarding.campusSearch')}
          className="h-12 rounded-xl text-base pl-10 pr-10 [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label={t('common.clearSearch')}
            className="absolute right-0 top-0 w-12 h-12 inline-flex items-center justify-center text-muted-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {!verifiedUniversity && (
        <div className="flex gap-2 overflow-x-auto -mx-1 px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="group" aria-label={t('onboarding.countryFilter')}>
          {[null, ...CATALOG_COUNTRIES].map((c) => (
            <button
              key={c ?? 'all'}
              type="button"
              aria-pressed={country === c}
              onClick={() => setCountry(c)}
              className={cn(
                'shrink-0 min-h-[36px] px-3.5 rounded-full text-sm font-semibold transition-colors',
                country === c ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
              )}
            >
              {c ? countryLabel(c, locale) : t('onboarding.allCountries')}
            </button>
          ))}
        </div>
      )}

      <p className="sr-only" aria-live="polite">
        {status === 'ready' ? t('onboarding.institutionResults', { count: results.length }) : ''}
      </p>

      <div className="space-y-2 max-h-[340px] min-h-[240px] overflow-y-auto" aria-busy={status === 'loading'}>
        {status === 'error' ? (
          <div role="alert" className="rounded-xl border-2 border-border bg-card p-4 text-center space-y-3">
            <p className="text-sm text-muted-foreground">{t('onboarding.campusLoadError')}</p>
            <Button variant="outline" className="rounded-xl" onClick={() => setAttempt((a) => a + 1)}>
              {t('onboarding.campusRetry')}
            </Button>
          </div>
        ) : status === 'loading' && results.length === 0 ? (
          [1, 2, 3].map((i) => <Skeleton key={i} className="h-[68px] w-full rounded-xl" />)
        ) : status === 'ready' && results.length === 0 ? (
          <div className="text-center py-4 space-y-3">
            <p className="text-muted-foreground text-sm">{t('onboarding.campusEmpty')}</p>
          </div>
        ) : (
          <>
            <ul className={cn('space-y-2 transition-opacity', status === 'loading' && 'opacity-60')}>
              {results.map((r) => {
                const { title, subtitle } = describeInstitution(r, t, locale);
                return (
                  <li key={r.campus_id}>
                    <button
                      type="button"
                      onClick={() => onChange(r.campus_id, r)}
                      aria-pressed={value === r.campus_id}
                      aria-label={`${title}. ${subtitle}`}
                      className={cn(
                        'w-full p-3.5 rounded-xl text-left transition-all border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        value === r.campus_id ? 'border-primary bg-primary/5 text-foreground' : 'border-border bg-card text-foreground/80',
                      )}
                    >
                      <span className="block font-semibold">{title}</span>
                      <span className="block text-xs text-muted-foreground mt-0.5">{subtitle}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {hasMore && status === 'ready' && (
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="w-full min-h-[44px] text-sm font-semibold text-primary disabled:opacity-50"
              >
                {loadingMore ? t('common.loading') : t('common.loadMore')}
              </button>
            )}
          </>
        )}
      </div>

      {!verifiedUniversity && (
        <button
          type="button"
          onClick={() => setRequestOpen(true)}
          className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 text-sm font-semibold text-primary"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          {t('institutionRequest.cta')}
        </button>
      )}

      <RequestInstitutionDialog
        open={requestOpen}
        onOpenChange={setRequestOpen}
        initialName={query.trim()}
        initialCountry={country}
      />
    </div>
  );
}
