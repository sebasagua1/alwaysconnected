import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet-async';
import {
  ArrowLeft, Check, Contact, Loader2, Lock, RotateCw, Search, Settings2, Share2, ShieldCheck, UserPlus, Users, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/user-avatar';
import { UserProfileSheet } from '@/components/profile/UserProfileSheet';
import { ContactsSettingsSheet } from '@/components/friends/ContactsSettingsSheet';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useFriendActions, type FriendRelation } from '@/hooks/useFriendActions';
import { usePeopleSearch } from '@/hooks/usePeopleSearch';
import {
  ContactsMatchError, contactsStatus, hashContacts, inviteUrl, matchContacts, pickDeviceContacts,
  readDeviceContacts, registerMyIdentifiers, requestContactsAccess, shareInvite,
  type ContactMatch, type ContactsStatus, type DeviceContact,
} from '@/lib/contacts';
import { pageTitle } from '@/lib/brand';
import { cn } from '@/lib/utils';

/** Si se dijo "Ahora no" a la pantalla previa: no volver a enseñarla sola. */
const INTRO_DISMISSED_KEY = 'ac_contacts_intro_dismissed';
const INVITE_PAGE = 60;

type Phase = 'checking' | 'intro' | 'syncing' | 'ready' | 'denied' | 'unavailable';

interface Settings {
  discoverable: boolean;
  notify_contacts_join: boolean;
  last_synced_at: string | null;
}

/** Una persona en la lista, venga de contactos, sugerencias o búsqueda. */
interface Row {
  id: string;
  name: string;
  avatar_url: string | null;
  relation: FriendRelation | 'blocked';
  friendship_id: string | null;
  subtitle: string;
}

