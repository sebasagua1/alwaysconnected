import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Check } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { MEXICO_STATES, countryList } from '@/lib/origin';
import { cn } from '@/lib/utils';

/**
 * «¿De dónde eres?» en una sola pantalla.
 *
 * Antes eran dos pasos: primero Local / Foráneo / Internacional y luego el
 * estado o el país. La primera pregunta no aportaba nada que la segunda no
 * dijera ya —y «foráneo» fuera de México no se entiende—, así que aquí van
 * juntos: «de aquí» arriba, y debajo estados y países en una sola lista
 * buscable.
 *
 * El valor es el que se guarda en profiles.origin: null para quien es de aquí,
 * nombre del estado, o código ISO del país. `residenceFromOrigin` deriva de ahí
 * el residence_type, que ya no se pregunta aparte.
 *
 * `undefined` es «todavía no ha elegido», que no es lo mismo que `null`
 * («es de aquí»); sin esa distinción no se puede exigir una respuesta.
 */
interface Props {
  value: string | null | undefined;
  onChange: (value: string | null) => void;
}

export function PlacePicker({ value, onChange }: Props) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');

  const lang = i18n.language || 'es';
  const grupos = useMemo(
    () => [
      { key: 'states', items: MEXICO_STATES.map((s) => ({ code: s, name: s })) },
      { key: 'countries', items: countryList(lang) },
    ],
    [lang],
  );

  // Sin acentos y en minúsculas: buscar "mexico" tiene que encontrar "México".
  const norm = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const q = norm(query.trim());

  const visibles = grupos
    .map((g) => ({ ...g, items: q ? g.items.filter((o) => norm(o.name).includes(q)) : g.items }))
    .filter((g) => g.items.length > 0);

  // «De aquí» desaparece al buscar salvo que la búsqueda case con su texto:
  // dejarlo fijo arriba mientras se teclea «Jalisco» es ruido.
  const textoAqui = t('origin.here');
  const mostrarAqui = !q || norm(textoAqui).includes(q);

  const fila = (
    key: string,
    etiqueta: string,
    seleccionada: boolean,
    alPulsar: () => void,
  ) => (
    <button
      key={key}
      type="button"
      onClick={alPulsar}
      aria-pressed={seleccionada}
      className={cn(
        'w-full flex items-center gap-2 p-3.5 rounded-xl text-left font-semibold transition-all border-2',
        seleccionada
          ? 'border-primary bg-primary/5 text-foreground'
          : 'border-border bg-card text-foreground/80',
      )}
    >
      <span className="flex-1">{etiqueta}</span>
      {seleccionada && <Check className="h-4 w-4 shrink-0 text-primary" strokeWidth={3} />}
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('origin.search')}
          className="h-12 rounded-xl text-base pl-10"
        />
      </div>

      <div className="space-y-2 max-h-[340px] overflow-y-auto">
        {mostrarAqui && fila('__local__', textoAqui, value === null, () => onChange(null))}

        {visibles.map((g) => (
          <div key={g.key} className="space-y-2">
            <p className="px-1 pt-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
              {t(g.key === 'states' ? 'origin.statesGroup' : 'origin.countriesGroup')}
            </p>
            {g.items.map((o) => fila(o.code, o.name, value === o.code, () => onChange(o.code)))}
          </div>
        ))}

        {!mostrarAqui && visibles.length === 0 && (
          <p className="text-muted-foreground text-sm text-center py-4">{t('origin.noResults')}</p>
        )}
      </div>
    </div>
  );
}
