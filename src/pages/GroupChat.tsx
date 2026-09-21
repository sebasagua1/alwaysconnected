import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useNotificationStore } from '@/stores/notificationStore';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Send, Users, UserPlus, LogOut, Check, X, Pencil } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { UserAvatar } from '@/components/ui/user-avatar';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks/use-toast';
import i18n from '@/i18n';
import { rpcMessage } from '@/lib/rpcErrors';
import { ModerationMenu } from '@/components/moderation/ModerationMenu';
import { MessageActionsMenu } from '@/components/chat/MessageActionsMenu';
import { applyMessageChange, canSaveEdit, type MessageChange } from '@/lib/chat';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

/** Mensajes por tanda. Suficiente para llenar la pantalla y poco que pintar. */
const MESSAGE_PAGE = 40;

/** Lo que se pide de cada mensaje, en todas las consultas. */
const MESSAGE_COLUMNS = 'id, content, created_at, sender_id, edited_at, deleted_at';

type MessageRow = {
  id: string;
  content: string;
  created_at: string;
  sender_id: string;
  edited_at: string | null;
  deleted_at: string | null;
};

interface Message extends MessageRow {
  senderName: string;
}

export default function GroupChat() {
  const { id: groupId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuthStore();
  const { t } = useTranslation();
  const { toast } = useToast();
  const [groupName, setGroupName] = useState('');
  const [isDM, setIsDM] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  /** Mensaje propio que se está editando, con su texto de antes. */
  const [editing, setEditing] = useState<{ id: string; original: string } | null>(null);
  /** Lo escrito antes de empezar a editar, para devolverlo al cancelar. */
  const draftBeforeEditRef = useRef('');
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Si la vista está pegada al final. Empieza en true porque el chat abre
  // abajo. Se actualiza al hacer scroll y lo consulta el efecto que decide si
  // bajar cuando entra un mensaje nuevo. Es un ref y no un estado a propósito:
  // cambia en cada frame de scroll y no debe repintar nada.
  const atBottomRef = useRef(true);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /**
   * Nombre de cada remitente, cacheado.
   *
   * Sin esto, cada mensaje que llegaba por tiempo real disparaba una consulta
   * para preguntar un nombre que ya estaba en pantalla. En un chat animado eso
   * es una petición por mensaje.
   */
  const nameCacheRef = useRef<Map<string, string>>(new Map());
  /** Para saber si la lista creció por abajo (mensaje nuevo) o por arriba. */
  const lastIdRef = useRef<string | null>(null);

  // Members sheet state
  const [membersOpen, setMembersOpen] = useState(false);
  const [members, setMembers] = useState<{ id: string; name: string | null; avatar_url: string | null }[]>([]);
  const [friends, setFriends] = useState<{ id: string; name: string | null; avatar_url: string | null }[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [addingMember, setAddingMember] = useState<string | null>(null);

  useEffect(() => {
    if (!groupId || !user) return;
    supabase.from('groups').select('name').eq('id', groupId).single()
      .then(async ({ data }) => {
        if (!data) return;
        // DM groups use a deterministic internal name — resolve the other person's display name
        if (data.name.startsWith('__dm_')) {
          setIsDM(true);
          const parts = data.name.replace('__dm_', '').split('_');
          const otherId = parts.find((p) => p !== user.id);
          if (otherId) {
            const { data: profile } = await supabase
              .from('public_profiles')
              .select('name')
              .eq('id', otherId)
              .maybeSingle();
            setGroupName(profile?.name ?? t('groups.directMessage'));
          }
        } else {
          setGroupName(data.name);
        }
      });
  }, [groupId, user, t]);

  const enrichMessages = async (
    msgs: MessageRow[]
  ): Promise<Message[]> => {
    if (msgs.length === 0) return [];
    const cache = nameCacheRef.current;
    const faltan = [...new Set(msgs.map((m) => m.sender_id))].filter((id) => !cache.has(id));

    if (faltan.length > 0) {
      const { data: profiles } = await supabase
        .from('public_profiles')
        .select('id, name')
        .in('id', faltan);
      (profiles ?? []).forEach((pr) => { if (pr.id) cache.set(pr.id, pr.name ?? '?'); });
      // Quien no vuelve —bloqueado, o de otra institución— se marca igualmente:
      // si no, se volvería a preguntar por él con cada mensaje suyo.
      faltan.forEach((id) => { if (!cache.has(id)) cache.set(id, '?'); });
    }

    return msgs.map((m) => ({ ...m, senderName: cache.get(m.sender_id) ?? '?' }));
  };

  // Los ÚLTIMOS mensajes, no todos.
  //
  // Antes se pedía el chat entero ordenado de más viejo a más nuevo y sin
  // límite. Supabase corta en 1.000 filas, así que al pasar de ahí devolvía
  // los 1.000 MÁS VIEJOS y los recientes dejaban de verse: el fallo ocurría
  // justo al revés de como uno lo esperaría, y en los chats más usados.
  //
  // Se piden del más nuevo hacia atrás —que es lo que sirve el índice
  // (group_id, created_at DESC)— y se le da la vuelta para pintarlos.
  useEffect(() => {
    if (!groupId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('messages')
        .select(MESSAGE_COLUMNS)
        .eq('group_id', groupId)
        .order('created_at', { ascending: false })
        .limit(MESSAGE_PAGE);
      if (cancelled) return;
      // Un chat vacío por error de red es indistinguible de uno sin mensajes.
      if (error) {
        toast({ title: i18n.t('errors.messagesLoad'), variant: 'destructive' });
        return;
      }
      const filas = (data ?? []).slice().reverse();
      const enriquecidos = await enrichMessages(filas);
      if (cancelled) return;
      // Al cambiar de chat se olvida por dónde iba el desplazamiento.
      lastIdRef.current = null;
      setMessages(enriquecidos);
      setHasOlder((data?.length ?? 0) === MESSAGE_PAGE);
    })();
    return () => { cancelled = true; };
  }, [groupId, toast]);

  /**
   * Los anteriores a los que ya hay.
   *
   * El cursor va sobre `created_at`. Dos mensajes solo empatarían si se
   * insertaran en la misma transacción, y aquí cada uno es una acción distinta
   * de una persona. Aun así se descartan duplicados por id al unir.
   */
  const loadOlder = async () => {
    if (!groupId || loadingOlder || messages.length === 0) return;
    setLoadingOlder(true);
    try {
      const { data, error } = await supabase
        .from('messages')
        .select(MESSAGE_COLUMNS)
        .eq('group_id', groupId)
        .lt('created_at', messages[0].created_at)
        .order('created_at', { ascending: false })
        .limit(MESSAGE_PAGE);
      if (error) {
        toast({ title: i18n.t('errors.messagesLoad'), variant: 'destructive' });
        return;
      }
      setHasOlder((data?.length ?? 0) === MESSAGE_PAGE);
      const filas = (data ?? []).slice().reverse();
      if (filas.length === 0) return;
      const enriquecidos = await enrichMessages(filas);
      setMessages((prev) => {
        const vistos = new Set(prev.map((m) => m.id));
        return [...enriquecidos.filter((m) => !vistos.has(m.id)), ...prev];
      });
    } finally {
      setLoadingOlder(false);
    }
  };

  // Bajar del todo solo cuando la lista crece por ABAJO. Al cargar mensajes
  // anteriores crece por arriba, y saltar al final ahí tiraría de la pantalla
  // justo a quien está leyendo hacia atrás.
  //
  // Y tampoco basta con eso: si estás leyendo hacia arriba y alguien escribe,
  // la lista crece por abajo igual, y saltar al final te arrancaba de donde
  // estabas leyendo. Así que solo se baja si ya estabas abajo —o si el mensaje
  // es tuyo, que entonces sí quieres verlo salir.
  useEffect(() => {
    const ultimo = messages[messages.length - 1];
    const ultimoId = ultimo?.id ?? null;
    if (ultimoId === lastIdRef.current) return;
    const esLaPrimera = lastIdRef.current === null;
    lastIdRef.current = ultimoId;

    const esMio = ultimo?.sender_id === user?.id;
    if (!esLaPrimera && !esMio && !atBottomRef.current) return;

    bottomRef.current?.scrollIntoView({ behavior: esLaPrimera ? 'auto' : 'smooth' });
  }, [messages, user?.id]);

  // Estar en el chat cuenta como haberlo leído, también si llega algo mientras
  // lo tienes abierto. Marcar leído es un UPDATE sobre group_members, que no
  // emite realtime, así que hay que pedir el recuento a mano después.
  //
  // Depende del id del último mensaje y no de cuántos hay: con la paginación,
  // cargar mensajes anteriores cambia la longitud sin que haya nada nuevo que
  // marcar, y disparaba una RPC de balde.
  const newestId = messages[messages.length - 1]?.id;
  useEffect(() => {
    if (!groupId || !newestId) return;
    let cancelled = false;
    (async () => {
      await supabase.rpc('mark_group_read', { _group_id: groupId });
      if (!cancelled) useNotificationStore.getState().refresh();
    })();
    return () => { cancelled = true; };
  }, [groupId, newestId]);

  useEffect(() => {
    if (!groupId) return;
    const channel = supabase
      .channel(`group-chat-${groupId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `group_id=eq.${groupId}` },
        async (payload) => {
          const raw = payload.new as MessageRow;
          const [enriched] = await enrichMessages([raw]);
          // Puede llegar un mensaje que ya pintamos como eco local al enviarlo.
          setMessages((prev) => (prev.some((m) => m.id === raw.id) ? prev : [...prev, enriched]));
        }
      )
      // Ediciones y borrados, propios (desde otro dispositivo) o de otros.
      // La RLS de SELECT sigue decidiendo qué filas llegan, igual que con
      // los INSERT.
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `group_id=eq.${groupId}` },
        (payload) => {
          const change = payload.new as MessageChange;
          setMessages((prev) => applyMessageChange(prev, change));
          // Si lo borraron mientras se editaba (desde otro dispositivo), la
          // edición ya no tiene nada que guardar.
          if (change.deleted_at) {
            setEditing((cur) => (cur?.id === change.id ? null : cur));
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [groupId]);

  const loadMembers = async () => {
    if (!groupId || !user) return;
    setLoadingMembers(true);
    try {
      const { data: memberRows } = await supabase
        .from('group_members')
        .select('user_id')
        .eq('group_id', groupId);

      const memberIds = memberRows?.map((r) => r.user_id) ?? [];
      const { data: profiles } = await supabase
        .from('public_profiles')
        .select('id, name, avatar_url')
        .in('id', memberIds);
      setMembers((profiles ?? []).map((p) => ({ id: p.id ?? '', name: p.name, avatar_url: p.avatar_url })));

      // Friends not already in the group
      const { data: accepted } = await supabase
        .from('friendships')
        .select('requester_id, addressee_id')
        .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`)
        .eq('status', 'accepted');

      const friendIds = (accepted ?? [])
        .map((f) => (f.requester_id === user.id ? f.addressee_id : f.requester_id))
        .filter((id) => !memberIds.includes(id));

      if (friendIds.length > 0) {
        const { data: friendProfiles } = await supabase
          .from('public_profiles')
          .select('id, name, avatar_url')
          .in('id', friendIds);
        setFriends((friendProfiles ?? []).map((p) => ({ id: p.id ?? '', name: p.name, avatar_url: p.avatar_url })));
      } else {
        setFriends([]);
      }
    } finally {
      setLoadingMembers(false);
    }
  };

  const handleAddMember = async (friendId: string) => {
    if (!groupId) return;
    setAddingMember(friendId);
    // add_group_member() valida en el servidor que quien invita ya sea
    // miembro y que la persona invitada sea su amiga aceptada.
    const { error } = await supabase.rpc('add_group_member', {
      _group_id: groupId,
      _user_id: friendId,
    });
    if (error) {
      toast({ title: t('common.error'), description: rpcMessage(error.message, t), variant: 'destructive' });
    } else {
      toast({ title: t('groups.memberAdded') });
      setFriends((prev) => prev.filter((f) => f.id !== friendId));
      const added = friends.find((f) => f.id === friendId);
      if (added) setMembers((prev) => [...prev, added]);
    }
    setAddingMember(null);
  };

  /**
   * Volver a la pestaña de la que se vino.
   *
   * Antes iba siempre a Grupos, así que salir de un mensaje directo te
   * dejaba en la lista de grupos, que no es de donde venías.
   *
   * Se prefiere el `from` que manda quien abre el chat; si no hay —al
   * recargar, o si algún día se entra desde una notificación— se deduce del
   * tipo de conversación, que es la respuesta correcta casi siempre: un DM
   * pertenece a Amigos y un grupo a Grupos.
   */
  const goBack = () => {
    const from = (location.state as { from?: 'friends' | 'groups' } | null)?.from;
    navigate('/friends', { state: { tab: from ?? (isDM ? 'friends' : 'groups') } });
  };

  const handleLeaveGroup = async () => {
    if (!groupId || !user) return;
    const { error } = await supabase
      .from('group_members')
      .delete()
      .eq('group_id', groupId)
      .eq('user_id', user.id);
    // Antes se navegaba pase lo que pase. Si el borrado fallaba, la app te
    // decía que habías salido, te sacaba a la lista, y seguías dentro:
    // recibiendo mensajes y avisos de un grupo que creías haber dejado.
    if (error) {
      toast({ title: t('errors.leaveGroup'), description: error.message, variant: 'destructive' });
      return;
    }
    navigate('/friends', { state: { tab: 'groups' } });
  };

  const startEditing = (msg: Message) => {
    draftBeforeEditRef.current = editing ? draftBeforeEditRef.current : text;
    setEditing({ id: msg.id, original: msg.content });
    setText(msg.content);
    // Tras pintar el input con el texto: el foco abre el teclado en iOS.
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const cancelEditing = () => {
    setEditing(null);
    setText(draftBeforeEditRef.current);
    draftBeforeEditRef.current = '';
  };

  /** El error de la base, en algo que se entienda. */
  const changeErrorMessage = (error: { code?: string; message?: string }) =>
    // PGRST116 = la actualización no devolvió ninguna fila: la RLS la dejó
    // fuera (ya borrado, o ya no estás en el chat).
    error.code === 'PGRST116' ? t('chat.notEditable') : rpcMessage(error.message, t);

  const saveEdit = async () => {
    if (!editing || sending) return;
    const msg = messages.find((m) => m.id === editing.id);
    if (!msg || !canSaveEdit(editing.original, text)) {
      if (msg && text.trim() === editing.original.trim()) cancelEditing();
      return;
    }
    const content = text.trim();
    const before: MessageChange = { id: msg.id, content: msg.content, edited_at: msg.edited_at, deleted_at: msg.deleted_at };

    // Optimista: se ve al instante; si el servidor dice que no, se deshace.
    setSending(true);
    setMessages((prev) => applyMessageChange(prev, { ...before, content, edited_at: new Date().toISOString() }));
    setEditing(null);
    setText(draftBeforeEditRef.current);
    draftBeforeEditRef.current = '';

    // Solo se manda el texto: edited_at lo pone el disparador de la base.
    const { data, error } = await supabase
      .from('messages')
      .update({ content })
      .eq('id', msg.id)
      .select('id, content, edited_at, deleted_at')
      .single();

    if (error || !data) {
      setMessages((prev) => applyMessageChange(prev, before));
      toast({ title: t('chat.editFailed'), description: error ? changeErrorMessage(error) : undefined, variant: 'destructive' });
    } else {
      setMessages((prev) => applyMessageChange(prev, data));
    }
    setSending(false);
  };

  const deleteMessage = async (msg: Message) => {
    const before: MessageChange = { id: msg.id, content: msg.content, edited_at: msg.edited_at, deleted_at: msg.deleted_at };
    if (editing?.id === msg.id) cancelEditing();
    setMessages((prev) => applyMessageChange(prev, { ...before, content: '', deleted_at: new Date().toISOString() }));

    // Borrado lógico: la fila se queda. La base pone la fecha de verdad y
    // vacía el texto; lo que mande el cliente en deleted_at da igual.
    const { data, error } = await supabase
      .from('messages')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', msg.id)
      .select('id, content, edited_at, deleted_at')
      .single();

    if (error || !data) {
      setMessages((prev) => applyMessageChange(prev, before));
      toast({ title: t('chat.deleteFailed'), description: error ? changeErrorMessage(error) : undefined, variant: 'destructive' });
    } else {
      setMessages((prev) => applyMessageChange(prev, data));
    }
  };

  const sendMessage = async () => {
    if (editing) { saveEdit(); return; }
    if (!text.trim() || !user || !groupId || sending) return;
    const content = text.trim();
    setSending(true);
    setText('');

    const { data, error } = await supabase
      .from('messages')
      .insert({ group_id: groupId, sender_id: user.id, content })
      .select(MESSAGE_COLUMNS)
      .single();

    if (error) {
      // Devolver el texto al input: perderlo en silencio hacía creer que
      // el mensaje se había enviado.
      setText(content);
      toast({ title: t('groups.sendFailed'), description: error.message, variant: 'destructive' });
    } else if (data) {
      // Eco local inmediato; el handler de realtime descarta el duplicado por id.
      const [enriched] = await enrichMessages([data]);
      setMessages((prev) => (prev.some((m) => m.id === data.id) ? prev : [...prev, enriched]));
    }
    setSending(false);
  };

  return (
    <div className="flex flex-col h-screen-nav overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pb-3 bg-card border-b border-border shrink-0 pt-[calc(1rem+env(safe-area-inset-top,0px))]">
        <button
          onClick={goBack}
          className="p-3 -m-2 text-muted-foreground"
          aria-label={t('groups.backToGroups')}
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="font-bold text-foreground truncate flex-1">{groupName}</h1>
        {!isDM && (
          <button
            onClick={() => { loadMembers(); setMembersOpen(true); }}
            className="p-3 -m-2 text-muted-foreground"
            aria-label={t('groups.membersTitle')}
          >
            <Users className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Members sheet */}
      <Sheet open={membersOpen} onOpenChange={setMembersOpen}>
        <SheetContent side="right" className="w-[300px] sm:w-[360px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t('groups.membersTitle')}</SheetTitle>
          </SheetHeader>

          {loadingMembers ? (
            <p className="text-sm text-muted-foreground mt-4">{t('common.loading')}</p>
          ) : (
            <div className="mt-4 space-y-5">
              {/* Current members */}
              <div className="space-y-2">
                {members.map((m) => (
                  <div key={m.id} className="flex items-center gap-3 py-1">
                    <UserAvatar
                      url={m.avatar_url}
                      name={m.name}
                      className="w-8 h-8 bg-primary/10"
                      textClassName="text-xs text-primary"
                    />
                    <span className="text-sm font-medium text-foreground">{m.name}</span>
                    {m.id === user?.id && (
                      <span className="ml-auto text-xs text-muted-foreground">{t('groups.you')}</span>
                    )}
                  </div>
                ))}
              </div>

              {/* Invite friends */}
              {friends.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[13px] font-semibold text-muted-foreground">
                    {t('groups.inviteFriends')}
                  </p>
                  {friends.map((f) => (
                    <div key={f.id} className="flex items-center gap-3 py-1">
                      <UserAvatar
                        url={f.avatar_url}
                        name={f.name}
                        className="w-8 h-8 bg-muted"
                        textClassName="text-xs text-muted-foreground"
                      />
                      <span className="text-sm font-medium text-foreground flex-1">{f.name}</span>
                      <button
                        onClick={() => handleAddMember(f.id)}
                        disabled={addingMember === f.id}
                        className="w-11 h-11 shrink-0 flex items-center justify-center rounded-full bg-primary/10 text-primary disabled:opacity-50"
                        aria-label={`${t('groups.invite')} ${f.name}`}
                      >
                        <UserPlus className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Leave group */}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" className="w-full rounded-xl gap-2">
                    <LogOut className="w-4 h-4" />
                    {t('groups.leave')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('groups.leaveConfirmTitle')}</AlertDialogTitle>
                    <AlertDialogDescription>{t('groups.leaveConfirmDesc')}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleLeaveGroup}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {t('groups.leave')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Messages */}
      <div
        // role="log" + aria-live: un lector de pantalla lee los mensajes que
        // van entrando sin que haya que salir del campo de escribir. "polite"
        // para que espere a que la persona termine de teclear, y "additions"
        // para que no relea el historial entero cada vez.
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={t('groups.messages')}
        onScroll={(e) => {
          const el = e.currentTarget;
          // 64px de margen: pegado al final del todo es raro que se dé al
          // píxel, y con inercia en iOS menos todavía.
          atBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 64;
        }}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3"
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
          <p className="text-center text-sm text-muted-foreground py-12">{t('groups.noMessages')}</p>
        )}
        {messages.map((msg) => {
          const isMe = msg.sender_id === user?.id;
          const isDeleted = Boolean(msg.deleted_at);
          const isBeingEdited = editing?.id === msg.id;
          return (
            <div key={msg.id} className={cn('flex flex-col gap-0.5', isMe ? 'items-end' : 'items-start')}>
              {!isMe && (
                <span className="text-xs text-muted-foreground px-1">{msg.senderName}</span>
              )}
              <div className="flex items-center gap-1 max-w-[85%]">
                {isDeleted ? (
                  // Sin el texto (la base ya lo vació) y sin menú: no queda
                  // nada que editar, borrar ni reportar.
                  <div
                    className={cn(
                      'px-3.5 py-2 rounded-2xl text-sm italic border border-border text-muted-foreground',
                      isMe ? 'rounded-br-sm' : 'rounded-bl-sm'
                    )}
                  >
                    {t('chat.deleted')}
                  </div>
                ) : (
                  <>
                    <div
                      className={cn(
                        'px-3.5 py-2 rounded-2xl text-sm break-words',
                        isMe
                          ? 'bg-primary text-primary-foreground rounded-br-sm order-1'
                          : 'bg-muted text-foreground rounded-bl-sm',
                        isBeingEdited && 'ring-2 ring-ring ring-offset-2 ring-offset-background'
                      )}
                    >
                      {msg.content}
                    </div>
                    {isMe ? (
                      <MessageActionsMenu
                        onEdit={() => startEditing(msg)}
                        onDelete={() => deleteMessage(msg)}
                        className="p-1 shrink-0"
                      />
                    ) : (
                      <ModerationMenu
                        target={{ kind: 'message', id: msg.id }}
                        label={msg.senderName}
                        blockUserId={msg.sender_id}
                        onBlocked={() => setMessages((prev) => prev.filter((m) => m.sender_id !== msg.sender_id))}
                        className="p-1 shrink-0"
                      />
                    )}
                  </>
                )}
              </div>
              <span className="text-xs text-muted-foreground px-1">
                {format(new Date(msg.created_at), 'HH:mm')}
                {msg.edited_at && !isDeleted && ` · ${t('chat.edited')}`}
              </span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input. Al editar se reutiliza el mismo campo, con una franja encima
          que dice qué se está editando y cómo salir. */}
      <div className="bg-background border-t border-border shrink-0">
        {editing && (
          <div className="flex items-center gap-2 pl-4 pr-2 pt-2 text-xs font-semibold text-primary">
            <Pencil className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1 min-w-0 truncate">{t('chat.editing')}</span>
            <button
              onClick={cancelEditing}
              aria-label={t('chat.cancelEdit')}
              className="w-11 h-11 -my-2 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        <div className="flex gap-2 px-4 py-3">
          <Input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
              if (e.key === 'Escape' && editing) { e.preventDefault(); cancelEditing(); }
            }}
            placeholder={t('groups.messagePh')}
            // En iOS la tecla de retorno decía "intro"; con esto dice
            // "enviar", que es lo que hace realmente al pulsarla.
            enterKeyHint="send"
            className="h-11 rounded-xl"
          />
          <Button
            onClick={sendMessage}
            disabled={sending || (editing ? !canSaveEdit(editing.original, text) : !text.trim())}
            size="icon"
            aria-label={editing ? t('chat.save') : t('groups.send')}
            className="h-11 w-11 rounded-xl shrink-0"
          >
            {editing ? <Check className="w-4 h-4" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
