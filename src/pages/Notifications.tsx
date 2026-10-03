import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet-async';
import {
  ArrowLeft, Bell, BellRing, CalendarClock, CalendarX2, CheckCheck, Lightbulb, Megaphone, MessageCircle,
  MessagesSquare, Settings2, ShieldAlert, Sparkles, UserCheck, UserPlus, Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/user-avatar';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';
import { useNotificationStore } from '@/stores/notificationStore';
import { useToast } from '@/hooks/use-toast';
import { copyFor, inboxSection, routeForNotification, upsertInbox, type InboxItem } from '@/lib/notifications';
import { pageTitle } from '@/lib/brand';
import { cn } from '@/lib/utils';
import { useStaggerReveal } from '@/hooks/useStaggerReveal';
import { rpcMessage } from '@/lib/rpcErrors';
import { haptic } from '@/lib/haptics';

const PAGE = 30;

/** Icono por categoría: se reconoce de un vistazo qué tipo de aviso es. */
const CATEGORY_ICON: Record<string, typeof Bell> = {
  activity_messages: MessagesSquare,
  mentions: MessageCircle,
  event_updates: CalendarX2,
  event_requests: UserCheck,
  reminders: CalendarClock,
  direct_messages: MessageCircle,
  friend_requests: UserPlus,
  friend_activity: Users,
  people_suggestions: Sparkles,
  activity_recommendations: Lightbulb,
  digests: BellRing,
  account: Settings2,
  security: ShieldAlert,
  promotional: Megaphone,
};

type Row = InboxItem;

function toItem(r: Record<string, unknown>): Row {
  return {
    id: String(r.id),
    type: String(r.type),
    category: String(r.category),
    count: Number(r.count ?? 1),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    read_at: (r.read_at as string | null) ?? null,
    data: (r.data as Record<string, unknown> | null) ?? {},
    actor_id: (r.actor_id as string | null) ?? null,
    actor_name: (r.actor_name as string | null) ?? null,
    actor_avatar: (r.actor_avatar as string | null) ?? null,
    event_id: (r.event_id as string | null) ?? null,
    event_title: (r.event_title as string | null) ?? null,
    event_starts_at: (r.event_starts_at as string | null) ?? null,
    group_id: (r.group_id as string | null) ?? null,
    group_name: (r.group_name as string | null) ?? null,
    is_dm: Boolean(r.is_dm),
  };
}

/**
 * Centro de notificaciones: lista cronológica (lo agrupado sube cuando llega
 * algo nuevo), leídas y no leídas, marcar una o todas, tiempo real y
 * paginación. El texto sale del mismo módulo que la push.
 */
export default function Notifications() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const userId = useAuthStore((s) => s.user?.id);
  const refreshCounts = useNotificationStore((s) => s.refresh);
  const unreadTotal = useNotificationStore((s) => s.notificationsUnread);

  const [items, setItems] = useState<Row[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const itemsRef = useRef<Row[]>([]);
  itemsRef.current = items;

  const fetchPage = useCallback(async (before: string | null) => {
    const { data, error } = await supabase.rpc('my_notifications', before ? { _before: before, _limit: PAGE } : { _limit: PAGE });
    if (error) throw error;
    return (data ?? []).map((r) => toItem(r as unknown as Record<string, unknown>));
  }, []);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const rows = await fetchPage(null);
      setItems(rows);
      setHasMore(rows.length === PAGE);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, [fetchPage]);

  useEffect(() => { void load(); }, [load]);

  const loadMore = async () => {
    const last = itemsRef.current[itemsRef.current.length - 1];
    if (!last || loadingMore) return;
    setLoadingMore(true);
    try {
      const rows = await fetchPage(last.updated_at);
      setItems((prev) => upsertInbox(prev, rows));
      setHasMore(rows.length === PAGE);
    } catch {
      toast({ title: t('notificationCenter.loadError'), variant: 'destructive' });
    } finally {
      setLoadingMore(false);
    }
  };

  // Tiempo real: un aviso nuevo o uno agrupado que sube. Se vuelve a pedir la
  // primera página (resuelve nombres y títulos con los permisos de ahora)
  // en vez de pintar la fila cruda del socket.
  useEffect(() => {
    if (!userId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const rows = await fetchPage(null);
          setItems((prev) => upsertInbox(prev, rows));
        } catch {
          // Sin red: la lista se queda como estaba y el aviso sale al volver.
        }
      }, 300);
    };
    const channel = supabase
      .channel(`inbox-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` }, refresh)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [userId, fetchPage]);

  const markRead = async (ids: string[] | null) => {
    const now = new Date().toISOString();
    const before = itemsRef.current;
    setItems((prev) => prev.map((n) => (ids === null || ids.includes(n.id) ? { ...n, read_at: n.read_at ?? now } : n)));
    const { error } = await supabase.rpc('mark_notifications_read', ids === null ? {} : { _ids: ids });
    if (error) {
      setItems(before);
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
      return;
    }
    refreshCounts();
  };

  const open = async (n: Row) => {
    const route = routeForNotification(n);
    void supabase.rpc('mark_notification_opened', { _id: n.id }).then(() => refreshCounts());
    setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read_at: x.read_at ?? new Date().toISOString() } : x)));
    if (route) navigate(route);
    else toast({ title: t('notificationCenter.gone') });
  };

  const goBack = () => (location.key === 'default' ? navigate('/') : navigate(-1));

  // ---- Responder sin salir de aquí ---------------------------------------
  //
  // «Lucía te quiere agregar» y «Tomás quiere unirse a tu plan» son los avisos
  // con más intención de toda la app, y para contestarlos había que ir a otra
  // pantalla. Solo en los no leídos y de una sola persona: uno agrupado
  // («3 personas quieren unirse») se resuelve en la ficha del evento.
  const [resolved, setResolved] = useState<Record<string, 'accepted' | 'declined'>>({});
  const [acting, setActing] = useState<string | null>(null);
  const canActInline = (n: Row) =>
    !n.read_at && n.count === 1 && !!n.actor_id && !resolved[n.id] &&
    (n.type === 'friend_request' || (n.type === 'join_request' && !!n.event_id));

  const respond = async (n: Row, accept: boolean) => {
    if (!userId || !n.actor_id || acting) return;
    setActing(n.id);
    let ok = false;
    let gone = false;
    if (n.type === 'friend_request') {
      const { data: row } = await supabase
        .from('friendships')
        .select('id')
        .eq('requester_id', n.actor_id)
        .eq('addressee_id', userId)
        .eq('status', 'pending')
        .maybeSingle();
      if (!row) {
        gone = true;
      } else {
        const { error } = accept
          ? await supabase.from('friendships').update({ status: 'accepted' }).eq('id', row.id)
          : await supabase.from('friendships').delete().eq('id', row.id);
        ok = !error;
      }
    } else if (n.event_id) {
      const { error } = await supabase.rpc('respond_to_join_request', {
        _event_id: n.event_id,
        _user_id: n.actor_id,
        _approve: accept,
      });
      if (error) {
        toast({ title: t('common.error'), description: rpcMessage(error.message, t), variant: 'destructive' });
      } else {
        ok = true;
      }
    }
    setActing(null);
    if (gone) {
      toast({ title: t('friends.requestGone') });
      void markRead([n.id]);
      return;
    }
    if (!ok) return;
    haptic.light();
    setResolved((r) => ({ ...r, [n.id]: accept ? 'accepted' : 'declined' }));
    void markRead([n.id]);
    refreshCounts();
  };

  const visible = useMemo(() => (filter === 'unread' ? items.filter((n) => !n.read_at) : items), [items, filter]);
  const dateLocale = i18n.language?.startsWith('en') ? 'en-US' : 'es-MX';
  const timeOf = (iso: string) => {
    const d = new Date(iso);
    const sec = inboxSection(iso);
    return sec === 'today' || sec === 'yesterday'
      ? new Intl.DateTimeFormat(dateLocale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
      : new Intl.DateTimeFormat(dateLocale, { day: 'numeric', month: 'short' }).format(d);
  };

  let lastSection = '';

  // Entrada en cascada, igual que en Mis Eventos, Amigos y la lista del mapa.
  // Sin esto las notificaciones aparecían de golpe mientras el resto de la app
  // las revela una detrás de otra.
  const listScope = useStaggerReveal<HTMLDivElement>([filter, status]);

  return (
    <div ref={listScope} className="min-h-screen pb-nav px-4 pt-safe">
      <Helmet><title>{pageTitle(t('notificationCenter.title'))}</title></Helmet>

      <div className="flex items-center gap-2 mb-4">
        <button onClick={goBack} className="p-3 -m-2 text-muted-foreground" aria-label={t('common.back')}>
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="flex-1 ml-1 text-2xl font-extrabold text-foreground">{t('notificationCenter.title')}</h1>
        <button
          onClick={() => navigate('/settings/notifications')}
          aria-label={t('notificationSettings.title')}
          className="w-11 h-11 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Settings2 className="w-5 h-5" />
        </button>
      </div>

      <div className="flex items-center gap-2 mb-4">
        {(['all', 'unread'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={cn(
              // nowrap: a 375 pt «Sin leer (3)» se partía en dos líneas.
              'inline-flex items-center justify-center min-h-[44px] px-4 rounded-full text-sm font-semibold whitespace-nowrap shrink-0 transition-colors',
              filter === f ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
            )}
          >
            {f === 'all' ? t('notificationCenter.all') : t('notificationCenter.unread', { count: unreadTotal })}
          </button>
        ))}
        <span className="flex-1" />
        {items.some((n) => !n.read_at) && (
          // En pantallas estrechas solo el icono (con su nombre para
          // VoiceOver): con el texto, a 375 pt tocaba el borde.
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 rounded-full whitespace-nowrap min-h-[44px] min-w-[44px] shrink-0"
            aria-label={t('notificationCenter.markAll')}
            onClick={() => markRead(null)}
          >
            <CheckCheck className="w-4 h-4" aria-hidden="true" />
            <span className="hidden min-[400px]:inline">{t('notificationCenter.markAll')}</span>
          </Button>
        )}
      </div>

      {status === 'loading' && (
        <ul className="space-y-2" aria-busy="true" aria-label={t('common.loading')}>
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="flex gap-3 bg-card rounded-xl p-3 shadow-soft">
              <Skeleton className="w-10 h-10 rounded-full" />
              <div className="flex-1 space-y-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/2" /></div>
            </li>
          ))}
        </ul>
      )}

      {status === 'error' && (
        <div className="text-center py-16 space-y-3" role="alert">
          <p className="text-sm text-muted-foreground">{t('notificationCenter.loadError')}</p>
          <Button variant="outline" className="rounded-xl" onClick={() => void load()}>{t('friends.retry')}</Button>
        </div>
      )}

      {status === 'ready' && visible.length === 0 && (
        <div className="text-center py-16 px-6">
          <Bell className="w-12 h-12 text-muted-foreground/40 mx-auto mb-3" aria-hidden="true" />
          <p className="text-sm font-semibold text-foreground">
            {filter === 'unread' ? t('notificationCenter.emptyUnread') : t('notificationCenter.emptyTitle')}
          </p>
          {filter === 'all' && <p className="text-sm text-muted-foreground mt-1">{t('notificationCenter.emptyDesc')}</p>}
        </div>
      )}

      {status === 'ready' && visible.length > 0 && (
        <ul className="space-y-2" aria-label={t('notificationCenter.title')}>
          {visible.map((n) => {
            const section = inboxSection(n.updated_at);
            const header = section !== lastSection ? section : null;
            lastSection = section;
            const copy = copyFor(n, i18n.language ?? 'es');
            const Icon = CATEGORY_ICON[n.category] ?? Bell;
            const unread = !n.read_at;
            return (
              <li key={n.id} data-reveal className="list-none">
                {header && (
                  <h2 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mt-4 mb-2 first:mt-0">
                    {t(`notificationCenter.section.${header}`)}
                  </h2>
                )}
                {/* La tarjeta envuelve el aviso Y sus botones de respuesta, que
                    no pueden ir dentro del <button> principal. */}
                <div className={cn('rounded-xl', unread ? 'bg-primary/5 border border-primary/20' : 'bg-card shadow-soft')}>
                <button
                  onClick={() => open(n)}
                  className="w-full flex items-start gap-3 text-left rounded-xl p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="relative shrink-0" aria-hidden="true">
                    {n.actor_id && n.actor_name ? (
                      <UserAvatar url={n.actor_avatar} name={n.actor_name} className="w-10 h-10 bg-muted" textClassName="text-sm text-muted-foreground" />
                    ) : (
                      <span className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                        <Icon className="w-5 h-5 text-muted-foreground" />
                      </span>
                    )}
                    {n.actor_id && n.actor_name && (
                      <span className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-card border border-border flex items-center justify-center">
                        <Icon className="w-3 h-3 text-primary" />
                      </span>
                    )}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className={cn('block text-sm text-foreground', unread ? 'font-bold' : 'font-semibold')}>{copy.title}</span>
                    <span className="block text-sm text-muted-foreground line-clamp-2">{copy.body}</span>
                    <span className="block text-xs text-muted-foreground mt-1">
                      {timeOf(n.updated_at)}
                      {unread && <span className="sr-only">, {t('notificationCenter.unreadLabel')}</span>}
                    </span>
                  </span>
                  {unread && <span className="mt-1.5 w-2.5 h-2.5 rounded-full bg-primary shrink-0" aria-hidden="true" />}
                </button>
                {canActInline(n) && (
                  <div className="flex flex-wrap gap-2 pl-[3.75rem] pr-3 pb-3 -mt-1">
                    <Button
                      size="sm"
                      disabled={acting === n.id}
                      onClick={() => void respond(n, true)}
                      className="h-10 min-h-[44px] rounded-full px-4 font-bold"
                    >
                      {n.type === 'friend_request' ? t('friends.accept') : t('event.approve')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={acting === n.id}
                      onClick={() => void respond(n, false)}
                      className="h-10 min-h-[44px] rounded-full px-4 font-semibold"
                    >
                      {t('event.decline')}
                    </Button>
                  </div>
                )}
                {resolved[n.id] && (
                  <p role="status" className="pl-[3.75rem] pr-3 pb-3 -mt-1 text-sm font-semibold text-muted-foreground">
                    {resolved[n.id] === 'accepted'
                      ? n.type === 'friend_request' ? t('friends.requestAccepted') : t('event.requestApproved')
                      : n.type === 'friend_request' ? t('friends.requestDeclined') : t('event.requestDeclined')}
                  </p>
                )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {status === 'ready' && hasMore && filter === 'all' && (
        <button onClick={loadMore} disabled={loadingMore} className="w-full min-h-[44px] mt-3 text-sm font-semibold text-primary disabled:opacity-50">
          {loadingMore ? t('common.loading') : t('common.loadMore')}
        </button>
      )}
    </div>
  );
}
