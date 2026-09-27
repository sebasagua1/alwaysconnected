import { useEffect, useRef, useState } from 'react';
import { X, MapPin, Search, LocateFixed, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { searchPlaces, type PlaceResult } from '@/lib/geocode';

interface Props {
  onConfirm: () => void;
  onCancel: () => void;
  hasPin: boolean;
  /** Pone el pin en un punto elegido de la búsqueda o de «Aquí donde estoy». */
  onPlace: (lng: number, lat: number) => void;
  /** Posición del GPS, si la hay: activa «Aquí donde estoy». */
  userLocation: { lng: number; lat: number } | null;
  /** Hacia dónde sesgar la búsqueda (el campus). */
  proximity: { lng: number; lat: number } | null;
}

/**
 * Elegir dónde es el evento.
 *
 * Antes era una barra arriba con una X y un ✓ de 40 px sin nombre para
 * VoiceOver, y la única forma de marcar el sitio era buscarlo a ojo en el
 * mapa. Ahora:
 *   · arriba, cancelar y un buscador de lugares («Biblioteca», «Cancha 2»);
 *   · abajo, en la zona del pulgar, «Aquí donde estoy» y «Usar esta ubicación».
 * La barra de pestañas se esconde mientras tanto (MapHome), así que un toque
 * perdido no saca del formulario.
 */
export function LocationPickerOverlay({ onConfirm, onCancel, hasPin, onPlace, userLocation, proximity }: Props) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const token = (import.meta.env.VITE_MAPBOX_TOKEN as string) ?? '';
  const proximityRef = useRef(proximity);
  proximityRef.current = proximity;

  // Búsqueda con espera corta y cancelando la anterior: cada letra no es una
  // llamada, y una respuesta vieja no pisa a la nueva.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); setSearched(false); return; }
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const lang = i18n.language?.startsWith('en') ? 'en' : 'es';
        const r = await searchPlaces(q, token, lang, proximityRef.current ?? undefined, ctrl.signal);
        setResults(r);
        setSearched(true);
      } catch {
        // Cancelada o sin red: se deja lo que había.
      } finally {
        if (!ctrl.signal.aborted) setSearching(false);
      }
    }, 280);
    return () => { ctrl.abort(); window.clearTimeout(timer); };
  }, [query, token, i18n.language]);

  const choose = (r: PlaceResult) => {
    onPlace(r.lng, r.lat);
    setQuery('');
    setResults([]);
    setSearched(false);
  };

  return (
    <>
      <div className="absolute inset-x-0 top-0 z-20 px-4 pt-[calc(0.75rem+env(safe-area-inset-top,0px))] pointer-events-none">
        <div className="pointer-events-auto mx-auto sm:max-w-[430px] bg-card/95 backdrop-blur-md rounded-2xl shadow-lifted p-2 space-y-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onCancel}
              aria-label={t('create.locationCancel')}
              className="w-11 h-11 shrink-0 rounded-full flex items-center justify-center text-foreground active:bg-muted"
            >
              <X aria-hidden="true" className="w-5 h-5" />
            </button>
            <h2 className="flex-1 min-w-0 text-base font-bold text-foreground truncate">{t('create.locationQuestion')}</h2>
          </div>

          <div className="relative">
            <Search aria-hidden="true" className="absolute z-10 left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input
              type="search"
              inputMode="search"
              enterKeyHint="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('create.locationSearchPh')}
              aria-label={t('create.locationSearchPh')}
              // 16 px: por debajo iOS hace zoom al enfocar y el mapa se queda
              // enganchado en ese zoom.
              className="w-full h-11 pl-9 pr-9 rounded-xl bg-muted text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            {searching && (
              <Loader2 aria-hidden="true" className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />
            )}
          </div>

          {results.length > 0 ? (
            <ul className="max-h-[40dvh] overflow-y-auto overscroll-contain" aria-label={t('create.locationResults')}>
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => choose(r)}
                    className="w-full flex items-start gap-3 text-left rounded-xl px-3 py-2.5 min-h-[44px] active:bg-muted"
                  >
                    <MapPin aria-hidden="true" className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-foreground truncate">{r.name}</span>
                      {r.detail && <span className="block text-xs text-muted-foreground truncate">{r.detail}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2 pb-1 flex items-center gap-1.5 text-sm text-muted-foreground" aria-live="polite">
              <MapPin aria-hidden="true" className="w-4 h-4 shrink-0" />
              {searched && !searching
                ? t('create.locationNoResults')
                : hasPin ? t('create.locationConfirmed') : t('create.locationHint')}
            </p>
          )}
        </div>
      </div>

      {/* Abajo, donde llega el pulgar: antes el ✓ estaba arriba a la derecha. */}
      <div className="absolute inset-x-0 bottom-0 z-20 px-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] pointer-events-none">
        <div className="pointer-events-auto mx-auto sm:max-w-[430px] flex gap-3">
          {userLocation && (
            <Button
              type="button"
              variant="outline"
              onClick={() => onPlace(userLocation.lng, userLocation.lat)}
              className="h-12 rounded-xl px-4 gap-2 bg-card shadow-lifted"
            >
              <LocateFixed aria-hidden="true" className="w-4 h-4" />
              {t('create.locationHere')}
            </Button>
          )}
          <Button
            type="button"
            onClick={onConfirm}
            disabled={!hasPin}
            className="flex-1 h-12 rounded-xl font-bold shadow-lifted"
          >
            {t('create.locationUse')}
          </Button>
        </div>
      </div>
    </>
  );
}
