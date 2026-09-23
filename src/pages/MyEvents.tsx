import { useCallback, useEffect, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { useTranslation } from 'react-i18next';
import { CalendarDays, ChevronRight, Clock, MessagesSquare, Users } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks/use-toast';
import { EVENT_CATEGORIES } from '@/lib/constants';
import { CATEGORY_ICONS } from '@/lib/categoryIcons';
import { cn } from '@/lib/utils';
import { EventBottomSheet } from '@/components/map/EventBottomSheet';
import type { MapEvent } from '@/stores/eventStore';
import { useNotificationStore } from '@/stores/notificationStore';
import { Skeleton } from '@/components/ui/skeleton';
import { useStaggerReveal } from '@/hooks/useStaggerReveal';
import { format, isPast, formatDistanceToNow } from 'date-fns';
import { es as esLocale, enUS } from 'date-fns/locale';
import { pageTitle } from '@/lib/brand';
import { NotificationBell } from '@/components/notifications/NotificationBell';

// Extiende MapEvent porque la tarjeta abre el mismo EventBottomSheet que el
// mapa, y ese componente necesita el evento completo (creator_id, privacy...),
// no solo los cuatro campos que se pintan en la tarjeta.
interface EventWithParticipation extends MapEvent {
  role: 'organizer' | 'joined';
  /** Aprobado en un evento privado y todavía sin ver. */
  justApproved?: boolean;
}

export default function MyEvents() {
  const { user } = useAuthStore();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language?.startsWith('en') ? enUS : esLocale;
  const [activeTab, setActiveTab] = useState<'upcoming' | 'past'>('upcoming');
  const [events, setEvents] = useState<EventWithParticipation[]>([]);
  const [loading, setLoading] = useState(true);
  const [visibleCount, setVisibleCount] = useState(10);
  const [selected, setSelected] = useState<EventWithParticipation | null>(null);
  const [pendingByEvent, setPendingByEvent] = useState<Record<string, number>>({});
  const [chatUnreadByEvent, setChatUnreadByEvent] = useState<Record<string, number>>({});
  const PAGE_SIZE = 10;

  const fetchMyEvents = useCallback(async () => {
    if (!user) return;
    {
      setLoading(true);
      try {
        // Events I created — los cancelados (is_active = false) no se listan:
        // el organizador ya los dio por muertos y no deben salir en "Próximos".
        const { data: created, error: errCreated } = await supabase
          .from('events')
          .select('*')
          .eq('creator_id', user.id)
          .eq('is_active', true);

        // Events I joined
        const { data: participated, error: errJoined } = await supabase
          .from('event_participants')
          .select('event_id, events(*)')
          .eq('user_id', user.id);

        // Sin esto, un bache de red enseñaba "no tienes eventos" a quien sí
        // los tiene, y la lista vacía por fallo era idéntica a la lista vacía
        // de verdad. Se corta aquí para no pintar media lista como si fuera
        // toda: es peor un listado incompleto sin avisar que ninguno.
        if (errCreated || errJoined) {
          toast({ title: t('errors.eventsLoad'), variant: 'destructive' });
          return;
        }

        // Aparte y no en el select de arriba: si estas dos columnas todavía no
        // existen en la base, PostgREST rechazaría la consulta entera y la
        // lista se quedaría sin los eventos a los que te apuntaste. Así lo
        // único que se pierde es el aviso.
        const { data: approvals } = await supabase
          .from('event_participants')
          .select('event_id, approval_seen, approved_at')
          .eq('user_id', user.id);
        const justApprovedIds = new Set(
          (approvals ?? [])
            .filter((a) => a.approved_at != null && a.approval_seen === false)
            .map((a) => a.event_id)
        );

        const seen = new Set<string>();
        const all: EventWithParticipation[] = [];
        // `location` se compone aquí igual que en MapHome: en la tabla lng y lat
        // son columnas sueltas y MapEvent las espera juntas.
        created?.forEach((e) => {
          seen.add(e.id);
          all.push({
            ...e,
            location: e.lng != null && e.lat != null ? { lng: e.lng, lat: e.lat } : null,
            role: 'organizer',
          });
        });
        participated?.forEach((p) => {
          // El filtro va aquí y no en la query porque PostgREST necesitaría un
          // !inner join para filtrar sobre la tabla embebida.
          if (p.events && p.events.is_active && !seen.has(p.events.id)) {
            const ev = p.events;
            seen.add(ev.id);
            all.push({
              ...ev,
              location: ev.lng != null && ev.lat != null ? { lng: ev.lng, lat: ev.lat } : null,
              role: 'joined',
              justApproved: justApprovedIds.has(ev.id),
            });
          }
        });
        setEvents(all);

        // Cuánta gente espera aprobación en cada evento que organizo, para el
        // aviso de la tarjeta. Va por RPC porque contar desde el cliente
        // exigiría leer filas de event_participants que la RLS no deja ver.
        const { data: pending } = await supabase.rpc('pending_requests_by_event');
        setPendingByEvent(
          Object.fromEntries((pending ?? []).map((r) => [r.event_id, Number(r.pending)]))
        );

        // Mensajes sin leer del chat de cada actividad. Si la base todavía
        // no tiene el chat, la llamada falla y la tarjeta queda como antes.
        const { data: chatUnread } = await supabase.rpc('event_chat_unread');
        setChatUnreadByEvent(
          Object.fromEntries((chatUnread ?? []).map((r) => [r.event_id, Number(r.unread)]))
        );

        // Se marcan vistos aquí, ya con la lista pintada: el aviso se enseña
        // esta vez y no vuelve a salir. Después hay que pedir el recuento a
        // mano, porque este UPDATE no dispara realtime para el globo.
        if (justApprovedIds.size > 0) {
          await supabase.rpc('mark_approvals_seen');
          useNotificationStore.getState().refresh();
        }
      } finally {
        setLoading(false);
      }
    }
  }, [user, t, toast]);

  useEffect(() => { fetchMyEvents(); }, [fetchMyEvents]);

  // Al cerrar se relee: dentro del sheet se puede cancelar el evento, aprobar
  // solicitudes o darse de baja, y la lista se quedaría desfasada.
  const handleCloseSheet = useCallback(() => {
    setSelected(null);
    fetchMyEvents();
  }, [fetchMyEvents]);

  const allFiltered = events.filter(e =>
    activeTab === 'upcoming' ? !isPast(new Date(e.ends_at)) : isPast(new Date(e.ends_at))
  );
  const filtered = allFiltered.slice(0, visibleCount);
  // Lo que terminó en las últimas 48 h, arriba de "Próximos": es cuando
  // agregar a alguien o repetir el plan todavía apetece. En "Pasados" ya
  // sale como cualquier otro.
  const justEnded = events
    .filter((e) => isPast(new Date(e.ends_at)) && Date.now() - new Date(e.ends_at).getTime() < 48 * 3600 * 1000)
    .sort((a, b) => new Date(b.ends_at).getTime() - new Date(a.ends_at).getTime());

  // Entrada en cascada de las tarjetas. Se rehace al cambiar de pestaña y
  // cuando termina la carga; `visibleCount` entra en la lista para que las
  // tarjetas que trae "ver más" también se revelen en vez de aparecer secas.
  const listScope = useStaggerReveal<HTMLDivElement>([activeTab, loading, visibleCount]);

  return (
    <div className="min-h-screen pb-nav px-4 pt-safe">
      <Helmet>
        <title>{pageTitle(t('myEvents.title'))}</title>
        <meta name="description" content={t('myEvents.metaDesc')} />
        <link rel="canonical" href="/events" />
        <meta property="og:title" content={pageTitle(t('myEvents.title'))} />
        <meta property="og:description" content={t('myEvents.metaDesc')} />
        <meta property="og:url" content="/events" />
      </Helmet>
      <div className="flex items-center justify-between gap-2 mb-4">
        <h1 className="text-2xl font-extrabold text-foreground">{t('myEvents.title')}</h1>
        <NotificationBell />
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-5">
        {(['upcoming', 'past'] as const).map(tab => (
          <button
            key={tab}
            aria-pressed={activeTab === tab}
            onClick={() => { setActiveTab(tab); setVisibleCount(PAGE_SIZE); }}
            className={cn(
              'inline-flex items-center justify-center min-h-[44px] px-5 rounded-full text-sm font-semibold transition-all',
              activeTab === tab ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
            )}
          >
            {t(`myEvents.${tab}`)}
          </button>
        ))}
      </div>

      {/* Event cards */}
      <div ref={listScope} className="space-y-3">
        {loading ? (
          [1, 2, 3].map(i => (
            <div key={i} className="bg-card rounded-2xl p-4 shadow-soft space-y-2">
              <Skeleton className="h-4 w-20 rounded-full" />
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <CalendarDays className="w-12 h-12 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-muted-foreground text-sm">{t(activeTab === 'upcoming' ? 'myEvents.emptyUpcoming' : 'myEvents.emptyPast')}</p>
          </div>
        ) : null}
        {!loading && activeTab === 'upcoming' && justEnded.map(event => (
          <button
            key={`ended-${event.id}`}
            data-reveal
            onClick={() => setSelected(event)}
            className="w-full flex items-center gap-3 text-left rounded-2xl p-4 bg-primary/10 border border-primary/30 active:scale-[0.98] transition-transform"
          >
            <span className="flex-1 min-w-0">
              <span className="block text-xs font-semibold text-primary">{t('afterEvent.justEnded')}</span>
              <span className="block font-bold text-foreground truncate">{event.title}</span>
            </span>
            <span className="flex items-center gap-0.5 text-sm font-bold text-primary shrink-0">
              {t('afterEvent.whatsNext')}
              <ChevronRight className="w-4 h-4" aria-hidden="true" />
            </span>
          </button>
        ))}
        {!loading && filtered.map(event => {
          const cat = EVENT_CATEGORIES.find(c => c.key === event.category);
          return (
            <button
              key={event.id}
              data-reveal
              onClick={() => setSelected(event)}
              className="w-full text-left bg-card rounded-2xl p-4 shadow-soft active:scale-[0.98] transition-transform"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold text-white mb-2"
                    style={{ background: cat?.color }}
                  >
                    {cat && (() => { const Icon = CATEGORY_ICONS[cat.key]; return <Icon className="w-2.5 h-2.5 mr-0.5 inline" />; })()}
                    {cat ? t('categories.' + cat.key) : ''}
                  </div>
                  <h2 className="font-bold text-foreground text-base">{event.title}</h2>
                  <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
                    <Clock className="w-3.5 h-3.5" />
                    <span>{format(new Date(event.starts_at), 'MMM d, h:mm a', { locale: dateLocale })}</span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className={cn(
                    'px-2 py-0.5 rounded-full text-xs font-bold',
                    event.role === 'organizer' ? 'bg-primary/10 text-primary' : 'bg-success/10 text-success'
                  )}>
                    {event.role === 'organizer' ? t('myEvents.organizer') : t('myEvents.joined')}
                  </span>
                  {!isPast(new Date(event.starts_at)) && (
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(event.starts_at), { addSuffix: true, locale: dateLocale })}
                    </span>
                  )}
                </div>
              </div>

              {/* Pie: aforo, solicitudes por aprobar y pista de que se toca */}
              <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
                <span className="flex items-center gap-2">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Users className="w-3.5 h-3.5" />
                    {event.current_spots}/{event.max_spots}
                  </span>
                  {pendingByEvent[event.id] > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-destructive text-destructive-foreground text-xs font-bold">
                      {t('myEvents.requests', { count: pendingByEvent[event.id] })}
                    </span>
                  )}
                  {chatUnreadByEvent[event.id] > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-bold">
                      <MessagesSquare className="w-3 h-3" aria-hidden="true" />
                      {t('eventChat.unreadChip', { count: chatUnreadByEvent[event.id] })}
                    </span>
                  )}
                  {event.justApproved && (
                    <span className="px-2 py-0.5 rounded-full bg-success/15 text-success text-xs font-bold">
                      {t('myEvents.approved')}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-0.5 text-xs font-semibold text-primary">
                  {isPast(new Date(event.ends_at)) ? t('afterEvent.whatsNext') : t('myEvents.viewDetails')}
                  <ChevronRight className="w-3.5 h-3.5" />
                </span>
              </div>
            </button>
          );
        })}
        {!loading && visibleCount < allFiltered.length && (
          <button
            onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
            className="w-full min-h-[44px] text-sm font-semibold text-primary"
          >
            {t('common.loadMore')}
          </button>
        )}
      </div>

      {/* Mismo detalle que en el mapa: asistentes y, si eres organizador, el
          panel de solicitudes. Va dentro de un contenedor fixed porque el sheet
          se posiciona con `absolute bottom-20` y esta página hace scroll. */}
      {selected && (
        <div className="fixed inset-0 z-[60]">
          <button
            aria-label={t('common.close')}
            onClick={handleCloseSheet}
            className="absolute inset-0 bg-black/30"
          />
          {/* El sheet se coloca con `absolute left-0 right-0`, así que ocupa el
              ancho de su contenedor. Sin esta columna se estiraba a todo el
              navegador, porque el `fixed inset-0` mide la ventana entera y no
              los 430px del móvil. En el mapa no pasaba: allí su contenedor ya
              es la columna de AppShell. */}
          <div className="relative mx-auto h-full w-full sm:max-w-[430px]">
            <EventBottomSheet event={selected} onClose={handleCloseSheet} />
          </div>
        </div>
      )}
    </div>
  );
}
