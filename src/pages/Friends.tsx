import { useCallback, useEffect, useRef, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { UserPlus, Users, MessageCircle, Check, X as XIcon, Plus, Trophy, Medal } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';
import { useNotificationStore } from '@/stores/notificationStore';
import { useToast } from '@/hooks/use-toast';
import i18n from '@/i18n';
import { rpcMessage } from '@/lib/rpcErrors';
import { ModerationMenu } from '@/components/moderation/ModerationMenu';
import { cn } from '@/lib/utils';
import { UserAvatar } from '@/components/ui/user-avatar';
import { UserProfileSheet } from '@/components/profile/UserProfileSheet';
import type { Database } from '@/integrations/supabase/types';
import { pageTitle } from '@/lib/brand';
import { formatChatTime } from '@/lib/chat';
import { FindPeople } from '@/components/friends/FindPeople';
import { GroupInvites } from '@/components/chat/GroupInvites';

type FriendData = Pick<
  Database['public']['Views']['public_profiles']['Row'],
  'id' | 'name' | 'avatar_url' | 'major'
>;

/** El último mensaje visible de una conversación, para ordenar y previsualizar. */
type ChatActivity = {
  last_message_at: string | null;
  last_content: string | null;
  last_sender_id: string | null;
};

type Friend = FriendData & ChatActivity;

type PendingRequest = {
  friendshipId: string;
  profile: FriendData;
};

type Group = ChatActivity & {
  id: string;
  name: string;
};

/**
 * Lo que se puede tocar para abrir algo: foco visible con teclado y un
 * hundimiento al pulsar, que en iOS no hay hover que avise de que responde.
 */
const TAPPABLE =
  'rounded-lg transition-opacity active:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card';

type LeaderEntry = {
  id: string | null;
  name: string | null;
  avatar_url: string | null;
  points: number;
};

type ActiveTab = 'friends' | 'groups' | 'leaderboard';

export default function Friends() {
  const { user } = useAuthStore();
  const { toast } = useToast();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const initialTab: ActiveTab = (location.state as { tab?: ActiveTab } | null)?.tab ?? 'friends';
  const [activeTab, setActiveTab] = useState<ActiveTab>(initialTab);
  const unreadMessages = useNotificationStore((n) => n.unreadMessages);
  const groupInvites = useNotificationStore((n) => n.groupInvites);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [loading, setLoading] = useState(true);

  // Groups state
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [unreadByGroup, setUnreadByGroup] = useState<Record<string, number>>({});
  const [unreadByDmName, setUnreadByDmName] = useState<Record<string, number>>({});
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);

  // Leaderboard state
  const [leaderboard, setLeaderboard] = useState<LeaderEntry[]>([]);
  /** Persona cuya ficha se está mirando. */
  const [viewingUserId, setViewingUserId] = useState<string | null>(null);
  const [leaderLoading, setLeaderLoading] = useState(false);
  const [leaderOffset, setLeaderOffset] = useState(0);
  const [leaderHasMore, setLeaderHasMore] = useState(true);

  // Friends pagination
  const [friendsPage, setFriendsPage] = useState(0);
  const [friendsHasMore, setFriendsHasMore] = useState(false);
  /** Cuántos amigos hay, no cuántos se han cargado: lo devuelve la RPC. */
  const [friendsTotal, setFriendsTotal] = useState(0);
  const [loadingMoreFriends, setLoadingMoreFriends] = useState(false);
  const FRIENDS_PAGE_SIZE = 15;
  const LEADER_PAGE_SIZE = 20;

  const loadFriends = useCallback(async (page: number) => {
    if (!user) return;
    if (page === 0) setLoading(true); else setLoadingMoreFriends(true);
    try {
      // Una sola consulta, paginada en el servidor.
      //
      // Antes se traían TODAS las amistades y después se pedían los perfiles
      // con `.in('id', [...])`, metiendo la lista entera de uuid en la URL.
      // Unos 37 bytes por uuid contra un límite de ~8 kB: pasados unos 200
      // amigos la petición se rechazaba con 414 y la pestaña quedaba vacía.
      //
      // La RPC además ordena, que `.range()` sin `.order()` podía repetir y
      // saltarse filas entre páginas, y devuelve el total de verdad.
      const { data, error } = await supabase.rpc('friends_page', {
        _limit: FRIENDS_PAGE_SIZE,
        _offset: page * FRIENDS_PAGE_SIZE,
      });
      // Antes esto fallaba en silencio: una caída de red se veía igual que
      // "no tienes amigos todavía".
      if (error) {
        toast({ title: i18n.t('errors.friendsLoad'), variant: 'destructive' });
        return;
      }

      const rows = data ?? [];
      // Llegan ya ordenados por la conversación más reciente (friends_page).
      const perfiles = rows.map(({ id, name, avatar_url, major, last_message_at, last_content, last_sender_id }) => ({
        id, name, avatar_url, major, last_message_at, last_content, last_sender_id,
      }));
      if (page === 0) setFriends(perfiles);
      // Se descartan los repetidos por id: si entre una página y la siguiente
      // llegó un mensaje, el orden se movió y alguien puede venir dos veces.
      else setFriends((prev) => {
        const vistos = new Set(prev.map((f) => f.id));
        return [...prev, ...perfiles.filter((f) => !vistos.has(f.id))];
      });
      setFriendsHasMore(rows.length === FRIENDS_PAGE_SIZE);
      // El total viaja en cada fila. Una página vacía más allá del final no
      // dice nada del total, así que solo se pisa si hay filas o si es la
      // primera página (donde vacío sí significa que no hay ninguno).
      if (rows.length > 0) setFriendsTotal(Number(rows[0].total));
      else if (page === 0) setFriendsTotal(0);

      if (page === 0) {
        const { data: pending, error: pendingError } = await supabase.rpc('friend_requests_incoming');
        // Se asigna también cuando viene vacío: si no, rechazar la última
        // solicitud dejaba la anterior pintada hasta recargar la pantalla.
        if (!pendingError) {
          setPendingRequests(
            (pending ?? []).map((r) => ({
              friendshipId: r.friendship_id,
              profile: { id: r.id, name: r.name, avatar_url: r.avatar_url, major: r.major },
            })),
          );
        }
      }
    } finally {
      if (page === 0) setLoading(false); else setLoadingMoreFriends(false);
    }
  }, [user, toast]);

  useEffect(() => {
    loadFriends(0);
    setFriendsPage(0);
  }, [loadFriends]);

  const fetchGroups = useCallback(async () => {
    if (!user) return;
    setGroupsLoading(true);
    try {
      // chat_summaries trae mis chats con su último mensaje, ya ordenados por
      // actividad; los DM salen en la pestaña de amigos, no aquí.
      const { data, error } = await supabase.rpc('chat_summaries');
      if (error) {
        toast({ title: i18n.t('errors.groupsLoad'), variant: 'destructive' });
        return;
      }
      setGroups(
        (data ?? [])
          .filter((g) => !g.group_name.startsWith('__dm_'))
          .map((g) => ({
            id: g.group_id,
            name: g.group_name,
            last_message_at: g.last_message_at,
            last_content: g.last_content,
            last_sender_id: g.last_sender_id,
          }))
      );
    } finally {
      setGroupsLoading(false);
    }
  }, [user, toast]);

  // Mensajes sin leer, por chat. Los DM no salen en la lista de grupos, así
  // que se indexan también por nombre para poder pintarlos sobre el amigo que
  // escribió (create_dm nombra el grupo con los dos uuid ordenados).
  const fetchUnread = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase.rpc('unread_by_group');
    // Sin toast: si falla solo se quedan sin pintar los globos, y avisar de
    // eso interrumpiría por algo que no impide usar nada.
    if (error) console.error('unread_by_group:', error.message);
    const byId: Record<string, number> = {};
    const byName: Record<string, number> = {};
    (data ?? []).forEach((row) => {
      byId[row.group_id] = Number(row.unread);
      byName[row.group_name] = Number(row.unread);
    });
    setUnreadByGroup(byId);
    setUnreadByDmName(byName);
  }, [user]);

  // El nombre que create_dm le da al chat con esta persona.
  const dmNameWith = useCallback(
    (friendId: string) => {
      if (!user) return '';
      const [a, b] = [user.id, friendId].sort();
      return `__dm_${a}_${b}`;
    },
    [user]
  );

  const fetchLeaderboard = useCallback(async (offset = 0) => {
    setLeaderLoading(true);
    try {
      const { data, error } = await supabase
        .from('public_profiles')
        // Ordena por `points`, NO por `reputation`. Son dos monedas distintas:
        // `points` sube al unirse a un evento, organizarlo, calificarlo o hacer
        // check-in — que es lo que la gente hace y ve subir en su perfil—;
        // `reputation` solo sube si OTRO se une a TU evento (+2) o al hacer
        // check-in (+5). Ordenando por reputación, quien solo asiste a eventos
        // sumaba cientos de puntos y veía el Top congelado en 0.
        .select('id, name, avatar_url, points')
        .order('points', { ascending: false })
        // Desempate: sin él, dos personas con los mismos puntos podían
        // intercambiarse entre páginas y salir dos veces, o ninguna.
        .order('id', { ascending: true })
        .range(offset, offset + LEADER_PAGE_SIZE - 1);
      if (error) {
        toast({ title: i18n.t('errors.leaderboardLoad'), variant: 'destructive' });
        return;
      }
      if (data) {
        if (offset === 0) setLeaderboard(data as LeaderEntry[]);
        else setLeaderboard((prev) => [...prev, ...(data as LeaderEntry[])]);
        setLeaderHasMore(data.length === LEADER_PAGE_SIZE);
        setLeaderOffset(offset + data.length);
      }
    } finally {
      setLeaderLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (activeTab === 'groups') fetchGroups();
    if (activeTab === 'leaderboard') { setLeaderOffset(0); fetchLeaderboard(0); }
  }, [activeTab, fetchGroups, fetchLeaderboard]);

  // Se re-pide cuando cambia el contador global: la suscripción vive en
  // AppShell, así que ese número subiendo es la señal de que hay algo nuevo.
  useEffect(() => { fetchUnread(); }, [fetchUnread, unreadMessages]);

  /**
   * Reordenar sin perder lo ya cargado.
   *
   * Vuelve a pedir, desde el principio, tantos amigos como hay en pantalla:
   * así la conversación que acaba de moverse sube a su sitio aunque viniera
   * de una página posterior, y no se repite nadie.
   */
  const friendsCountRef = useRef(0);
  friendsCountRef.current = friends.length;
  const refreshFriendsOrder = useCallback(async () => {
    if (!user) return;
    const limit = Math.min(Math.max(friendsCountRef.current, FRIENDS_PAGE_SIZE), 100);
    const { data, error } = await supabase.rpc('friends_page', { _limit: limit, _offset: 0 });
    // Sin toast: la lista de antes sigue siendo válida, solo peor ordenada.
    if (error || !data) return;
    setFriends(data.map(({ id, name, avatar_url, major, last_message_at, last_content, last_sender_id }) => ({
      id, name, avatar_url, major, last_message_at, last_content, last_sender_id,
    })));
    setFriendsPage(Math.max(Math.ceil(data.length / FRIENDS_PAGE_SIZE) - 1, 0));
    setFriendsHasMore(data.length > 0 && Number(data[0].total) > data.length);
    if (data.length > 0) setFriendsTotal(Number(data[0].total));
  }, [user]);

  // Un mensaje nuevo, editado o borrado en cualquiera de mis chats. La RLS de
  // SELECT de messages decide qué filas llegan, así que solo avisan los chats
  // de los que soy miembro. Se agrupan: una ráfaga de mensajes es una recarga.
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  useEffect(() => {
    if (!user) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (activeTabRef.current === 'friends') refreshFriendsOrder();
        if (activeTabRef.current === 'groups') fetchGroups();
        // Enviar uno propio no mueve el contador global, pero un borrado sí
        // puede bajar los globos: se piden a mano.
        fetchUnread();
      }, 400);
    };
    const channel = supabase
      .channel('friends-chat-activity')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, schedule)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, schedule)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [user, refreshFriendsOrder, fetchGroups, fetchUnread]);

  /** «Tú: hola» o «hola», sin saltos de línea, para la línea de previsualización. */
  const previewOf = (c: ChatActivity) =>
    `${c.last_sender_id === user?.id ? `${t('chat.you')}: ` : ''}${(c.last_content ?? '').replace(/\s+/g, ' ')}`;
  const timeOf = (iso: string) => formatChatTime(iso, i18n.language || 'es', t('chat.yesterday'));

  // El DM lo crea create_dm() en el servidor: atómico (grupo + las dos
  // membresías) e idempotente, así que ambas partes acaban en el mismo grupo.
  // Desde el cliente no se puede insertar la membresía de otra persona.
  const handleMessageFriend = useCallback(async (friend: FriendData) => {
    if (!user || !friend.id) return;

    const { data: groupId, error } = await supabase.rpc('create_dm', {
      _other_user_id: friend.id,
    });

    if (error || !groupId) {
      toast({
        title: t('common.error'),
        description: rpcMessage(error?.message, t),
        variant: 'destructive',
      });
      return;
    }

    // El chat necesita saber de dónde se vino para que el botón de atrás
    // devuelva a la pestaña correcta.
    navigate(`/groups/${groupId}`, { state: { from: 'friends' } });
  }, [user, navigate, toast, t]);

  const acceptRequest = async (req: PendingRequest) => {
    const { error } = await supabase
      .from('friendships')
      .update({ status: 'accepted' })
      .eq('id', req.friendshipId);
    if (error) {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
      return;
    }
    setPendingRequests((prev) => prev.filter((r) => r.friendshipId !== req.friendshipId));
    // Recién aceptado no hay chat todavía: va con los que no tienen, al final.
    setFriends((prev) => [...prev, { ...req.profile, last_message_at: null, last_content: null, last_sender_id: null }]);
    toast({ title: t('friends.requestAccepted') });
  };

  const declineRequest = async (req: PendingRequest) => {
    const { error } = await supabase
      .from('friendships')
      .delete()
      .eq('id', req.friendshipId);
    if (error) {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
      return;
    }
    setPendingRequests((prev) => prev.filter((r) => r.friendshipId !== req.friendshipId));
    toast({ title: t('friends.requestDeclined') });
  };

  const sendFriendRequest = async (friendId: string | null) => {
    if (!user || !friendId) return;
    const { error } = await supabase.from('friendships').insert({
      requester_id: user.id,
      addressee_id: friendId,
      status: 'pending',
    });
    if (error) {
      if (error.code === '23505') {
        toast({ title: t('friends.alreadySent') });
      } else {
        toast({ title: t('common.error'), description: rpcMessage(error.message, t), variant: 'destructive' });
      }
    } else {
      toast({ title: t('friends.requestSent') });
    }
  };

  const createGroup = async () => {
    if (!user || !newGroupName.trim()) return;
    setCreatingGroup(true);
    try {
      const { data: group, error } = await supabase
        .from('groups')
        .insert({ name: newGroupName.trim(), created_by: user.id })
        .select('id, name')
        .single();
      if (error || !group) {
        toast({ title: t('common.error'), description: error?.message, variant: 'destructive' });
        return;
      }
      // La membresía del creador la añade el trigger trg_group_created_add_creator;
      // el cliente ya no puede escribir en group_members.
      setGroups((prev) => [...prev, { ...group, last_message_at: null, last_content: null, last_sender_id: null }]);
      setNewGroupName('');
      setShowCreateGroup(false);
      toast({ title: t('groups.created') });
    } finally {
      setCreatingGroup(false);
    }
  };

  const rankMedal = (i: number) => {
    if (i > 2) {
      return <span className="text-sm font-bold text-muted-foreground">{i + 1}.</span>;
    }
    // Mismos tonos que los avatares de al lado, para que el podio se lea como
    // una sola pieza y no como dos criterios de color distintos.
    const tono =
      i === 0 ? 'text-yellow-600 dark:text-yellow-300' :
      i === 1 ? 'text-slate-500 dark:text-slate-200' :
                'text-orange-600 dark:text-orange-300';
    return (
      <>
        {/* El emoji anunciaba "medalla de oro" al lector de pantalla; un SVG
            no dice nada, así que la posición se expone aparte. */}
        <span className="sr-only">{i + 1}</span>
        <Medal aria-hidden="true" className={cn('w-5 h-5', tono)} />
      </>
    );
  };

  return (
    <div className="min-h-screen pb-nav px-4 pt-safe">
      <Helmet>
        <title>{pageTitle(t('friends.title'))}</title>
        <meta name="description" content={t('friends.metaDesc')} />
        <link rel="canonical" href="/friends" />
        <meta property="og:title" content={pageTitle(t('friends.title'))} />
        <meta property="og:description" content={t('friends.metaDesc')} />
        <meta property="og:url" content="/friends" />
      </Helmet>
      <div className="flex items-center justify-between gap-2 mb-4">
        <h1 className="text-2xl font-extrabold text-foreground">{t('friends.title')}</h1>
        {/* Contactos e invitaciones: nunca se pide el permiso sin pasar antes
            por la pantalla que explica para qué. */}
        <button
          onClick={() => navigate('/friends/find')}
          className="inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-full bg-primary/10 text-primary text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <UserPlus className="w-4 h-4" aria-hidden="true" />
          {t('findFriends.entry')}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-5">
        {(['friends', 'groups', 'leaderboard'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'relative inline-flex items-center justify-center min-h-[44px] px-5 rounded-full text-sm font-semibold transition-all',
              activeTab === tab ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
            )}
          >
            {tab === 'friends' && t('friends.tabFriends')}
            {tab === 'groups' && t('friends.tabGroups')}
            {tab === 'leaderboard' && t('friends.tabLeaderboard')}
            {tab === 'friends' && pendingRequests.length + groupInvites > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 bg-destructive text-destructive-foreground rounded-full text-xs font-bold flex items-center justify-center">
                {pendingRequests.length + groupInvites}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Friends tab */}
      {activeTab === 'friends' && (
        <FindPeople
          onFriendsChanged={() => { setFriendsPage(0); loadFriends(0); }}
          onMessage={handleMessageFriend}
        >
        <div className="space-y-4">
          <GroupInvites />

          {pendingRequests.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-muted-foreground">
                {t('friends.requests')} ({pendingRequests.length})
              </h2>
              {pendingRequests.map((req) => (
                <div key={req.friendshipId} className="flex items-center justify-between bg-card rounded-xl p-3 shadow-soft">
                  {/* Ver a quien pide amistad antes de decidir. */}
                  <button
                    onClick={() => setViewingUserId(req.profile.id ?? null)}
                    aria-label={t('friends.viewProfile', { name: req.profile.name ?? '' })}
                    className={cn('flex items-center gap-3 flex-1 min-w-0 mr-3 text-left', TAPPABLE)}
                  >
                    <UserAvatar
                      url={req.profile.avatar_url}
                      name={req.profile.name}
                      className="w-10 h-10 bg-primary/10"
                      textClassName="text-sm text-primary"
                    />
                    <div className="min-w-0">
                      <p className="font-semibold text-sm text-foreground truncate">{req.profile.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{req.profile.major}</p>
                    </div>
                  </button>
                  {/* 44px y separados: son dos acciones opuestas, pegadas y
                      sin vuelta atrás — rechazar por error borra la solicitud. */}
                  <div className="flex gap-3">
                    <button
                      onClick={() => acceptRequest(req)}
                      aria-label={t('friends.accept')}
                      className="w-11 h-11 rounded-full bg-primary flex items-center justify-center text-primary-foreground shrink-0"
                    >
                      <Check className="w-5 h-5" />
                    </button>
                    <button
                      onClick={() => declineRequest(req)}
                      aria-label={t('friends.decline')}
                      className="w-11 h-11 rounded-full bg-muted flex items-center justify-center text-muted-foreground shrink-0"
                    >
                      <XIcon className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground">
              {t('friends.myFriends')} ({friendsTotal})
            </h2>
            {loading ? (
              [1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3 bg-card rounded-xl p-3 shadow-soft">
                  <Skeleton className="w-10 h-10 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-1/4" />
                  </div>
                </div>
              ))
            ) : friends.length === 0 ? (
              <div className="text-center py-12">
                <Users className="w-12 h-12 text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-muted-foreground text-sm">{t('friends.empty')}</p>
              </div>
            ) : null}
            {!loading &&
              friends.map((f) => (
                <div key={f.id ?? ''} className="flex items-center justify-between bg-card rounded-xl p-3 shadow-soft">
                  <button
                    onClick={() => setViewingUserId(f.id ?? null)}
                    aria-label={t('friends.viewProfile', { name: f.name ?? '' })}
                    className={cn('flex items-center gap-3 flex-1 min-w-0 text-left', TAPPABLE)}
                  >
                    <UserAvatar
                      url={f.avatar_url}
                      name={f.name}
                      className="w-10 h-10 bg-primary/10"
                      textClassName="text-sm text-primary"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <p className="font-semibold text-sm text-foreground truncate flex-1">{f.name}</p>
                        {f.last_message_at && (
                          <span className="text-[11px] text-muted-foreground shrink-0">{timeOf(f.last_message_at)}</span>
                        )}
                      </div>
                      {/* Con conversación, lo último que se dijo; sin ella, la
                          carrera, como hasta ahora. */}
                      <p className="text-xs text-muted-foreground truncate">
                        {f.last_message_at ? previewOf(f) : f.major}
                      </p>
                    </div>
                  </button>
                  <div className="flex items-center">
                    <button
                      onClick={() => handleMessageFriend(f)}
                      aria-label={t('friends.messageAria', { name: f.name ?? '' })}
                      className="relative w-11 h-11 shrink-0 inline-flex items-center justify-center -m-1 text-primary"
                    >
                      <MessageCircle className="w-5 h-5" />
                      {unreadByDmName[dmNameWith(f.id ?? '')] > 0 && (
                        <span className="absolute top-0.5 right-0.5 min-w-[20px] h-5 px-1 rounded-full bg-destructive text-destructive-foreground text-xs font-bold flex items-center justify-center">
                          {unreadByDmName[dmNameWith(f.id ?? '')]}
                        </span>
                      )}
                    </button>
                    <ModerationMenu
                      target={{ kind: 'user', id: f.id ?? '' }}
                      label={f.name}
                      blockUserId={f.id}
                      onBlocked={() => { setFriends((prev) => prev.filter((x) => x.id !== f.id)); }}
                    />
                  </div>
                </div>
              ))}
            {!loading && friendsHasMore && (
              <button
                onClick={() => { const next = friendsPage + 1; setFriendsPage(next); loadFriends(next); }}
                disabled={loadingMoreFriends}
                className="w-full min-h-[44px] text-sm font-semibold text-primary disabled:opacity-50"
              >
                {loadingMoreFriends ? t('common.loading') : t('common.loadMore')}
              </button>
            )}
          </div>
        </div>
        </FindPeople>
      )}

      {/* Groups tab */}
      {activeTab === 'groups' && (
        <div className="space-y-4">
          <Button
            onClick={() => setShowCreateGroup(true)}
            className="w-full h-11 rounded-xl font-semibold"
          >
            <Plus className="w-4 h-4 mr-2" />
            {t('groups.new')}
          </Button>

          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground">{t('groups.myGroups')}</h2>
            {groupsLoading ? (
              [1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3 bg-card rounded-xl p-3 shadow-soft">
                  <Skeleton className="w-10 h-10 rounded-full" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              ))
            ) : groups.length === 0 ? (
              <div className="text-center py-12">
                <Users className="w-12 h-12 text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-muted-foreground text-sm">{t('groups.empty')}</p>
              </div>
            ) : (
              groups.map((g) => (
                <button
                  key={g.id}
                  onClick={() => navigate(`/groups/${g.id}`, { state: { from: 'groups' } })}
                  className={cn('w-full flex items-center gap-3 bg-card p-3 shadow-soft text-left', TAPPABLE, 'rounded-xl')}
                >
                  <div className="w-10 h-10 shrink-0 rounded-full bg-primary/10 flex items-center justify-center text-sm font-bold text-primary">
                    {g.name[0]}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="font-semibold text-sm text-foreground truncate flex-1">{g.name}</span>
                      {g.last_message_at && (
                        <span className="text-[11px] text-muted-foreground shrink-0">{timeOf(g.last_message_at)}</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {g.last_message_at ? previewOf(g) : t('chat.noMessagesShort')}
                    </p>
                  </div>
                  {unreadByGroup[g.id] > 0 && (
                    <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-destructive text-destructive-foreground text-xs font-bold flex items-center justify-center">
                      {unreadByGroup[g.id]}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* Leaderboard tab */}
      {activeTab === 'leaderboard' && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
            <Trophy className="w-4 h-4 text-primary" />
            {t('leaderboard.title')}
          </h2>
          {leaderLoading ? (
            [1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-center gap-3 bg-card rounded-xl p-3 shadow-soft">
                <Skeleton className="w-7 h-5 rounded" />
                <Skeleton className="w-10 h-10 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-1/3" />
                </div>
                <Skeleton className="h-4 w-12" />
              </div>
            ))
          ) : leaderboard.length === 0 ? (
            <div className="text-center py-12">
              <Trophy className="w-12 h-12 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-muted-foreground text-sm">{t('leaderboard.empty')}</p>
            </div>
          ) : (
            leaderboard.map((entry, i) => (
              <button
                key={entry.id ?? i}
                onClick={() => setViewingUserId(entry.id)}
                disabled={!entry.id}
                aria-label={t('friends.viewProfile', { name: entry.name ?? '' })}
                className={cn(
                  'w-full flex items-center gap-3 bg-card p-3 shadow-soft text-left',
                  TAPPABLE,
                  'rounded-xl',
                  i < 3 && 'border border-primary/20'
                )}
              >
                <span className="w-7 shrink-0 flex items-center justify-center">
                  {rankMedal(i)}
                </span>
                <UserAvatar
                  url={entry.avatar_url}
                  name={entry.name}
                  className={cn(
                    'w-10 h-10',
                    i === 0 ? 'bg-yellow-100 dark:bg-yellow-500/20' :
                    i === 1 ? 'bg-slate-100 dark:bg-slate-400/20' :
                    i === 2 ? 'bg-orange-100 dark:bg-orange-500/20' :
                    'bg-primary/10'
                  )}
                  textClassName={cn(
                    'text-sm',
                    i === 0 ? 'text-yellow-700 dark:text-yellow-300' :
                    i === 1 ? 'text-slate-600 dark:text-slate-200' :
                    i === 2 ? 'text-orange-700 dark:text-orange-300' :
                    'text-primary'
                  )}
                />
                <p className="flex-1 font-semibold text-sm text-foreground truncate">{entry.name}</p>
                <span className="text-sm font-bold text-primary shrink-0">
                  {entry.points} {t('leaderboard.pts')}
                </span>
              </button>
            ))
          )}
          {!leaderLoading && leaderHasMore && (
            <button
              onClick={() => fetchLeaderboard(leaderOffset)}
              className="w-full min-h-[44px] text-sm font-semibold text-primary"
            >
              {t('common.loadMore')}
            </button>
          )}
        </div>
      )}

      {/* Create group dialog */}
      <Dialog open={showCreateGroup} onOpenChange={setShowCreateGroup}>
        <DialogContent className="max-w-[360px] rounded-2xl">
          <DialogHeader>
            <DialogTitle>{t('groups.createTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-1">
            <Input
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createGroup()}
              placeholder={t('groups.namePh')}
              className="h-11 rounded-xl"
              autoFocus
            />
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setShowCreateGroup(false)} className="flex-1 rounded-xl">
                {t('common.cancel')}
              </Button>
              <Button
                onClick={createGroup}
                disabled={creatingGroup || !newGroupName.trim()}
                className="flex-1 rounded-xl"
              >
                {creatingGroup ? t('common.saving') : t('groups.createTitle')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Ficha de otra persona. La acción de abajo se decide sola según si
          ya es amigo: mandarle un mensaje, o pedirle amistad. */}
      {viewingUserId && (
        <UserProfileSheet
          userId={viewingUserId}
          onClose={() => setViewingUserId(null)}
          footer={(() => {
            // Uno mismo (desde Top): nada que hacer consigo.
            if (viewingUserId === user?.id) return undefined;
            // Quien me pidió amistad: decidir desde su ficha.
            const request = pendingRequests.find((r) => r.profile.id === viewingUserId);
            if (request) {
              return (
                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    className="flex-1 rounded-xl"
                    onClick={() => { setViewingUserId(null); declineRequest(request); }}
                  >
                    <XIcon className="w-4 h-4" />
                    {t('friends.decline')}
                  </Button>
                  <Button
                    className="flex-1 rounded-xl"
                    onClick={() => { setViewingUserId(null); acceptRequest(request); }}
                  >
                    <Check className="w-4 h-4" />
                    {t('friends.accept')}
                  </Button>
                </div>
              );
            }
            const friend = friends.find((f) => f.id === viewingUserId);
            return friend ? (
              <Button
                className="w-full rounded-xl"
                onClick={() => {
                  setViewingUserId(null);
                  handleMessageFriend(friend);
                }}
              >
                <MessageCircle className="w-4 h-4" />
                {t('friends.sendMessage')}
              </Button>
            ) : (
              <Button
                className="w-full rounded-xl"
                onClick={() => {
                  sendFriendRequest(viewingUserId);
                  setViewingUserId(null);
                }}
              >
                <UserPlus className="w-4 h-4" />
                {t('friends.addFriend')}
              </Button>
            );
          })()}
        />
      )}
    </div>
  );
}
