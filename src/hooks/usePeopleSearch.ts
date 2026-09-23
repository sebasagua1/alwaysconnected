import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';

export type PersonResult = Database['public']['Functions']['search_people']['Returns'][number];
export type Relation = PersonResult['relation'];

/** Lo bastante corto para sentirse instantáneo; lo bastante largo para no pedir por letra. */
export const SEARCH_DEBOUNCE_MS = 300;
export const SEARCH_PAGE_SIZE = 20;

export type SearchStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Búsqueda de personas según se escribe.
 *
 * Tres cosas evitan que los resultados salten o se desordenen:
 *   - el debounce agrupa las pulsaciones;
 *   - cada consulta nueva aborta la anterior en la red;
 *   - y, por si una respuesta ya venía de camino, un número de secuencia
 *     descarta todo lo que no sea de la última consulta.
 *
 * Mientras llega la respuesta se conservan los resultados anteriores
 * (`status = 'loading'` con `results` llenos), para que la lista no se vacíe
 * y se vuelva a llenar en cada letra.
 */
export function usePeopleSearch(query: string) {
  const [results, setResults] = useState<PersonResult[]>([]);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Se incrementa para relanzar la misma búsqueda (Reintentar, Enter).
  const [attempt, setAttempt] = useState(0);

  const seqRef = useRef(0);
  // Reintentar y Enter no esperan al debounce; escribir sí.
  const immediateRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const term = query.trim();

  const fetchPage = useCallback(async (q: string, offset: number, signal: AbortSignal) => {
    // Uno de más para saber si hay otra página sin pedir un recuento.
    return supabase
      .rpc('search_people', { _query: q, _limit: SEARCH_PAGE_SIZE + 1, _offset: offset })
      .abortSignal(signal);
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    const seq = ++seqRef.current;

    if (!term) {
      setResults([]);
      setHasMore(false);
      setStatus('idle');
      return;
    }

    setStatus('loading');
    const delay = immediateRef.current ? 0 : SEARCH_DEBOUNCE_MS;
    immediateRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;

    const timer = setTimeout(async () => {
      const { data, error } = await fetchPage(term, 0, controller.signal);
      if (seq !== seqRef.current) return;
      if (error) {
        setStatus('error');
        return;
      }
      const rows = data ?? [];
      setResults(rows.slice(0, SEARCH_PAGE_SIZE));
      setHasMore(rows.length > SEARCH_PAGE_SIZE);
      setStatus('ready');
    }, delay);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term, attempt, fetchPage]);

  const loadMore = useCallback(async () => {
    if (!term || loadingMore || !hasMore) return;
    const seq = seqRef.current;
    setLoadingMore(true);
    const controller = new AbortController();
    const { data, error } = await fetchPage(term, results.length, controller.signal);
    setLoadingMore(false);
    if (seq !== seqRef.current) return;
    if (error) {
      setStatus('error');
      return;
    }
    const rows = data ?? [];
    setResults((prev) => {
      const vistos = new Set(prev.map((r) => r.id));
      return [...prev, ...rows.slice(0, SEARCH_PAGE_SIZE).filter((r) => !vistos.has(r.id))];
    });
    setHasMore(rows.length > SEARCH_PAGE_SIZE);
  }, [term, loadingMore, hasMore, results.length, fetchPage]);

  /** Busca ya, sin esperar al debounce: para Enter y para Reintentar. */
  const retry = useCallback(() => {
    immediateRef.current = true;
    setAttempt((a) => a + 1);
  }, []);

  return { term, results, status, hasMore, loadingMore, loadMore, retry };
}
