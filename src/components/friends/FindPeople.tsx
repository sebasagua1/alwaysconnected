import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X, UserPlus, Check, Clock, MessageCircle, SearchX } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { UserAvatar } from '@/components/ui/user-avatar';
import { UserProfileSheet } from '@/components/profile/UserProfileSheet';
import { ModerationMenu } from '@/components/moderation/ModerationMenu';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks/use-toast';
import { usePeopleSearch, type Relation } from '@/hooks/usePeopleSearch';
import { useFriendActions } from '@/hooks/useFriendActions';
import { rpcMessage } from '@/lib/rpcErrors';
import { cn } from '@/lib/utils';

/** Una persona tal como la pinta la lista, venga de la búsqueda o de las sugerencias. */
export type Person = {
  id: string;
  name: string;
  avatar_url: string | null;
  major: string | null;
  relation: Relation;
  friendship_id: string | null;
  mutual_friends: number;
  shared_groups?: number;
  /** Está en tus contactos (solo en sugerencias, tras buscar contactos). */
  in_contacts?: boolean;
};

interface Props {
  /** Lo que se ve cuando no se está buscando: solicitudes y lista de amigos. */
  children: ReactNode;
  /** Aceptar a alguien cambia la lista de amigos y las solicitudes. */
  onFriendsChanged: () => void;
  onMessage: (person: { id: string; name: string | null; avatar_url: string | null; major: string | null }) => void;
}

const SUGGESTIONS_LIMIT = 10;

/**
 * Buscar y agregar personas desde la pestaña de amigos.
 *
 * Al tocar el buscador, la pestaña pasa a modo búsqueda: con el campo vacío,
 * sugerencias; al escribir, resultados al momento. "Cancelar" vuelve a la
 * lista de amigos. Así los resultados no empujan la lista de chats hacia
 * abajo, y la lista de chats no compite con los resultados.
 */
