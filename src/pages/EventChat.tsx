import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle, ArrowDown, ArrowLeft, Bell, BellOff, Check, Clock, Lock, Megaphone, MessagesSquare,
  Pencil, RotateCw, Send, Trash2, Users, WifiOff, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/user-avatar';
import { MessageActionsMenu } from '@/components/chat/MessageActionsMenu';
import { ModerationMenu } from '@/components/moderation/ModerationMenu';
import { EventChatMembersSheet, type ChatMember } from '@/components/chat/EventChatMembersSheet';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';
import { useNotificationStore } from '@/stores/notificationStore';
import { useToast } from '@/hooks/use-toast';
import { useKeyboardInset } from '@/hooks/useKeyboardInset';
import { rpcMessage } from '@/lib/rpcErrors';
import { canSaveEdit } from '@/lib/chat';
import {
  EVENT_MESSAGE_COLUMNS, MESSAGE_MAX_LENGTH, activeMentionQuery, dayKey, dropMessage, firstUnreadIndex,
  insertMention, mentionCandidates, mentionIdsInText, mergeMessages, newMessageId, setSendState,
  splitMentions, toChatMessage, type EventChatMessage, type Mentionable,
} from '@/lib/eventChat';
import { cn } from '@/lib/utils';

/** Mensajes por tanda: llenan la pantalla y no pesan. */
const PAGE = 40;
/** Cada cuánto se renueva "lo estoy viendo" (el servidor lo da por caducado a los 45 s). */
const PRESENCE_MS = 30_000;
/** Cada cuánto se vuelve a comprobar que sigues dentro, por si el tiempo real se pierde un aviso. */
const RECHECK_MS = 60_000;

type Phase = 'loading' | 'ready' | 'no-access' | 'error';

interface ChatEvent {
  id: string;
  title: string;
  starts_at: string;
  creator_id: string;
  is_active: boolean;
}

interface Summary {
  can_access: boolean;
  is_organizer: boolean;
  removed: boolean;
  muted: boolean;
  last_read_at: string | null;
  unread: number;
  member_count: number;
}

type Connection = 'connecting' | 'online' | 'offline';

