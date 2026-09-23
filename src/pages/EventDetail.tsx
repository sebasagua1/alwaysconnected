import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CalendarX2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EventBottomSheet } from '@/components/map/EventBottomSheet';
import { supabase } from '@/integrations/supabase/client';
import type { MapEvent } from '@/stores/eventStore';

/**
 * La ficha de una actividad abierta desde un aviso o un enlace.
 *
 * Lee el evento con la RLS de siempre: si ya no se puede ver (cancelado,
 * cambió a "solo amigos", bloqueo) lo dice en vez de enseñar datos viejos
 * de la notificación. Pinta la misma hoja que el mapa y "Mis eventos".
 */
export default function EventDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [event, setEvent] = useState<MapEvent | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'gone'>('loading');

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from('events').select('*').eq('id', id).maybeSingle();
      if (cancelled) return;
      if (error || !data || !data.is_active) {
        setStatus('gone');
        return;
      }
      setEvent({
        ...data,
        location: data.lng != null && data.lat != null ? { lng: data.lng, lat: data.lat } : null,
      });
      setStatus('ready');
    })();
    return () => { cancelled = true; };
  }, [id]);

  const close = () => (location.key === 'default' ? navigate('/events') : navigate(-1));

  if (status === 'gone') {
    return (
      <div className="min-h-screen pb-nav px-8 pt-safe flex flex-col items-center justify-center text-center gap-3">
        <CalendarX2 className="w-12 h-12 text-muted-foreground/50" aria-hidden="true" />
        <p className="text-base font-semibold text-foreground">{t('eventDetail.goneTitle')}</p>
        <p className="text-sm text-muted-foreground">{t('eventDetail.goneDesc')}</p>
        <Button variant="outline" className="rounded-xl mt-2" onClick={() => navigate('/events')}>{t('eventDetail.toMyEvents')}</Button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[60]">
      <button aria-label={t('common.close')} onClick={close} className="absolute inset-0 bg-black/30" />
      <div className="relative mx-auto h-full w-full sm:max-w-[430px]">
        {event && <EventBottomSheet event={event} onClose={close} />}
      </div>
    </div>
  );
}