export function FindPeople({ children, onFriendsChanged, onMessage }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuthStore();

  const [active, setActive] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const search = usePeopleSearch(active ? query : '');

  const [suggestions, setSuggestions] = useState<Person[] | null>(null);
  const [suggestionsFailed, setSuggestionsFailed] = useState(false);

  // Agregar, aceptar y cancelar, con lo que ha cambiado desde que llegó la
  // lista guardado por id: así un cambio se ve igual en la búsqueda, en las
  // sugerencias y en la ficha, sin volver a pedir nada.
  const friendActions = useFriendActions(onFriendsChanged);
  const { busy, add, accept, cancelRequest } = friendActions;
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<Person | null>(null);
  const [cancelling, setCancelling] = useState<Person | null>(null);

  const loadSuggestions = useCallback(async () => {
    setSuggestionsFailed(false);
    const { data, error } = await supabase.rpc('people_suggestions', { _limit: SUGGESTIONS_LIMIT });
    if (error) {
      setSuggestionsFailed(true);
      return;
    }
    setSuggestions(
      (data ?? []).map((s) => ({ ...s, relation: 'none' as const, friendship_id: null })),
    );
  }, []);

  useEffect(() => {
    if (active && suggestions === null) loadSuggestions();
  }, [active, suggestions, loadSuggestions]);

  const withOverride = (p: Person): Person => friendActions.withOverride(p);

  const close = () => {
    setActive(false);
    setQuery('');
    friendActions.reset();
    // Las sugerencias se piden de nuevo la próxima vez: quien acabas de
    // agregar ya no debe salir.
    setSuggestions(null);
    inputRef.current?.blur();
  };

  const actionFor = (p: Person, variant: 'row' | 'sheet') => {
    const name = p.name;
    // En la fila, solo texto y compacto: con icono y 96px el nombre se
    // quedaba en tres letras en un iPhone. En la ficha hay sitio para todo.
    const row = variant === 'row';
    const base = row
      ? 'h-11 shrink-0 rounded-full px-3.5 text-[13px] font-semibold'
      : 'w-full rounded-xl';
    const icon = (Icon: typeof Check) => (row ? null : <Icon className="w-4 h-4" />);
    switch (p.relation) {
      case 'friends':
        return (
          <Button variant="outline" className={base} onClick={() => { setViewing(null); onMessage(p); }} aria-label={t('friends.messageAria', { name })}>
            {icon(MessageCircle)}
            {t('friends.sendMessage')}
          </Button>
        );
      case 'incoming':
        return (
          <Button className={base} disabled={busy[p.id]} onClick={() => accept(p)} aria-label={t('friends.acceptAria', { name })}>
            {icon(Check)}
            {t('friends.accept')}
          </Button>
        );
      case 'outgoing':
        return (
          <Button
            variant="ghost"
            // Neutro: es un estado, no una invitación a pulsar.
            className={cn(base, 'bg-muted text-muted-foreground hover:bg-muted/80')}
            // Sin id todavía (la inserción va en camino) no hay nada que cancelar.
            disabled={busy[p.id] || !p.friendship_id}
            onClick={() => setCancelling(p)}
            aria-label={t('friends.sentAria', { name })}
          >
            {icon(Clock)}
            {t('friends.sent')}
          </Button>
        );
      default:
        return (
          <Button className={base} disabled={busy[p.id]} onClick={() => add(p)} aria-label={t('friends.addAria', { name })}>
            {icon(UserPlus)}
            {t('friends.addFriend')}
          </Button>
        );
    }
  };

  /** Solo lo que ya es público o lo sabes tú: nunca quiénes son los amigos en común. */
  const subtitleOf = (p: Person) => {
    const parts: string[] = [];
    // Primero lo que explica por qué sale; la carrera, si cabe. Al revés, una
    // carrera larga cortaba justo el "3 amigos en común".
    if (p.in_contacts) parts.push(t('findFriends.inYourContacts'));
    else if (p.mutual_friends > 0) parts.push(t('friends.mutualFriends', { count: p.mutual_friends }));
    else if (p.shared_groups && p.shared_groups > 0) parts.push(t('friends.sharedGroups', { count: p.shared_groups }));
    if (p.major) parts.push(p.major);
    return parts.join(' · ');
  };

  const renderRow = (raw: Person) => {
    if (hidden.has(raw.id)) return null;
    const p = withOverride(raw);
    return (
      <li key={p.id} className="flex items-center gap-2 bg-card rounded-xl p-3 shadow-soft">
        <button
          type="button"
          onClick={() => setViewing(p)}
          aria-label={t('friends.viewProfile', { name: p.name })}
          className="flex items-center gap-3 flex-1 min-w-0 text-left rounded-lg transition-opacity active:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <UserAvatar url={p.avatar_url} name={p.name} className="w-11 h-11 bg-primary/10" textClassName="text-sm text-primary" />
          <div className="min-w-0">
            <p className="font-semibold text-sm text-foreground truncate">{p.name}</p>
            <p className="text-xs text-muted-foreground truncate">{subtitleOf(p) || t('friends.sameCampus')}</p>
          </div>
        </button>
        {actionFor(p, 'row')}
        <ModerationMenu
          target={{ kind: 'user', id: p.id }}
          label={p.name}
          blockUserId={p.id}
          onBlocked={() => setHidden((prev) => new Set(prev).add(p.id))}
        />
      </li>
    );
  };

  const skeletons = (count: number) =>
    Array.from({ length: count }, (_, i) => (
      <li key={i} className="flex items-center gap-3 bg-card rounded-xl p-3 shadow-soft" aria-hidden="true">
        <Skeleton className="w-11 h-11 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </div>
        <Skeleton className="h-11 w-24 rounded-full" />
      </li>
    ));

  const { term, results, status } = search;
  const showingResults = term.length > 0;
  const visibleResults = results.filter((r) => !hidden.has(r.id));

  return (
    <div className="space-y-4">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          // Enter no hace falta, pero si se pulsa, busca ya y cierra el teclado.
          search.retry();
          inputRef.current?.blur();
        }}
        className="flex items-center gap-2"
      >
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" aria-hidden="true" />
          <Input
            ref={inputRef}
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="words"
            spellCheck={false}
            maxLength={100}
            placeholder={t('friends.searchPh')}
            aria-label={t('friends.searchLabel')}
            value={query}
            onFocus={() => setActive(true)}
            onChange={(e) => { setActive(true); setQuery(e.target.value); }}
            className="pl-9 pr-10 h-11 rounded-xl [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); inputRef.current?.focus(); }}
              aria-label={t('common.clearSearch')}
              className="absolute right-0 top-0 w-11 h-11 inline-flex items-center justify-center text-muted-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        {active && (
          <button type="button" onClick={close} className="min-h-[44px] px-1 text-sm font-semibold text-primary shrink-0">
            {t('common.cancel')}
          </button>
        )}
      </form>

      {!active ? (
        children
      ) : (
        // Altura mínima: que la pantalla no dé saltos mientras llegan resultados.
        <div className="min-h-[60vh]">
          <p className="sr-only" aria-live="polite">
            {showingResults && status === 'ready'
              ? t('friends.resultsCount', { count: visibleResults.length })
              : ''}
          </p>

          {showingResults ? (
            <section aria-label={t('friends.results')} aria-busy={status === 'loading'} className="space-y-2">
              {status === 'error' ? (
                <div role="alert" className="rounded-xl bg-card shadow-soft p-4 text-center space-y-3">
                  <p className="text-sm text-muted-foreground">{t('friends.searchError')}</p>
                  <Button variant="outline" className="rounded-xl" onClick={search.retry}>
                    {t('friends.retry')}
                  </Button>
                </div>
              ) : status === 'loading' && results.length === 0 ? (
                <ul className="space-y-2">{skeletons(3)}</ul>
              ) : status === 'ready' && visibleResults.length === 0 ? (
                <div className="text-center py-10 px-4">
                  <SearchX className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" aria-hidden="true" />
                  <p className="text-sm text-muted-foreground">{t('friends.noResults', { query: term })}</p>
                </div>
              ) : (
                <>
                  <ul className={cn('space-y-2 transition-opacity', status === 'loading' && 'opacity-60')}>
                    {results.map((r) => renderRow({ ...r, shared_groups: 0 }))}
                  </ul>
                  {search.hasMore && status === 'ready' && (
                    <button
                      type="button"
                      onClick={search.loadMore}
                      disabled={search.loadingMore}
                      className="w-full min-h-[44px] text-sm font-semibold text-primary disabled:opacity-50"
                    >
                      {search.loadingMore ? t('common.loading') : t('common.loadMore')}
                    </button>
                  )}
                </>
              )}
            </section>
          ) : (
            <section aria-labelledby="people-suggestions-title" className="space-y-2">
              <h2 id="people-suggestions-title" className="text-sm font-semibold text-muted-foreground">
                {t('friends.suggestionsTitle')}
              </h2>
              {suggestionsFailed ? (
                <div role="alert" className="rounded-xl bg-card shadow-soft p-4 text-center space-y-3">
                  <p className="text-sm text-muted-foreground">{t('friends.suggestionsError')}</p>
                  <Button variant="outline" className="rounded-xl" onClick={loadSuggestions}>
                    {t('friends.retry')}
                  </Button>
                </div>
              ) : suggestions === null ? (
                <ul className="space-y-2">{skeletons(3)}</ul>
              ) : suggestions.filter((s) => !hidden.has(s.id)).length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8 px-4">{t('friends.suggestionsEmpty')}</p>
              ) : (
                <ul className="space-y-2">{suggestions.map(renderRow)}</ul>
              )}
            </section>
          )}
        </div>
      )}

      {viewing && (
        <UserProfileSheet
          userId={viewing.id}
          onClose={() => setViewing(null)}
          footer={actionFor(withOverride(viewing), 'sheet')}
        />
      )}

      <AlertDialog open={cancelling !== null} onOpenChange={(open) => !open && setCancelling(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('friends.cancelRequestTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('friends.cancelRequestDesc', { name: cancelling?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('friends.keepRequest')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (cancelling) cancelRequest(withOverride(cancelling));
                setCancelling(null);
              }}
            >
              {t('friends.cancelRequest')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
