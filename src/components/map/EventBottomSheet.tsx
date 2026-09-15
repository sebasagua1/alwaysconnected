import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MapEvent, useEventStore } from '@/stores/eventStore';
import { EVENT_CATEGORIES } from '@/lib/constants';
import { Button } from '@/components/ui/button';
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
import { Clock, MapPin, Users, X, Loader2, Pencil, Star } from 'lucide-react';
import { CATEGORY_ICONS } from '@/lib/categoryIcons';
import { EditEventSheet } from '@/components/map/EditEventSheet';
import { useAuthStore } from '@/stores/authStore';
import { supabase } from '@/integrations/supabase/client';
import { getCurrentPosition } from '@/lib/geo';
import { useToast } from '@/hooks/use-toast';
import { ModerationMenu } from '@/components/moderation/ModerationMenu';
import { UserAvatar } from '@/components/ui/user-avatar';
import { UserProfileSheet } from '@/components/profile/UserProfileSheet';
import { rpcMessage } from '@/lib/rpcErrors';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { es as esLocale, enUS } from 'date-fns/locale';

/** Caras que se enseñan antes del "+N", contando a quien organiza. */
export const ATTENDEES_PREVIEW = 5;

interface Props {
  event: MapEvent;
  onClose: () => void;
}

export function EventBottomSheet({ event, onClose }: Props) {
  const cat = EVENT_CATEGORIES.find(c => c.key === event.category);
  const { user } = useAuthStore();
  const { toast } = useToast();
  const removeEvent = useEventStore((s) => s.removeEvent);
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language?.startsWith('en') ? enUS : esLocale;
  const [localCurrentSpots, setLocalCurrentSpots] = useState(event.current_spots);
  const spotsLeft = event.max_spots - localCurrentSpots;
  // null = fuera · 'pending' = solicitud enviada · 'joined' = dentro
  const [myStatus, setMyStatus] = useState<'pending' | 'joined' | null>(null);
  const hasJoined = myStatus === 'joined';
  const isPending = myStatus === 'pending';
  // Los eventos privados requieren que el organizador apruebe.
  const needsApproval = event.privacy === 'private';
  const [checkedIn, setCheckedIn] = useState(false);
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  const [attendees, setAttendees] = useState<Array<{ user_id: string; name: string | null; avatar_url: string | null; is_creator: boolean }>>([]);
  const [viewingUserId, setViewingUserId] = useState<string | null>(null);
  // Se enseñan las primeras caras y un "+N": con veinte avatares la ficha
  // dejaba de ser una ficha. Tocar el "+N" despliega el resto.
  const [showAllAttendees, setShowAllAttendees] = useState(false);
  const [loadingAttendees, setLoadingAttendees] = useState(false);
  // Se incrementa tras apuntarse o salirse para releer la lista de quién va.
  const [attendeesVersion, setAttendeesVersion] = useState(0);
  const [requests, setRequests] = useState<Array<{ id: string; name: string | null }>>([]);
  const [loadingRequests, setLoadingRequests] = useState(false);
  const [respondingTo, setRespondingTo] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [userRating, setUserRating] = useState<number | null>(null);
  const [hoverRating, setHoverRating] = useState<number | null>(null);
  const [submittingRating, setSubmittingRating] = useState(false);
  const isCreator = user?.id === event.creator_id;

  const [isOngoing, setIsOngoing] = useState(() => {
    const now = Date.now();
    return now >= new Date(event.starts_at).getTime() && now <= new Date(event.ends_at).getTime();
  });

  // Re-evaluate every 30 s so the check-in button appears/disappears at the real boundary
  useEffect(() => {
    const compute = () => {
      const now = Date.now();
      return now >= new Date(event.starts_at).getTime() && now <= new Date(event.ends_at).getTime();
    };
    setIsOngoing(compute());
    const id = setInterval(() => setIsOngoing(compute()), 30_000);
    return () => clearInterval(id);
  }, [event.starts_at, event.ends_at]);

  // Keep localCurrentSpots in sync when the realtime-updated event prop arrives
  useEffect(() => {
    setLocalCurrentSpots(event.current_spots);
  }, [event.current_spots]);

  // Quién va, para cualquiera que pueda ver el evento: es la mitad de la
  // razón por la que alguien se une. Antes solo lo veían quien organiza y
  // quien ya estaba dentro. event_attendees() devuelve nombre y foto y nada
  // más, sin pendientes ni bloqueados, y con quien organiza primero.
  //
  // Se relee cuando cambia el aforo por tiempo real, para que la lista no se
  // quede atrás del "3 lugares disponibles" de arriba.
  useEffect(() => { setShowAllAttendees(false); }, [event.id]);

  useEffect(() => {
    let cancelled = false;
    const fetchAttendees = async () => {
      setLoadingAttendees(true);
      const { data, error } = await supabase.rpc('event_attendees', { _event_id: event.id });
      if (cancelled) return;
      setLoadingAttendees(false);
      // Sin esto, un fallo dejaba la lista vacía: idéntica a un evento al que
      // de verdad no se ha unido nadie.
      if (error) {
        toast({ title: t('errors.attendeesLoad'), variant: 'destructive' });
        return;
      }
      setAttendees(data ?? []);
    };
    fetchAttendees();
    return () => { cancelled = true; };
  }, [event.id, event.current_spots, attendeesVersion, t, toast]);

  // Solicitudes pendientes — solo las ve y resuelve el organizador.
  useEffect(() => {
    if (!isCreator) return;
    let cancelled = false;
    (async () => {
      setLoadingRequests(true);
      const { data: rows, error: errSolicitudes } = await supabase
        .from('event_participants')
        .select('user_id')
        .eq('event_id', event.id)
        .eq('status', 'pending');
      if (cancelled) return;
      // Cero solicitudes por fallo se leía como "nadie ha pedido entrar", y
      // el organizador dejaría a gente esperando sin saberlo.
      if (errSolicitudes) {
        toast({ title: t('errors.attendeesLoad'), variant: 'destructive' });
        setLoadingRequests(false);
        return;
      }

      const ids = rows?.map(r => r.user_id) ?? [];
      if (ids.length === 0) {
        setRequests([]);
        setLoadingRequests(false);
        return;
      }
      const { data: profiles } = await supabase
        .from('public_profiles')
        .select('id, name')
        .in('id', ids);
      if (cancelled) return;
      setRequests((profiles ?? []).map(pr => ({ id: pr.id ?? '', name: pr.name })));
      setLoadingRequests(false);
    })();
    return () => { cancelled = true; };
  }, [isCreator, event.id, attendeesVersion, t, toast]);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (!user) { setChecking(false); return; }
      setChecking(true);
      const { data, error } = await supabase
        .from('event_participants')
        .select('id, checked_in, rating, status')
        .eq('event_id', event.id)
        .eq('user_id', user.id)
        .maybeSingle();
      // Sin toast a propósito: es un fallo transitorio que se corrige al
      // reabrir la hoja, y avisar aquí sería ruido en cada bache de red.
      if (error) console.error('estado de participación:', error.message);
      if (!cancelled) {
        setMyStatus((data?.status as 'pending' | 'joined' | undefined) ?? null);
        setCheckedIn(data?.checked_in ?? false);
        setUserRating((data as { rating?: number | null } | null)?.rating ?? null);
        setChecking(false);
      }
    };
    check();
    return () => { cancelled = true; };
  }, [event.id, user]);

  const handleJoin = async () => {
    if (!user || submitting) return;
    setSubmitting(true);
    // Optimista: en un evento privado la fila entra como 'pending' (lo fija
    // un trigger del servidor), así que no se descuenta plaza todavía.
    const prevStatus = myStatus;
    const prevSpots = localCurrentSpots;
    setMyStatus(needsApproval ? 'pending' : 'joined');
    if (!needsApproval) setLocalCurrentSpots(s => s + 1);

    const { error } = await supabase
      .from('event_participants')
      // Sin status: lo fija el trigger set_participant_initial_status según
      // la privacidad del evento ('pending' en los privados). Mandarlo desde
      // aquí no serviría de nada porque el servidor lo sobrescribe.
      .insert({ event_id: event.id, user_id: user.id });

    if (error) {
      setLocalCurrentSpots(prevSpots);
      if (error.code === '23505') {
        toast({ title: t('event.alreadyJoined') });
      } else if (error.message?.includes('EVENT_FULL')) {
        setMyStatus(prevStatus);
        toast({ title: t('event.eventFull'), variant: 'destructive' });
      } else {
        // Error desconocido: releer el estado real en vez de adivinarlo
        const { data: recheck } = await supabase
          .from('event_participants')
          .select('status')
          .eq('event_id', event.id)
          .eq('user_id', user.id)
          .maybeSingle();
        setMyStatus((recheck?.status as 'pending' | 'joined' | undefined) ?? null);
        toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
      }
    } else {
      setAttendeesVersion(v => v + 1);
      if (needsApproval) {
        toast({ title: t('event.requestSent'), description: t('event.requestSentDesc') });
      } else {
        toast({ title: t('event.joinedToast'), description: t('event.joinedDesc', { title: event.title }) });
      }
    }
    setSubmitting(false);
  };

  const handleLeave = async () => {
    if (!user || submitting) return;
    const wasPending = isPending;
    setSubmitting(true);
    setMyStatus(null);
    const prevSpots = localCurrentSpots;
    if (!wasPending) setLocalCurrentSpots(s => s - 1);
    const { error } = await supabase
      .from('event_participants')
      .delete()
      .eq('event_id', event.id)
      .eq('user_id', user.id);
    if (error) {
      setMyStatus(wasPending ? 'pending' : 'joined');
      setLocalCurrentSpots(prevSpots);
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    } else {
      setAttendeesVersion(v => v + 1);
      toast({
        title: wasPending ? t('event.requestCancelled') : t('event.leftToast'),
        description: wasPending ? undefined : t('event.leftDesc', { title: event.title }),
      });
    }
    setSubmitting(false);
  };

  const handleRespond = async (userId: string, approve: boolean) => {
    if (respondingTo) return;
    setRespondingTo(userId);
    const { error } = await supabase.rpc('respond_to_join_request', {
      _event_id: event.id,
      _user_id: userId,
      _approve: approve,
    });
    if (error) {
      const msg = error.message ?? '';
      toast({
        title: msg.includes('EVENT_FULL') ? t('event.eventFull') : t('common.error'),
        description: msg.includes('EVENT_FULL') ? undefined : rpcMessage(msg, t),
        variant: 'destructive',
      });
    } else {
      setRequests(prev => prev.filter(r => r.id !== userId));
      if (approve) setLocalCurrentSpots(sp => sp + 1);
      setAttendeesVersion(v => v + 1);
      toast({ title: approve ? t('event.requestApproved') : t('event.requestDeclined') });
    }
    setRespondingTo(null);
  };

  const handleCancelEvent = async () => {
    setSubmitting(true);
    // .update() sin .select() no dice cuántas filas tocó, y si la RLS filtrara
    // la fila devolvería 0 sin error. Se pide la fila de vuelta para no dar por
    // cancelado algo que sigue activo en la base de datos.
    const { data, error } = await supabase
      .from('events')
      .update({ is_active: false })
      .eq('id', event.id)
      .select('id')
      .maybeSingle();
    if (error) {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    } else if (!data) {
      toast({ title: t('common.error'), description: t('event.cancelEventFailed'), variant: 'destructive' });
    } else {
      // Sacarlo del store aquí y no esperar al refetch por realtime: el
      // marcador del mapa es DOM imperativo y solo se rehace cuando cambia
      // `events`, así que si no se quita a mano el pin se queda ahí.
      removeEvent(event.id);
      onClose();
    }
    setSubmitting(false);
  };

  // GPS coordinates are client-reported; this raises the bar against casual fraud
  // but cannot be considered a hard guarantee against GPS spoofing.
  const handleCheckIn = () => {
    if (!user || checkingIn) return;
    setCheckingIn(true);
    // getCurrentPosition de lib/geo.ts, no el del navegador: en nativo pide el
    // permiso a CoreLocation y el aviso sale con el nombre de la app en vez de
    // con «localhost», que es el origen del webview.
    getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 }).then(
      async (pos) => {
        const { data, error } = await supabase.rpc('check_in_to_event', {
          _event_id: event.id,
          _lat: pos.coords.latitude,
          _lng: pos.coords.longitude,
        });
        if (error) {
          const msg = error.message ?? '';
          if (msg.includes('TOO_FAR_FROM_EVENT')) {
            toast({ title: t('event.checkInTooFar'), variant: 'destructive' });
          } else if (msg.includes('OUTSIDE_EVENT_WINDOW')) {
            toast({ title: t('event.checkInWindow'), variant: 'destructive' });
          } else if (msg.includes('NOT_A_PARTICIPANT')) {
            toast({ title: t('event.checkInNotParticipant'), variant: 'destructive' });
          } else {
            toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
          }
        } else {
          setCheckedIn(true);
          toast({ title: t('event.checkInSuccess') });
        }
        setCheckingIn(false);
      },
      (err: GeolocationPositionError) => {
        toast({ title: t('map.locError'), description: err.message, variant: 'destructive' });
        setCheckingIn(false);
      },
    );
  };

  const handleRate = async (stars: number) => {
    if (!user || submittingRating) return;
    setSubmittingRating(true);
    const { error } = await supabase.rpc('rate_event', {
      p_event_id: event.id,
      p_user_id: user.id,
      p_rating: stars,
    });
    if (error) {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    } else {
      setUserRating(stars);
      toast({ title: t('event.ratingSubmitted') });
    }
    setSubmittingRating(false);
  };

  const eventEnded = Date.now() > new Date(event.ends_at).getTime();

  return (
    <>
    <div className="absolute above-nav left-0 right-0 z-20 animate-slide-up">
      <div className="mx-3 bg-card rounded-3xl shadow-lifted p-5 relative">
        <div className="drag-handle" />

        <div className="absolute top-3 right-3 flex items-center">
          {/* Reportar/bloquear vive junto al contenido, no en ajustes */}
          {!isCreator && (
            <ModerationMenu
              target={{ kind: 'event', id: event.id }}
              label={event.title}
              blockUserId={event.creator_id}
              onBlocked={onClose}
            />
          )}
          <button onClick={onClose} aria-label={t('common.close')} className="p-3 -m-2 text-muted-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Category badge */}
        <div
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold text-white mb-3"
          style={{ background: cat?.color }}
        >
          {cat && (() => { const Icon = CATEGORY_ICONS[cat.key]; return <Icon className="w-3.5 h-3.5" />; })()}
          <span>{cat ? t('categories.' + cat.key) : ''}</span>
        </div>

        <h3 className="text-lg font-extrabold text-foreground mb-2">{event.title}</h3>

        <div className="space-y-2 mb-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="w-4 h-4" />
            <span>{format(new Date(event.starts_at), 'MMM d, h:mm a', { locale: dateLocale })}</span>
          </div>
          {event.address && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <MapPin className="w-4 h-4" />
              <span>{event.address}</span>
            </div>
          )}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Users className="w-4 h-4" />
            <span>
              {spotsLeft <= 0
                ? t('event.full')
                : spotsLeft === 1
                  ? t('event.spotLeftOne')
                  : t('event.spotLeftOther', { count: spotsLeft })}
            </span>
          </div>
        </div>

        {event.description && (
          <p className="text-sm text-muted-foreground mb-4 line-clamp-2">{event.description}</p>
        )}


        {/* Solicitudes pendientes — solo el organizador */}
        {!checking && isCreator && (loadingRequests || requests.length > 0) && (
          <div className="mb-4 border border-primary/30 bg-primary/5 rounded-xl p-3 space-y-2">
            <p className="text-[13px] font-semibold text-primary">
              {t('event.requests', { count: requests.length })}
            </p>
            {loadingRequests ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
            ) : (
              requests.map(r => (
                <div key={r.id} className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground truncate">
                    {r.name ?? t('profile.student')}
                  </span>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => handleRespond(r.id, true)}
                      disabled={respondingTo === r.id}
                      aria-label={t('event.approve')}
                      className="inline-flex items-center min-h-[44px] px-4 rounded-full bg-primary text-primary-foreground text-xs font-bold disabled:opacity-50"
                    >
                      {t('event.approve')}
                    </button>
                    <button
                      onClick={() => handleRespond(r.id, false)}
                      disabled={respondingTo === r.id}
                      aria-label={t('event.decline')}
                      className="inline-flex items-center min-h-[44px] px-4 rounded-full bg-muted text-muted-foreground text-xs font-bold disabled:opacity-50"
                    >
                      {t('event.decline')}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* Quién va — para cualquiera que vea el evento */}
        <div className="mb-4 border border-border rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[13px] font-semibold text-foreground">
              {isCreator ? t('event.organizedByYou') : t('event.whoIsGoing')}
              {/* Sin contar a quien organiza: si no, esta cifra contradice al
                  aforo ("1/6"), que cuenta solo a quien se unió. */}
              {localCurrentSpots > 0 && (
                <span className="font-normal text-muted-foreground">
                  {' · '}
                  {localCurrentSpots === 1
                    ? t('event.joinedPersonOne', { count: localCurrentSpots })
                    : t('event.joinedPersonOther', { count: localCurrentSpots })}
                </span>
              )}
            </p>
            {isCreator && (
              <button
                onClick={() => setEditOpen(true)}
                aria-label={t('edit.title')}
                className="inline-flex items-center gap-1 min-h-[44px] text-xs text-primary font-semibold shrink-0"
              >
                <Pencil className="w-3 h-3" />
                {t('edit.title')}
              </button>
            )}
          </div>
          {loadingAttendees && attendees.length === 0 ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
          ) : (
            <>
              <ul className="flex gap-3 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
                {(showAllAttendees ? attendees : attendees.slice(0, ATTENDEES_PREVIEW)).map(a => (
                  <li key={a.user_id} className="shrink-0">
                    <button
                      type="button"
                      onClick={() => setViewingUserId(a.user_id)}
                      aria-label={a.is_creator ? `${a.name ?? t('profile.student')}, ${t('event.organizer')}` : a.name ?? t('profile.student')}
                      className="w-16 flex flex-col items-center gap-1 text-center"
                    >
                      <UserAvatar
                        url={a.avatar_url}
                        name={a.name}
                        className={cn('w-12 h-12 bg-muted', a.is_creator && 'ring-2 ring-primary ring-offset-2 ring-offset-card')}
                        textClassName="text-base font-bold text-muted-foreground"
                      />
                      <span className="w-full text-[11px] font-medium text-foreground truncate">
                        {a.user_id === user?.id ? t('event.you') : a.name?.split(' ')[0] ?? '?'}
                      </span>
                      {a.is_creator && (
                        <span className="-mt-1 text-[10px] font-semibold text-primary">{t('event.organizer')}</span>
                      )}
                    </button>
                  </li>
                ))}
                {!showAllAttendees && attendees.length > ATTENDEES_PREVIEW && (
                  <li className="shrink-0">
                    <button
                      type="button"
                      onClick={() => setShowAllAttendees(true)}
                      aria-label={t('event.showAllAttendees', { count: attendees.length - ATTENDEES_PREVIEW })}
                      className="w-16 flex flex-col items-center gap-1 text-center"
                    >
                      <span className="w-12 h-12 rounded-full bg-primary/10 text-primary text-sm font-bold flex items-center justify-center">
                        +{attendees.length - ATTENDEES_PREVIEW}
                      </span>
                      <span className="w-full text-[11px] font-medium text-muted-foreground truncate">{t('event.seeAll')}</span>
                    </button>
                  </li>
                )}
              </ul>
              {attendees.filter(a => !a.is_creator).length === 0 && (
                <p className="text-xs text-muted-foreground">{t('event.noAttendeesYet')}</p>
              )}
            </>
          )}
        </div>

        <div className="flex gap-3">
          {checking ? (
            <Button disabled className="flex-1 h-12 rounded-xl font-bold">
              <Loader2 className="w-4 h-4 animate-spin" />
            </Button>
          ) : isCreator ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  className="flex-1 h-12 rounded-xl font-bold"
                  disabled={submitting}
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : t('event.cancelEvent')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('event.cancelEventConfirm')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('event.cancelEventConfirmDesc')}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleCancelEvent}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {t('event.cancelEvent')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : hasJoined ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  disabled={submitting}
                  variant="destructive"
                  className="flex-1 h-12 rounded-xl font-bold"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : t('event.leave')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('event.leaveConfirmTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('event.leaveConfirmDesc')}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleLeave}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {t('event.leaveConfirmAction')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : isPending ? (
            <Button
              onClick={handleLeave}
              disabled={submitting}
              variant="outline"
              className="flex-1 h-12 rounded-xl font-bold"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : t('event.cancelRequest')}
            </Button>
          ) : (
            <Button
              onClick={handleJoin}
              disabled={(spotsLeft <= 0 && !needsApproval) || submitting}
              className="flex-1 h-12 rounded-xl font-bold"
            >
              {submitting
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : needsApproval ? t('event.askToJoin') : t('event.join')}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={onClose}
            className="h-12 rounded-xl font-semibold px-6"
          >
            {t('common.close')}
          </Button>
        </div>

        {isPending && (
          <p className="mt-2 text-xs text-muted-foreground text-center">
            {t('event.pendingNotice')}
          </p>
        )}

        {/* Check-in button — shown only when joined, not the creator, and event is live */}
        {!checking && !isCreator && hasJoined && isOngoing && (
          checkedIn ? (
            <Button disabled variant="secondary" className="w-full mt-2 h-11 rounded-xl font-bold">
              {t('event.checkedIn')}
            </Button>
          ) : (
            <Button
              onClick={handleCheckIn}
              disabled={checkingIn}
              variant="secondary"
              className="w-full mt-2 h-11 rounded-xl font-bold"
            >
              {checkingIn ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              {t('event.checkIn')}
            </Button>
          )
        )}
        {/* Star rating — shown for past events the user attended (not the creator) */}
        {!checking && !isCreator && hasJoined && eventEnded && (
          <div className="mt-3 border-t border-border pt-3">
            <p className="text-xs font-semibold text-muted-foreground mb-2">
              {userRating ? t('event.yourRating') : t('event.rateEvent')}
            </p>
            <div className="flex gap-1.5">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  disabled={!!userRating || submittingRating}
                  onClick={() => handleRate(star)}
                  onMouseEnter={() => !userRating && setHoverRating(star)}
                  onMouseLeave={() => setHoverRating(null)}
                  className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] transition-transform active:scale-110 disabled:cursor-default"
                  aria-label={star === 1 ? t('event.rateStarOne') : t('event.rateStarOther', { count: star })}
                >
                  {/* El icono es decorativo: lo que anuncia el lector de
                      pantalla es el aria-label del botón. */}
                  <Star
                    aria-hidden="true"
                    className={cn(
                      'w-7 h-7 transition-colors',
                      star <= (hoverRating ?? userRating ?? 0)
                        ? 'fill-warning text-warning'
                        : 'fill-none text-muted-foreground'
                    )}
                  />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>

    {editOpen && (
      <EditEventSheet
        event={event}
        onClose={() => setEditOpen(false)}
        onSaved={onClose}
      />
    )}

    {/* Tocar a alguien de "Quién va" abre su ficha, encima de la hoja. */}
    {viewingUserId && (
      <UserProfileSheet userId={viewingUserId} onClose={() => setViewingUserId(null)} />
    )}
    </>
  );
}