export default function EventChat() {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuthStore();
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const visible = useKeyboardInset();
  const keyboard = visible.keyboard;
  const refreshCounts = useNotificationStore((s) => s.refresh);

  const [phase, setPhase] = useState<Phase>('loading');
  const [event, setEvent] = useState<ChatEvent | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [messages, setMessages] = useState<EventChatMessage[]>([]);
  const [members, setMembers] = useState<ChatMember[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  /** La última lectura al abrir: dónde va la raya de "nuevos". No se mueve mientras lees. */
  const [unreadMarker, setUnreadMarker] = useState<string | null>(null);
  const [newBelow, setNewBelow] = useState(0);
  const [membersOpen, setMembersOpen] = useState(false);

  const [text, setText] = useState('');
  const [announce, setAnnounce] = useState(false);
  const [picked, setPicked] = useState<Mentionable[]>([]);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; original: string } | null>(null);
  const draftBeforeEditRef = useRef('');
  const [moderating, setModerating] = useState<EventChatMessage | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const lastIdRef = useRef<string | null>(null);
  const firstPaintRef = useRef(true);
  /** Nombres de quien ya no está en el chat pero dejó mensajes. */
  const extraNamesRef = useRef<Map<string, { name: string | null; avatar_url: string | null }>>(new Map());
  const [namesVersion, setNamesVersion] = useState(0);

  const myId = user?.id ?? '';
  const isOrganizer = Boolean(summary?.is_organizer);
  const dateLocale = i18n.language?.startsWith('en') ? 'en-US' : 'es-MX';

  // ------------------------------------------------------------ carga

  /** Cabecera y acceso. Devuelve si hay acceso, para quien lo necesite. */
  const loadSummary = useCallback(async (): Promise<Summary | null> => {
    if (!eventId) return null;
    const { data, error } = await supabase.rpc('event_chat_summary', { _event_id: eventId });
    if (error) return null;
    const row = (Array.isArray(data) ? data[0] : data) as Summary | undefined;
    if (!row) return null;
    const s: Summary = { ...row, unread: Number(row.unread ?? 0), member_count: Number(row.member_count ?? 0) };
    setSummary(s);
    return s;
  }, [eventId]);

  const loadMembers = useCallback(async () => {
    if (!eventId) return;
    const { data, error } = await supabase.rpc('event_chat_members', { _event_id: eventId });
    if (!error) setMembers(data ?? []);
  }, [eventId]);

  useEffect(() => {
    if (!eventId || !myId) return;
    let cancelled = false;
    setPhase('loading');
    setMessages([]);
    lastIdRef.current = null;
    firstPaintRef.current = true;

    (async () => {
      const [{ data: ev, error: evErr }, s] = await Promise.all([
        supabase.from('events').select('id, title, starts_at, creator_id, is_active').eq('id', eventId).maybeSingle(),
        loadSummary(),
      ]);
      if (cancelled) return;
      if (evErr || s === null) {
        setPhase('error');
        return;
      }
      setEvent(ev ?? null);
      if (!s.can_access) {
        setPhase('no-access');
        return;
      }

      const [{ data: rows, error }] = await Promise.all([
        supabase
          .from('messages')
          .select(EVENT_MESSAGE_COLUMNS)
          .eq('event_id', eventId)
          .order('created_at', { ascending: false })
          .limit(PAGE),
        loadMembers(),
      ]);
      if (cancelled) return;
      if (error) {
        setPhase('error');
        return;
      }
      setMessages((rows ?? []).map(toChatMessage).reverse());
      setHasOlder((rows?.length ?? 0) === PAGE);
      setUnreadMarker(s.last_read_at);
      setPhase('ready');
    })();

    return () => { cancelled = true; };
  }, [eventId, myId, loadSummary, loadMembers]);

  const loadOlder = async () => {
    if (!eventId || loadingOlder || messages.length === 0) return;
    const firstSent = messages.find((m) => !m.state || m.state === 'sent');
    if (!firstSent) return;
    setLoadingOlder(true);
    const el = listRef.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    const { data, error } = await supabase
      .from('messages')
      .select(EVENT_MESSAGE_COLUMNS)
      .eq('event_id', eventId)
      .lt('created_at', firstSent.created_at)
      .order('created_at', { ascending: false })
      .limit(PAGE);
    setLoadingOlder(false);
    if (error) {
      toast({ title: t('errors.messagesLoad'), variant: 'destructive' });
      return;
    }
    setHasOlder((data?.length ?? 0) === PAGE);
    setMessages((prev) => mergeMessages(prev, (data ?? []).map(toChatMessage)));
    // Mantener a la vista lo que se estaba leyendo: la lista crece por arriba.
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - before;
    });
  };

  // ------------------------------------------------------------ nombres

  const memberById = useMemo(() => new Map(members.map((m) => [m.user_id, m])), [members]);

  const nameOf = useCallback((id: string): string | null => {
    // namesVersion cambia cuando llegan nombres de gente que ya no está en el
    // chat; leerlo aquí hace que la función se rehaga y la lista se repinte.
    void namesVersion;
    return memberById.get(id)?.name ?? extraNamesRef.current.get(id)?.name ?? null;
  }, [memberById, namesVersion]);

  const avatarOf = (id: string) => memberById.get(id)?.avatar_url ?? extraNamesRef.current.get(id)?.avatar_url ?? null;

  // Quien se fue del chat sigue firmando sus mensajes viejos.
  useEffect(() => {
    const faltan = [...new Set(messages.map((m) => m.sender_id))].filter(
      (id) => id && !memberById.has(id) && !extraNamesRef.current.has(id),
    );
    if (faltan.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('public_profiles').select('id, name, avatar_url').in('id', faltan);
      if (cancelled) return;
      for (const p of data ?? []) if (p.id) extraNamesRef.current.set(p.id, { name: p.name, avatar_url: p.avatar_url });
      for (const id of faltan) if (!extraNamesRef.current.has(id)) extraNamesRef.current.set(id, { name: null, avatar_url: null });
      setNamesVersion((v) => v + 1);
    })();
    return () => { cancelled = true; };
  }, [messages, memberById]);

  const namesForMentions = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const x of members) m.set(x.user_id, x.name);
    return m;
  }, [members]);

  // ------------------------------------------------------------ tiempo real

  const recheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recheckAccess = useCallback(() => {
    if (recheckTimer.current) clearTimeout(recheckTimer.current);
    recheckTimer.current = setTimeout(async () => {
      const s = await loadSummary();
      if (s && !s.can_access) setPhase('no-access');
      else if (s) loadMembers();
    }, 400);
  }, [loadSummary, loadMembers]);

  /** Lo que se perdió mientras el canal estaba caído. */
  const catchUp = useCallback(async () => {
    if (!eventId) return;
    const lastSent = [...messages].reverse().find((m) => !m.state || m.state === 'sent');
    const q = supabase.from('messages').select(EVENT_MESSAGE_COLUMNS).eq('event_id', eventId);
    const { data } = await (lastSent ? q.gt('created_at', lastSent.created_at) : q)
      .order('created_at', { ascending: true })
      .limit(100);
    if (data?.length) setMessages((prev) => mergeMessages(prev, data.map(toChatMessage)));
  }, [eventId, messages]);
  const catchUpRef = useRef(catchUp);
  catchUpRef.current = catchUp;

  useEffect(() => {
    if (phase !== 'ready' || !eventId) return;
    let wasDown = false;
    const channel = supabase
      .channel(`event-chat-${eventId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `event_id=eq.${eventId}` },
        (payload) => setMessages((prev) => mergeMessages(prev, [toChatMessage(payload.new as EventChatMessage)])),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `event_id=eq.${eventId}` },
        (payload) => {
          const m = toChatMessage(payload.new as EventChatMessage);
          setMessages((prev) => mergeMessages(prev, [m]));
          if (m.deleted_at) setEditing((cur) => (cur?.id === m.id ? null : cur));
        },
      )
      // Alguien entra o sale: la lista de miembros y, si soy yo, el acceso.
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'event_participants', filter: `event_id=eq.${eventId}` },
        () => recheckAccess(),
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setConnection('online');
          if (wasDown) void catchUpRef.current();
          wasDown = false;
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setConnection('offline');
          wasDown = true;
        }
      });

    return () => {
      if (recheckTimer.current) clearTimeout(recheckTimer.current);
      supabase.removeChannel(channel);
    };
  }, [phase, eventId, recheckAccess]);

  useEffect(() => {
    const up = () => { setOnline(true); void catchUpRef.current(); };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  // "Lo estoy viendo": sin push de este chat mientras la pantalla esté abierta.
  useEffect(() => {
    if (phase !== 'ready' || !eventId) return;
    const set = (active: boolean) => {
      void supabase.rpc('set_event_chat_presence', { _event_id: eventId, _active: active });
    };
    const beat = () => { if (document.visibilityState === 'visible') set(true); };
    beat();
    const id = setInterval(beat, PRESENCE_MS);
    const recheck = setInterval(recheckAccess, RECHECK_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        beat();
        recheckAccess();
        void catchUpRef.current();
      } else {
        set(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(id);
      clearInterval(recheck);
      document.removeEventListener('visibilitychange', onVisibility);
      set(false);
      // Al salir, los contadores de la barra ya saben que se leyó.
      refreshCounts();
    };
  }, [phase, eventId, recheckAccess, refreshCounts]);

  // Leer lo que llega mientras miras (con pausa, para no llamar por mensaje).
  const newestOther = [...messages].reverse().find((m) => m.sender_id !== myId && !m.state)?.id;
  useEffect(() => {
    if (phase !== 'ready' || !eventId || !newestOther) return;
    if (document.visibilityState !== 'visible' || !atBottomRef.current) return;
    const timer = setTimeout(async () => {
      await supabase.rpc('mark_event_chat_read', { _event_id: eventId });
      refreshCounts();
    }, 800);
    return () => clearTimeout(timer);
  }, [phase, eventId, newestOther, refreshCounts]);

  // ------------------------------------------------------------ scroll

  const scrollToBottom = (smooth = true) => {
    const el = listRef.current;
    if (!el) return;
    if (smooth && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
    setNewBelow(0);
  };

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottomRef.current) setNewBelow(0);
  };

  const unreadIndex = useMemo(
    () => firstUnreadIndex(messages, unreadMarker, myId),
    [messages, unreadMarker, myId],
  );

  // Al abrir: a la raya de "nuevos" si hay, si no al final. Después, solo se
  // baja sola la lista si ya estabas abajo o el mensaje es tuyo; si estabas
  // leyendo arriba, aparece el aviso de "mensajes nuevos".
  useLayoutEffect(() => {
    if (phase !== 'ready') return;
    const last = messages[messages.length - 1];
    const lastId = last?.id ?? null;
    if (lastId === lastIdRef.current) return;
    const grewAtBottom = lastIdRef.current !== null;
    lastIdRef.current = lastId;

    if (firstPaintRef.current) {
      firstPaintRef.current = false;
      const marker = unreadIndex >= 0 ? document.getElementById('event-chat-unread') : null;
      if (marker) marker.scrollIntoView?.({ block: 'center' });
      else scrollToBottom(false);
      return;
    }
    if (!grewAtBottom || !last) return;
    if (atBottomRef.current || last.sender_id === myId) scrollToBottom(true);
    else setNewBelow((n) => n + 1);
  }, [messages, phase, unreadIndex, myId]);

  // Con el teclado abierto, que lo último siga a la vista.
  useEffect(() => {
    if (keyboard > 0 && atBottomRef.current) requestAnimationFrame(() => scrollToBottom(false));
  }, [keyboard]);

  // ------------------------------------------------------------ escribir

  const autoGrow = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  };
  useLayoutEffect(autoGrow, [text]);

  const onTextChange = (value: string, caret: number) => {
    setText(value.slice(0, MESSAGE_MAX_LENGTH));
    setMention(activeMentionQuery(value, caret));
  };

  const pickMention = (m: Mentionable) => {
    const el = inputRef.current;
    if (!mention || !el) return;
    const res = insertMention(text, mention.start, el.selectionStart ?? text.length, m);
    setText(res.text);
    setPicked((prev) => (prev.some((p) => p.id === m.id) ? prev : [...prev, m]));
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(res.caret, res.caret);
    });
  };

  const candidates = useMemo(
    () => (mention ? mentionCandidates(members.map((m) => ({ id: m.user_id, name: m.name })), mention.query, myId) : []),
    [mention, members, myId],
  );

  const deliver = async (msg: EventChatMessage) => {
    if (!eventId || !user) return;
    setMessages((prev) => mergeMessages(prev, [{ ...msg, state: 'sending' }]));
    const { data, error } = await supabase
      .from('messages')
      .insert({
        id: msg.id,
        event_id: eventId,
        sender_id: user.id,
        content: msg.content,
        mentions: msg.mentions,
        is_announcement: msg.is_announcement,
      })
      .select(EVENT_MESSAGE_COLUMNS)
      .single();

    if (!error && data) {
      setMessages((prev) => mergeMessages(prev, [toChatMessage(data)]));
      return;
    }

    // 23505: el primer intento sí llegó (se cortó la respuesta, no el envío).
    // Reintentar con el mismo id no duplica: se recoge la fila que ya existe.
    if (error?.code === '23505') {
      const { data: existing } = await supabase.from('messages').select(EVENT_MESSAGE_COLUMNS).eq('id', msg.id).maybeSingle();
      if (existing) {
        setMessages((prev) => mergeMessages(prev, [toChatMessage(existing)]));
        return;
      }
    }

    setMessages((prev) => setSendState(prev, msg.id, 'failed'));
    // La RLS dice que no: probablemente ya no estás en la actividad.
    if (error?.code === '42501') recheckAccess();
    toast({
      title: t('eventChat.sendFailed'),
      description: error?.message ? rpcMessage(error.message, t) : t('eventChat.checkConnection'),
      variant: 'destructive',
    });
  };

  const send = () => {
    if (editing) { void saveEdit(); return; }
    const content = text.trim();
    if (!content || !user) return;
    const msg: EventChatMessage = {
      id: newMessageId(),
      content,
      created_at: new Date().toISOString(),
      sender_id: user.id,
      edited_at: null,
      deleted_at: null,
      deleted_by: null,
      mentions: mentionIdsInText(content, picked),
      is_announcement: announce && isOrganizer,
      state: 'sending',
    };
    setText('');
    setPicked([]);
    setMention(null);
    setAnnounce(false);
    atBottomRef.current = true;
    void deliver(msg);
  };

  const retry = (msg: EventChatMessage) => void deliver(msg);
  const discard = (msg: EventChatMessage) => setMessages((prev) => dropMessage(prev, msg.id));

  const startEditing = (msg: EventChatMessage) => {
    draftBeforeEditRef.current = editing ? draftBeforeEditRef.current : text;
    setEditing({ id: msg.id, original: msg.content });
    setText(msg.content);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const cancelEditing = () => {
    setEditing(null);
    setText(draftBeforeEditRef.current);
    draftBeforeEditRef.current = '';
  };

  const saveEdit = async () => {
    if (!editing) return;
    const msg = messages.find((m) => m.id === editing.id);
    if (!msg || !canSaveEdit(editing.original, text)) {
      if (msg && text.trim() === editing.original.trim()) cancelEditing();
      return;
    }
    const content = text.trim();
    const before = msg;
    setMessages((prev) => mergeMessages(prev, [{ ...msg, content, edited_at: new Date().toISOString(), state: 'sent' }]));
    setEditing(null);
    setText(draftBeforeEditRef.current);
    draftBeforeEditRef.current = '';
    const { data, error } = await supabase
      .from('messages')
      .update({ content })
      .eq('id', msg.id)
      .select(EVENT_MESSAGE_COLUMNS)
      .single();
    if (error || !data) {
      setMessages((prev) => mergeMessages(dropMessage(prev, before.id), [before]));
      toast({ title: t('chat.editFailed'), description: error ? rpcMessage(error.message, t) : undefined, variant: 'destructive' });
      return;
    }
    setMessages((prev) => mergeMessages(prev, [toChatMessage(data)]));
  };

  const deleteOwn = async (msg: EventChatMessage) => {
    if (editing?.id === msg.id) cancelEditing();
    const { data, error } = await supabase
      .from('messages')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', msg.id)
      .select(EVENT_MESSAGE_COLUMNS)
      .single();
    if (error || !data) {
      toast({ title: t('chat.deleteFailed'), description: error ? rpcMessage(error.message, t) : undefined, variant: 'destructive' });
      return;
    }
    setMessages((prev) => mergeMessages(prev, [toChatMessage(data)]));
  };

  const moderate = async (msg: EventChatMessage) => {
    setModerating(null);
    const { error } = await supabase.rpc('moderate_event_message', { _message_id: msg.id });
    if (error) {
      toast({ title: t('chat.deleteFailed'), description: rpcMessage(error.message, t), variant: 'destructive' });
      return;
    }
    // Llega también por tiempo real; esto es para que se vea ya.
    setMessages((prev) => mergeMessages(prev, [{ ...msg, content: '', deleted_at: new Date().toISOString(), deleted_by: myId, state: undefined }]));
    toast({ title: t('eventChat.messageRemoved') });
  };

  const toggleMute = async () => {
    if (!eventId || !summary) return;
    const muted = !summary.muted;
    setSummary({ ...summary, muted });
    const { error } = await supabase.rpc('set_event_chat_muted', { _event_id: eventId, _muted: muted });
    if (error) {
      setSummary({ ...summary });
      toast({ title: t('common.error'), description: rpcMessage(error.message, t), variant: 'destructive' });
      return;
    }
    toast({ title: muted ? t('eventChat.mutedToast') : t('eventChat.unmutedToast') });
  };

  const goBack = () => {
    // Si se entró desde una notificación no hay historial al que volver.
    if (location.key === 'default') navigate('/events');
    else navigate(-1);
  };

  // ------------------------------------------------------------ pintar

  const formatDay = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (dayKey(iso) === dayKey(today.toISOString())) return t('eventChat.today');
    if (dayKey(iso) === dayKey(yesterday.toISOString())) return t('chat.yesterday');
    return new Intl.DateTimeFormat(dateLocale, { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  };
  const formatTime = (iso: string) =>
    new Intl.DateTimeFormat(dateLocale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

  const offline = !online || connection === 'offline';
  // Con el teclado abierto el chat se pega a lo que se ve (fijo, del alto del
  // visualViewport); cerrado, ocupa el hueco normal sobre la barra inferior.
  const keyboardOpen = keyboard > 0 && visible.height > 0;
  const shellClass = keyboardOpen
    ? 'fixed inset-x-0 mx-auto sm:max-w-[430px] z-[55] flex flex-col overflow-hidden bg-background'
    : 'flex flex-col h-screen-nav overflow-hidden bg-background';
  const shellStyle = keyboardOpen ? { top: visible.top, height: visible.height } : undefined;

  const header = (
    <div className="flex items-center gap-2 px-4 pb-3 bg-card border-b border-border shrink-0 pt-[calc(1rem+env(safe-area-inset-top,0px))]">
      <button onClick={goBack} className="p-3 -m-2 text-muted-foreground" aria-label={t('common.back')}>
        <ArrowLeft className="w-5 h-5" />
      </button>
      <div className="flex-1 min-w-0 ml-1">
        <h1 className="font-bold text-foreground truncate">{event?.title ?? t('eventChat.title')}</h1>
        {phase === 'ready' && summary && (
          <p className="text-xs text-muted-foreground truncate">
            {t('eventChat.subtitle')}
            {' · '}
            {summary.member_count === 1
              ? t('eventChat.memberOne')
              : t('eventChat.memberOther', { count: summary.member_count })}
          </p>
        )}
      </div>
      {phase === 'ready' && summary && (
        <>
          <button
            onClick={toggleMute}
            aria-pressed={summary.muted}
            aria-label={summary.muted ? t('eventChat.unmute') : t('eventChat.mute')}
            className="w-11 h-11 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {summary.muted ? <BellOff className="w-5 h-5" /> : <Bell className="w-5 h-5" />}
          </button>
          <button
            onClick={() => { void loadMembers(); setMembersOpen(true); }}
            aria-label={t('eventChat.members')}
            className="w-11 h-11 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Users className="w-5 h-5" />
          </button>
        </>
      )}
    </div>
  );

  if (phase === 'loading') {
    return (
      <div className="flex flex-col h-screen-nav overflow-hidden bg-background">
        {header}
        <div className="flex-1 px-4 py-4 space-y-3" aria-busy="true" aria-label={t('common.loading')}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={cn('flex', i % 2 ? 'justify-end' : 'justify-start')}>
              <Skeleton className={cn('h-10 rounded-2xl', i % 2 ? 'w-40' : 'w-56')} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (phase === 'no-access' || phase === 'error') {
    const removed = phase === 'no-access' && summary?.removed;
    return (
      <div className="flex flex-col h-screen-nav overflow-hidden bg-background">
        {header}
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-3">
          {phase === 'error' ? (
            <AlertCircle className="w-12 h-12 text-muted-foreground/50" aria-hidden="true" />
          ) : (
            <Lock className="w-12 h-12 text-muted-foreground/50" aria-hidden="true" />
          )}
          <p className="text-base font-semibold text-foreground">
            {phase === 'error' ? t('eventChat.loadError') : removed ? t('eventChat.removedTitle') : t('eventChat.noAccessTitle')}
          </p>
          <p className="text-sm text-muted-foreground">
            {phase === 'error' ? t('eventChat.checkConnection') : removed ? t('eventChat.removedDesc') : t('eventChat.noAccessDesc')}
          </p>
          <Button variant="outline" className="mt-2 rounded-xl" onClick={goBack}>{t('common.back')}</Button>
        </div>
      </div>
    );
  }

  let lastDay = '';
  const editable = editing ? canSaveEdit(editing.original, text) : Boolean(text.trim());

  return (
    <div className={shellClass} style={shellStyle}>
      {header}

      {(offline || (event && !event.is_active)) && (
        <div role="status" className="shrink-0 flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-muted text-muted-foreground">
          {offline ? <WifiOff className="w-3.5 h-3.5" aria-hidden="true" /> : <AlertCircle className="w-3.5 h-3.5" aria-hidden="true" />}
          {offline ? t('eventChat.offline') : t('eventChat.cancelledBanner')}
        </div>
      )}

      <div className="relative flex-1 min-h-0">
        <div
          ref={listRef}
          onScroll={onScroll}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label={t('eventChat.messagesLabel')}
          className="h-full overflow-y-auto overscroll-contain px-4 py-3"
        >
          {hasOlder && (
            <button
              onClick={loadOlder}
              disabled={loadingOlder}
              className="w-full min-h-[44px] text-xs font-semibold text-muted-foreground disabled:opacity-50"
            >
              {loadingOlder ? t('common.loading') : t('groups.loadOlder')}
            </button>
          )}

          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center text-center py-16 px-6 gap-2">
              <MessagesSquare className="w-12 h-12 text-muted-foreground/40" aria-hidden="true" />
              <p className="text-sm font-semibold text-foreground">{t('eventChat.emptyTitle')}</p>
              <p className="text-sm text-muted-foreground">{t('eventChat.emptyDesc')}</p>
            </div>
          )}

          <ul className="space-y-2">
            {messages.map((msg, i) => {
              const isMe = msg.sender_id === myId;
              const prev = messages[i - 1];
              const day = dayKey(msg.created_at);
              const showDay = day !== lastDay;
              lastDay = day;
              const grouped = !showDay && prev && prev.sender_id === msg.sender_id && !prev.is_announcement && !msg.is_announcement;
              const senderName = nameOf(msg.sender_id) ?? t('profile.student');
              const isDeleted = Boolean(msg.deleted_at);
              const removedByOrganizer = isDeleted && msg.deleted_by && msg.deleted_by !== msg.sender_id;
              const mentionsMe = msg.mentions.includes(myId);

              return (
                <li key={msg.id} className="list-none">
                  {showDay && (
                    <div className="flex justify-center my-3" role="separator">
                      <span className="px-3 py-1 rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
                        {formatDay(msg.created_at)}
                      </span>
                    </div>
                  )}
                  {i === unreadIndex && (
                    <div id="event-chat-unread" className="flex items-center gap-2 my-3" role="separator">
                      <span className="flex-1 h-px bg-primary/40" />
                      <span className="text-[11px] font-bold text-primary uppercase tracking-wide">{t('eventChat.newMessages')}</span>
                      <span className="flex-1 h-px bg-primary/40" />
                    </div>
                  )}

                  <div className={cn('flex gap-2', isMe ? 'justify-end' : 'justify-start', grouped ? 'mt-0.5' : 'mt-2')}>
                    {!isMe && (
                      <div className="w-8 shrink-0">
                        {!grouped && (
                          <UserAvatar
                            url={avatarOf(msg.sender_id)}
                            name={senderName}
                            className="w-8 h-8 bg-muted"
                            textClassName="text-xs font-bold text-muted-foreground"
                          />
                        )}
                      </div>
                    )}

                    <div className={cn('flex flex-col max-w-[78%]', isMe ? 'items-end' : 'items-start')}>
                      {!isMe && !grouped && (
                        <span className="text-xs font-semibold text-muted-foreground px-1 mb-0.5">
                          {senderName}
                          {memberById.get(msg.sender_id)?.is_organizer && (
                            <span className="ml-1 text-primary">· {t('event.organizer')}</span>
                          )}
                        </span>
                      )}

                      <div className="flex items-center gap-1">
                        {isDeleted ? (
                          <div className="px-3.5 py-2 rounded-2xl text-sm italic border border-border text-muted-foreground">
                            {removedByOrganizer ? t('eventChat.removedByOrganizer') : t('chat.deleted')}
                          </div>
                        ) : (
                          <>
                            <div
                              className={cn(
                                'px-3.5 py-2 rounded-2xl text-sm break-words whitespace-pre-wrap',
                                msg.is_announcement
                                  ? 'bg-warning/15 text-foreground border border-warning/40'
                                  : isMe
                                    ? 'bg-primary text-primary-foreground order-1'
                                    : 'bg-muted text-foreground',
                                isMe ? 'rounded-br-sm' : 'rounded-bl-sm',
                                mentionsMe && !isMe && 'ring-2 ring-primary/50',
                                editing?.id === msg.id && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
                                msg.state === 'sending' && 'opacity-70',
                              )}
                            >
                              {msg.is_announcement && (
                                <span className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-warning mb-0.5">
                                  <Megaphone className="w-3 h-3" aria-hidden="true" />
                                  {t('eventChat.announcement')}
                                </span>
                              )}
                              {splitMentions(msg.content, msg.mentions, namesForMentions).map((part, k) =>
                                part.mention ? (
                                  <span
                                    key={k}
                                    className={cn('font-semibold', isMe && !msg.is_announcement ? 'underline' : 'text-primary')}
                                  >
                                    {part.text}
                                  </span>
                                ) : (
                                  <span key={k}>{part.text}</span>
                                ),
                              )}
                            </div>
                            {msg.state === undefined || msg.state === 'sent' ? (
                              isMe ? (
                                <MessageActionsMenu onEdit={() => startEditing(msg)} onDelete={() => deleteOwn(msg)} className="p-1 shrink-0" />
                              ) : isOrganizer ? (
                                <button
                                  onClick={() => setModerating(msg)}
                                  aria-label={t('eventChat.removeMessage', { name: senderName })}
                                  className="w-11 h-11 -m-2 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              ) : (
                                <ModerationMenu
                                  target={{ kind: 'message', id: msg.id }}
                                  label={senderName}
                                  blockUserId={msg.sender_id}
                                  onBlocked={() => setMessages((prev) => prev.filter((m) => m.sender_id !== msg.sender_id))}
                                  className="p-1 shrink-0"
                                />
                              )
                            ) : null}
                          </>
                        )}
                      </div>

                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground px-1 mt-0.5">
                        {formatTime(msg.created_at)}
                        {msg.edited_at && !isDeleted && ` · ${t('chat.edited')}`}
                        {isMe && msg.state === 'sending' && (
                          <span className="inline-flex items-center gap-0.5">
                            · <Clock className="w-3 h-3" aria-hidden="true" /> {t('eventChat.sending')}
                          </span>
                        )}
                        {isMe && (msg.state === undefined || msg.state === 'sent') && !isDeleted && (
                          <Check className="w-3 h-3" aria-label={t('eventChat.sent')} />
                        )}
                      </span>

                      {isMe && msg.state === 'failed' && (
                        <div className="flex items-center gap-1 mt-1" role="alert">
                          <AlertCircle className="w-3.5 h-3.5 text-destructive" aria-hidden="true" />
                          <span className="text-xs font-semibold text-destructive">{t('eventChat.notSent')}</span>
                          <button
                            onClick={() => retry(msg)}
                            className="inline-flex items-center gap-1 min-h-[44px] px-2 text-xs font-bold text-primary"
                          >
                            <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
                            {t('eventChat.retry')}
                          </button>
                          <button
                            onClick={() => discard(msg)}
                            className="min-h-[44px] px-2 text-xs font-semibold text-muted-foreground"
                          >
                            {t('eventChat.discard')}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {newBelow > 0 && (
          <button
            onClick={() => scrollToBottom(true)}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 min-h-[40px] px-4 rounded-full bg-primary text-primary-foreground text-xs font-bold shadow-lifted"
          >
            <ArrowDown className="w-3.5 h-3.5" aria-hidden="true" />
            {newBelow === 1 ? t('eventChat.newBelowOne') : t('eventChat.newBelowOther', { count: newBelow })}
          </button>
        )}
      </div>

      {/* Escribir. Al editar se reutiliza el campo, con una franja encima. */}
      <div className="bg-background border-t border-border shrink-0">
        {candidates.length > 0 && (
          <ul role="listbox" aria-label={t('eventChat.mentionList')} className="max-h-48 overflow-y-auto border-b border-border">
            {candidates.map((c) => {
              const m = memberById.get(c.id);
              return (
                <li key={c.id} role="option" aria-selected="false">
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickMention(c)}
                    className="w-full flex items-center gap-3 px-4 min-h-[44px] text-left hover:bg-muted"
                  >
                    <UserAvatar url={m?.avatar_url} name={c.name} className="w-7 h-7 bg-muted" textClassName="text-xs text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground truncate">{c.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {editing && (
          <div className="flex items-center gap-2 pl-4 pr-2 pt-2 text-xs font-semibold text-primary">
            <Pencil className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="flex-1 min-w-0 truncate">{t('chat.editing')}</span>
            <button
              onClick={cancelEditing}
              aria-label={t('chat.cancelEdit')}
              className="w-11 h-11 -my-2 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {isOrganizer && !editing && announce && (
          <p className="px-4 pt-2 text-xs font-semibold text-warning flex items-center gap-1.5">
            <Megaphone className="w-3.5 h-3.5" aria-hidden="true" />
            {t('eventChat.announceHint')}
          </p>
        )}

        <div className="flex items-end gap-2 px-4 py-3">
          {isOrganizer && !editing && (
            <button
              onClick={() => setAnnounce((a) => !a)}
              aria-pressed={announce}
              aria-label={t('eventChat.announceToggle')}
              className={cn(
                'w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-xl border transition-colors',
                announce ? 'bg-warning/15 border-warning/50 text-foreground' : 'border-border text-muted-foreground',
              )}
            >
              <Megaphone className="w-4 h-4" />
            </button>
          )}
          <label htmlFor="event-chat-input" className="sr-only">{t('eventChat.inputLabel')}</label>
          <textarea
            id="event-chat-input"
            ref={inputRef}
            value={text}
            rows={1}
            maxLength={MESSAGE_MAX_LENGTH}
            enterKeyHint="send"
            onChange={(e) => onTextChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onSelect={(e) => setMention(activeMentionQuery(text, e.currentTarget.selectionStart ?? text.length))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
              if (e.key === 'Escape') {
                if (mention) setMention(null);
                else if (editing) cancelEditing();
              }
            }}
            placeholder={t('eventChat.placeholder')}
            className="flex-1 min-h-[44px] max-h-[132px] resize-none rounded-xl border border-input bg-background px-3 py-2.5 text-[16px] leading-snug ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button
            onClick={send}
            disabled={!editable}
            size="icon"
            aria-label={editing ? t('chat.save') : t('groups.send')}
            className="h-11 w-11 rounded-xl shrink-0"
          >
            {editing ? <Check className="w-4 h-4" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
        {text.length > MESSAGE_MAX_LENGTH - 200 && (
          <p className="px-4 -mt-2 pb-2 text-right text-[11px] text-muted-foreground" aria-live="polite">
            {text.length}/{MESSAGE_MAX_LENGTH}
          </p>
        )}
      </div>

      {eventId && (
        <EventChatMembersSheet
          open={membersOpen}
          onOpenChange={setMembersOpen}
          eventId={eventId}
          members={members}
          myId={myId}
          isOrganizer={isOrganizer}
          muted={Boolean(summary?.muted)}
          onToggleMute={toggleMute}
          onChanged={() => { void loadMembers(); void loadSummary(); }}
        />
      )}

      <AlertDialog open={moderating !== null} onOpenChange={(o) => !o && setModerating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('eventChat.removeMessageTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('eventChat.removeMessageDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => moderating && moderate(moderating)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('chat.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