export default function FindFriends() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();

  const [phase, setPhase] = useState<Phase>('checking');
  const [status, setStatus] = useState<ContactsStatus>('notDetermined');
  const [limitedPicker, setLimitedPicker] = useState(false);
  const [settings, setSettings] = useState<Settings>({ discoverable: false, notify_contacts_join: false, last_synced_at: null });
  /**
   * En la pantalla previa: lo que la persona elige antes de dar permiso.
   * Desmarcado: dejar que otros te encuentren es compartir tu correo o
   * teléfono (en forma de huella) y eso se activa, no se presupone.
   */
  const [introDiscoverable, setIntroDiscoverable] = useState(false);
  const [introNotify, setIntroNotify] = useState(false);

  const [contacts, setContacts] = useState<DeviceContact[]>([]);
  const [matches, setMatches] = useState<ContactMatch[]>([]);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Row[] | null>(null);
  const [query, setQuery] = useState('');
  const search = usePeopleSearch(query);
  const actions = useFriendActions();

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [inviteFilter, setInviteFilter] = useState('');
  const [inviteShown, setInviteShown] = useState(INVITE_PAGE);
  const [sharing, setSharing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);

  // ------------------------------------------------------------ datos

  const loadSettings = useCallback(async (): Promise<Settings | null> => {
    const { data, error } = await supabase.rpc('my_contact_settings');
    if (error) return null;
    const row = Array.isArray(data) ? data[0] : data;
    const s: Settings = {
      discoverable: Boolean(row?.discoverable),
      notify_contacts_join: Boolean(row?.notify_contacts_join),
      last_synced_at: row?.last_synced_at ?? null,
    };
    setSettings(s);
    return s;
  }, []);

  const loadSuggestions = useCallback(async () => {
    const { data, error } = await supabase.rpc('people_suggestions', { _limit: 12 });
    if (error) { setSuggestions([]); return; }
    setSuggestions((data ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      avatar_url: p.avatar_url,
      relation: 'none' as const,
      friendship_id: null,
      subtitle: p.in_contacts
        ? t('findFriends.inYourContacts')
        : p.mutual_friends > 0
          ? t('friends.mutualFriends', { count: p.mutual_friends })
          : p.shared_groups > 0
            ? t('friends.sharedGroups', { count: p.shared_groups })
            : t('friends.sameCampus'),
    })));
  }, [t]);

  /** Lee la agenda (o lo elegido), la resume y busca. Nada sale en claro. */
  const sync = useCallback(async (list: DeviceContact[] | null, s: Settings) => {
    setPhase('syncing');
    setSyncError(null);
    try {
      const agenda = list ?? await readDeviceContacts();
      setContacts(agenda);
      const { items } = await hashContacts(agenda, i18n.language === 'en' ? 'en-US' : navigator.language);
      // Primero darse de alta (si eres encontrable): así quien te tenga en
      // su agenda te encuentra aunque tú no lo busques nunca.
      if (s.discoverable) await registerMyIdentifiers().catch(() => undefined);
      setMatches(items.length ? await matchContacts(items, s.notify_contacts_join) : []);
      setPhase('ready');
      void loadSettings();
      void loadSuggestions();
    } catch (e) {
      const code = e instanceof ContactsMatchError ? e.code : 'NETWORK';
      setSyncError(
        code === 'CONTACTS_RATE_LIMIT' ? t('findFriends.errorRateLimit')
          : code === 'CONTACTS_NOT_CONFIGURED' ? t('findFriends.errorNotConfigured')
            : t('findFriends.errorNetwork'),
      );
      setPhase('ready');
    }
  }, [i18n.language, loadSettings, loadSuggestions, t]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [s, st] = await Promise.all([loadSettings(), contactsStatus()]);
      if (cancelled) return;
      setStatus(st.status);
      setLimitedPicker(st.limitedPickerAvailable);
      void loadSuggestions();
      if (s) {
        setIntroDiscoverable(s.discoverable);
        setIntroNotify(s.notify_contacts_join);
      }
      if (st.status === 'unavailable') setPhase('unavailable');
      else if (st.status === 'denied' || st.status === 'restricted') setPhase('denied');
      else if (st.status === 'notDetermined') setPhase('intro');
      // Ya hay permiso: la persona lo dio en su día; se actualiza sin preguntar.
      else if (s) void sync(null, s);
      else setPhase('ready');
    })();
    return () => { cancelled = true; };
  }, [loadSettings, loadSuggestions, sync]);

  // ------------------------------------------------------------ permiso

  const saveSettings = async (discoverable: boolean, notify: boolean): Promise<Settings> => {
    const next = { ...settings, discoverable, notify_contacts_join: notify };
    setSettings(next);
    const { error } = await supabase.rpc('set_contact_settings', { _discoverable: discoverable, _notify_join: notify });
    if (error) toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    // Dejar de ser encontrable se aplica ya en la base; registrar hace falta
    // para lo contrario.
    if (discoverable) void registerMyIdentifiers().catch(() => undefined);
    return next;
  };

  const findFriends = async () => {
    const s = await saveSettings(introDiscoverable, introNotify);
    const st = await requestContactsAccess();
    setStatus(st);
    if (st === 'authorized' || st === 'limited') await sync(null, s);
    else setPhase(st === 'unavailable' ? 'unavailable' : 'denied');
  };

  /** Sin dar permiso a la agenda: el selector del sistema. */
  const pickManually = async () => {
    const s = phase === 'intro' ? await saveSettings(introDiscoverable, introNotify) : settings;
    const picked = await pickDeviceContacts();
    if (picked && picked.length) await sync(picked, s);
  };

  const notNow = () => {
    try { localStorage.setItem(INTRO_DISMISSED_KEY, '1'); } catch { /* sin almacenamiento */ }
    if (location.key === 'default') navigate('/friends');
    else navigate(-1);
  };

  // ------------------------------------------------------------ listas

  const matchedContactIdx = useMemo(() => {
    const set = new Set<number>();
    for (const m of matches) for (const r of m.refs) set.add(Number(r.split('.')[0]));
    return set;
  }, [matches]);

  const matchRows: Row[] = useMemo(() => matches.map((m) => {
    const idx = Number(m.refs[0]?.split('.')[0]);
    const localName = contacts[idx]?.name;
    return {
      id: m.user_id,
      name: m.name,
      avatar_url: m.avatar_url,
      relation: m.relation,
      friendship_id: m.friendship_id ?? null,
      subtitle: [localName && localName !== m.name ? t('findFriends.savedAs', { name: localName }) : null, m.campus_name]
        .filter(Boolean).join(' · '),
    };
  }), [matches, contacts, t]);

  const invitable = useMemo(() => {
    const q = inviteFilter.trim().toLowerCase();
    return contacts
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => !matchedContactIdx.has(i) && (c.phones.length || c.emails.length))
      .filter(({ c }) => !q || c.name.toLowerCase().includes(q));
  }, [contacts, matchedContactIdx, inviteFilter]);

  const toggle = (i: number) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  const invite = async (count: number) => {
    setSharing(true);
    try {
      const { data: code, error } = await supabase.rpc('my_invite_code');
      if (error || !code) throw error ?? new Error('sin código');
      const done = await shareInvite(t('findFriends.inviteMessage'), inviteUrl(code), count);
      if (done) {
        toast({ title: t('findFriends.inviteShared') });
        setSelected(new Set());
      }
    } catch {
      toast({ title: t('findFriends.inviteFailed'), variant: 'destructive' });
    } finally {
      setSharing(false);
    }
  };

  // ------------------------------------------------------------ pintar

  const relationButton = (r: Row) => {
    const p = actions.withOverride({ id: r.id, relation: r.relation === 'blocked' ? 'none' : r.relation, friendship_id: r.friendship_id });
    const base = 'h-11 shrink-0 rounded-full px-3.5 text-[13px] font-semibold';
    if (r.relation === 'blocked') {
      return <span className="text-xs font-semibold text-muted-foreground px-2">{t('findFriends.blocked')}</span>;
    }
    switch (p.relation) {
      case 'friends':
        return (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-success px-2">
            <Check className="w-3.5 h-3.5" aria-hidden="true" /> {t('findFriends.friends')}
          </span>
        );
      case 'incoming':
        return (
          <Button className={base} disabled={actions.busy[r.id]} onClick={() => actions.accept(p)} aria-label={t('friends.acceptAria', { name: r.name })}>
            {t('friends.accept')}
          </Button>
        );
      case 'outgoing':
        return (
          <Button variant="ghost" className={cn(base, 'bg-muted text-muted-foreground')} disabled aria-label={t('findFriends.sentAria', { name: r.name })}>
            {t('findFriends.requestSent')}
          </Button>
        );
      default:
        return (
          <Button className={base} disabled={actions.busy[r.id]} onClick={() => actions.add(p)} aria-label={t('friends.addAria', { name: r.name })}>
            {t('friends.addFriend')}
          </Button>
        );
    }
  };

  const personList = (rows: Row[]) => (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-2 bg-card rounded-xl p-3 shadow-soft">
          <button
            type="button"
            onClick={() => setViewing(r.id)}
            aria-label={t('friends.viewProfile', { name: r.name })}
            className="flex items-center gap-3 flex-1 min-w-0 text-left rounded-lg active:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <UserAvatar url={r.avatar_url} name={r.name} className="w-11 h-11 bg-primary/10" textClassName="text-sm text-primary" />
            <span className="min-w-0">
              <span className="block font-semibold text-sm text-foreground truncate">{r.name}</span>
              {r.subtitle && <span className="block text-xs text-muted-foreground truncate">{r.subtitle}</span>}
            </span>
          </button>
          {relationButton(r)}
        </li>
      ))}
    </ul>
  );

  const searching = query.trim().length > 0;
  const searchRows: Row[] = search.results.map((p) => ({
    id: p.id, name: p.name, avatar_url: p.avatar_url, relation: p.relation, friendship_id: p.friendship_id,
    subtitle: p.mutual_friends > 0 ? t('friends.mutualFriends', { count: p.mutual_friends }) : (p.major ?? t('friends.sameCampus')),
  }));

  return (
    <div className="min-h-screen pb-nav px-4 pt-safe">
      <Helmet><title>{pageTitle(t('findFriends.title'))}</title></Helmet>

      <div className="flex items-center gap-2 mb-4">
        <button onClick={notNow} className="p-3 -m-2 text-muted-foreground" aria-label={t('common.back')}>
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="flex-1 text-2xl font-extrabold text-foreground ml-1">{t('findFriends.title')}</h1>
        {(phase === 'ready' || phase === 'denied') && (
          <button
            onClick={() => setSettingsOpen(true)}
            aria-label={t('findFriends.manage')}
            className="w-11 h-11 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Settings2 className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Buscar por nombre: siempre disponible, con o sin contactos. */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" aria-hidden="true" />
        <Input
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={100}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('friends.searchPh')}
          aria-label={t('friends.searchLabel')}
          className="pl-9 pr-10 h-11 rounded-xl"
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            aria-label={t('common.clearSearch')}
            className="absolute right-0 top-0 w-11 h-11 inline-flex items-center justify-center text-muted-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {searching ? (
        <section aria-label={t('friends.results')} aria-busy={search.status === 'loading'} className="space-y-2">
          {search.status === 'error' ? (
            <p className="text-sm text-muted-foreground">{t('friends.searchError')}</p>
          ) : search.status === 'ready' && searchRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('friends.noResults', { query: search.term })}</p>
          ) : searchRows.length === 0 ? (
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          ) : personList(searchRows)}
        </section>
      ) : (
        <div className="space-y-6">
          {phase === 'checking' && (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
            </div>
          )}

          {phase === 'intro' && (
            <section className="bg-card rounded-2xl shadow-soft p-5 space-y-4" aria-labelledby="contacts-intro-title">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
                <Contact className="w-6 h-6" aria-hidden="true" />
              </div>
              <h2 id="contacts-intro-title" className="text-lg font-extrabold text-foreground">{t('findFriends.introTitle')}</h2>
              <ul className="space-y-3 text-sm text-muted-foreground">
                {(['introWhy', 'introOptional', 'introWorks', 'introChange'] as const).map((k) => (
                  <li key={k} className="flex gap-2">
                    <ShieldCheck className="w-4 h-4 text-primary shrink-0 mt-0.5" aria-hidden="true" />
                    <span>{t(`findFriends.${k}`)}</span>
                  </li>
                ))}
              </ul>
              <div className="space-y-2 pt-1">
                <label className="flex items-start gap-3 min-h-[44px] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={introDiscoverable}
                    onChange={(e) => setIntroDiscoverable(e.target.checked)}
                    className="mt-1 w-5 h-5 accent-[hsl(var(--primary))]"
                  />
                  <span className="text-sm text-foreground">
                    {t('findFriends.discoverableLabel')}
                    <span className="block text-xs text-muted-foreground">{t('findFriends.discoverableHelp')}</span>
                  </span>
                </label>
                <label className="flex items-start gap-3 min-h-[44px] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={introNotify}
                    onChange={(e) => setIntroNotify(e.target.checked)}
                    className="mt-1 w-5 h-5 accent-[hsl(var(--primary))]"
                  />
                  <span className="text-sm text-foreground">
                    {t('findFriends.notifyJoinLabel')}
                    <span className="block text-xs text-muted-foreground">{t('findFriends.notifyJoinHelp')}</span>
                  </span>
                </label>
              </div>
              <div className="flex flex-col gap-2 pt-1">
                <Button className="h-12 rounded-xl font-bold" onClick={findFriends}>{t('findFriends.cta')}</Button>
                <Button variant="outline" className="h-12 rounded-xl font-semibold" onClick={pickManually}>
                  {t('findFriends.pickManually')}
                </Button>
                <Button variant="ghost" className="h-11 rounded-xl text-muted-foreground" onClick={notNow}>{t('findFriends.notNow')}</Button>
              </div>
            </section>
          )}

          {phase === 'denied' && (
            <section className="bg-card rounded-2xl shadow-soft p-5 space-y-3">
              <Lock className="w-6 h-6 text-muted-foreground" aria-hidden="true" />
              <h2 className="text-base font-bold text-foreground">
                {status === 'restricted' ? t('findFriends.restrictedTitle') : t('findFriends.deniedTitle')}
              </h2>
              <p className="text-sm text-muted-foreground">
                {status === 'restricted' ? t('findFriends.restrictedDesc') : t('findFriends.deniedDesc')}
              </p>
              <div className="flex flex-col gap-2">
                {status === 'denied' && (
                  <Button className="h-11 rounded-xl" onClick={() => setSettingsOpen(true)}>{t('findFriends.openSettings')}</Button>
                )}
                <Button variant="outline" className="h-11 rounded-xl" onClick={pickManually}>{t('findFriends.pickManually')}</Button>
              </div>
            </section>
          )}

          {phase === 'unavailable' && (
            <section className="bg-card rounded-2xl shadow-soft p-5 space-y-3">
              <h2 className="text-base font-bold text-foreground">{t('findFriends.webTitle')}</h2>
              <p className="text-sm text-muted-foreground">{t('findFriends.webDesc')}</p>
              <Button className="h-11 rounded-xl gap-2" disabled={sharing} onClick={() => invite(0)}>
                <Share2 className="w-4 h-4" aria-hidden="true" /> {t('findFriends.shareLink')}
              </Button>
            </section>
          )}

          {phase === 'syncing' && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> {t('findFriends.syncing')}
            </div>
          )}

          {phase === 'ready' && (
            <>
              {syncError && (
                <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-foreground flex items-center gap-2">
                  <span className="flex-1">{syncError}</span>
                  <Button size="sm" variant="outline" className="rounded-full" onClick={() => void sync(null, settings)}>
                    {t('friends.retry')}
                  </Button>
                </div>
              )}

              {(status === 'authorized' || status === 'limited') && (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {status === 'limited' ? t('findFriends.limitedNote') : t('findFriends.fullNote')}
                  </p>
                  <Button variant="ghost" size="sm" className="gap-1.5 rounded-full shrink-0" onClick={() => void sync(null, settings)}>
                    <RotateCw className="w-3.5 h-3.5" aria-hidden="true" /> {t('findFriends.refresh')}
                  </Button>
                </div>
              )}

              <section aria-labelledby="ff-matches" className="space-y-2">
                <h2 id="ff-matches" className="text-sm font-semibold text-muted-foreground flex items-center gap-1.5">
                  <Users className="w-4 h-4" aria-hidden="true" /> {t('findFriends.onApp', { count: matchRows.length })}
                </h2>
                {matchRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground bg-card rounded-xl p-4">
                    {contacts.length === 0 ? t('findFriends.noContacts') : t('findFriends.noMatches')}
                  </p>
                ) : personList(matchRows)}
              </section>
            </>
          )}

          {suggestions && suggestions.length > 0 && (
            <section aria-labelledby="ff-suggestions" className="space-y-2">
              <h2 id="ff-suggestions" className="text-sm font-semibold text-muted-foreground">{t('friends.suggestionsTitle')}</h2>
              {personList(suggestions)}
            </section>
          )}

          {phase === 'ready' && invitable.length > 0 && (
            <section aria-labelledby="ff-invite" className="space-y-2 pb-24">
              <h2 id="ff-invite" className="text-sm font-semibold text-muted-foreground flex items-center gap-1.5">
                <UserPlus className="w-4 h-4" aria-hidden="true" /> {t('findFriends.inviteTitle')}
              </h2>
              <p className="text-xs text-muted-foreground">{t('findFriends.inviteHelp')}</p>
              <Input
                value={inviteFilter}
                onChange={(e) => { setInviteFilter(e.target.value); setInviteShown(INVITE_PAGE); }}
                placeholder={t('findFriends.filterContacts')}
                aria-label={t('findFriends.filterContacts')}
                className="h-11 rounded-xl"
              />
              <ul className="bg-card rounded-xl shadow-soft divide-y divide-border">
                {invitable.slice(0, inviteShown).map(({ c, i }) => (
                  <li key={c.id + i}>
                    <label className="flex items-center gap-3 px-3 min-h-[52px] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selected.has(i)}
                        onChange={() => toggle(i)}
                        aria-label={c.name || c.phones[0] || c.emails[0]}
                        className="w-5 h-5 accent-[hsl(var(--primary))]"
                      />
                      <span aria-hidden="true">
                        <UserAvatar name={c.name || '?'} className="w-9 h-9 bg-muted" textClassName="text-xs text-muted-foreground" />
                      </span>
                      <span className="flex-1 min-w-0 text-sm font-medium text-foreground truncate">
                        {c.name || c.phones[0] || c.emails[0]}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {inviteShown < invitable.length && (
                <button onClick={() => setInviteShown((n) => n + INVITE_PAGE)} className="w-full min-h-[44px] text-sm font-semibold text-primary">
                  {t('common.loadMore')}
                </button>
              )}
            </section>
          )}
        </div>
      )}

      {/* Barra de invitar: encima de la barra inferior. */}
      {phase === 'ready' && selected.size > 0 && !searching && (
        <div className="fixed left-0 right-0 above-nav z-40 px-4 pb-3">
          <div className="mx-auto sm:max-w-[398px]">
            <Button className="w-full h-12 rounded-xl font-bold gap-2 shadow-lifted" disabled={sharing} onClick={() => invite(selected.size)}>
              {sharing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" aria-hidden="true" />}
              {t('findFriends.inviteCount', { count: selected.size })}
            </Button>
          </div>
        </div>
      )}

      <ContactsSettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        status={status}
        limitedPickerAvailable={limitedPicker}
        settings={settings}
        onChange={async (d, n) => { await saveSettings(d, n); }}
        onCleared={() => { setMatches([]); setContacts([]); void loadSettings(); void loadSuggestions(); }}
        onContactsChanged={() => void sync(null, settings)}
      />

      {viewing && <UserProfileSheet userId={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
