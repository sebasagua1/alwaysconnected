import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, CalendarIcon, Minus, Plus as PlusIcon, Loader2 } from 'lucide-react';
import { PrivacySelector } from '@/components/ui/privacy-selector';
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
import { useSheetDrag } from '@/hooks/useSheetDrag';
import { haptic } from '@/lib/haptics';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { DateTimeWheel } from '@/components/ui/datetime-wheel';
import { combineDateTime, formatShortDay, formatTime, toTimeValue } from '@/lib/datetime';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import type { MapEvent } from '@/stores/eventStore';

interface Props {
  event: MapEvent;
  onClose: () => void;
  onSaved: () => void;
}

const toTimeString = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function EditEventSheet({ event, onClose, onSaved }: Props) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const lang = i18n.language ?? 'es';
  const whenText = (d: Date) => `${formatShortDay(d, lang)} · ${formatTime(d, lang)}`;

  const [title, setTitle] = useState(event.title);
  const [description, setDescription] = useState(event.description ?? '');
  const [startDate, setStartDate] = useState<Date>(new Date(event.starts_at));
  const [startTime, setStartTime] = useState(toTimeString(event.starts_at));
  const [endDate, setEndDate] = useState<Date>(new Date(event.ends_at));
  const [endTime, setEndTime] = useState(toTimeString(event.ends_at));
  const [wheel, setWheel] = useState<'start' | 'end' | null>(null);
  const [maxSpots, setMaxSpots] = useState(event.max_spots);
  const [privacy, setPrivacy] = useState(event.privacy);
  const [saving, setSaving] = useState(false);

  // Cambios sin guardar: cerrar pregunta antes de tirarlos.
  const dirty =
    title !== event.title ||
    description !== (event.description ?? '') ||
    startTime !== toTimeString(event.starts_at) ||
    endTime !== toTimeString(event.ends_at) ||
    startDate.toDateString() !== new Date(event.starts_at).toDateString() ||
    endDate.toDateString() !== new Date(event.ends_at).toDateString() ||
    maxSpots !== event.max_spots ||
    privacy !== event.privacy;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const requestClose = () => (dirty ? setConfirmDiscard(true) : onClose());
  const { sheetRef, scrollRef, handleProps } = useSheetDrag<HTMLDivElement>({
    onClose,
    canClose: () => {
      if (!dirty) return true;
      setConfirmDiscard(true);
      return false;
    },
  });

  const buildDatetime = (date: Date, time: string): Date => {
    const [h, m] = time.split(':').map(Number);
    const d = new Date(date);
    d.setHours(h, m, 0, 0);
    return d;
  };

  const handleSave = async () => {
    if (!title.trim()) {
      toast({ title: t('edit.titleRequired'), variant: 'destructive' });
      return;
    }
    const startsAt = buildDatetime(startDate, startTime);
    const endsAt = buildDatetime(endDate, endTime);

    if (endsAt <= startsAt) {
      toast({ title: t('edit.endBeforeStart'), variant: 'destructive' });
      return;
    }
    if (maxSpots < event.current_spots) {
      toast({ title: t('edit.spotsBelowCurrent'), variant: 'destructive' });
      return;
    }

    setSaving(true);
    const { error } = await supabase
      .from('events')
      .update({
        title: title.trim(),
        description: description.trim() || null,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        max_spots: maxSpots,
        privacy,
      })
      .eq('id', event.id);

    if (error) {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    } else {
      haptic.success();
      toast({ title: t('edit.saved') });
      onSaved();
      onClose();
    }
    setSaving(false);
  };

  return (
    // z por encima de BottomNav (z-50): el pie de este sheet es sticky y se
    // queda justo en la franja de la barra, que al pintarse después ganaba el
    // empate de z-index y tapaba el botón de guardar.
    <div className="fixed inset-0 z-[60] bg-scrim animate-fade-in" onClick={requestClose}>
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-event-title"
        className="absolute bottom-0 left-0 right-0 bg-card rounded-t-3xl shadow-lifted animate-slide-up max-h-[88dvh] flex flex-col mx-auto sm:max-w-[430px]"
        onClick={e => e.stopPropagation()}
      >
        <div {...handleProps} className="shrink-0 px-5 pt-1 pb-3 border-b border-border/60">
          <div className="drag-handle" />
          <div className="flex items-center justify-between">
            <h2 id="edit-event-title" className="text-xl font-extrabold text-foreground">{t('edit.title')}</h2>
            <button onClick={requestClose} aria-label={t('common.close')} className="w-11 h-11 -mr-2 inline-flex items-center justify-center text-muted-foreground">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 pt-4 pb-4">
          <div className="space-y-5">
            {/* Title */}
            <div>
              <label htmlFor="edit-title" className="text-sm font-semibold text-foreground mb-2 block">{t('create.titleLabel')}</label>
              <Input
                id="edit-title"
                value={title}
                onChange={e => setTitle(e.target.value)}
                className="h-12 rounded-xl text-base"
              />
            </div>

            {/* Description */}
            <div>
              <label htmlFor="edit-description" className="text-sm font-semibold text-foreground mb-2 block">
                {t('create.descriptionLabel')} <span className="font-normal text-muted-foreground">({t('common.optional')})</span>
              </label>
              <Textarea
                id="edit-description"
                placeholder={t('create.descriptionPh2')}
                value={description}
                onChange={e => setDescription(e.target.value)}
                className="rounded-xl text-base resize-none"
                rows={3}
              />
            </div>

            {/* Start date & time */}
            <div>
              <label className="text-sm font-semibold text-foreground mb-2 block">{t('edit.starts')}</label>
              <Button
                type="button"
                variant="outline"
                onClick={() => setWheel('start')}
                className="h-12 w-full justify-start text-left font-normal rounded-xl"
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {whenText(combineDateTime(startDate, startTime))}
              </Button>
            </div>

            {/* End date & time */}
            <div>
              <label className="text-sm font-semibold text-foreground mb-2 block">{t('edit.ends')}</label>
              <Button
                type="button"
                variant="outline"
                onClick={() => setWheel('end')}
                className="h-12 w-full justify-start text-left font-normal rounded-xl"
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {whenText(combineDateTime(endDate, endTime))}
              </Button>
            </div>

            {/* Max spots */}
            <div>
              <label className="text-sm font-semibold text-foreground mb-2 block">{t('create.maxSpots')}</label>
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setMaxSpots(Math.max(event.current_spots, maxSpots - 1))}
                  aria-label={t('create.decreaseSpots')}
                  className="w-11 h-11 rounded-full bg-muted flex items-center justify-center"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <span className="text-xl font-bold text-foreground w-8 text-center">{maxSpots}</span>
                <button
                  onClick={() => setMaxSpots(Math.min(100, maxSpots + 1))}
                  aria-label={t('create.increaseSpots')}
                  className="w-11 h-11 rounded-full bg-muted flex items-center justify-center"
                >
                  <PlusIcon className="w-4 h-4" />
                </button>
              </div>
              {maxSpots === event.current_spots && event.current_spots > 0 && (
                <p className="text-xs text-muted-foreground mt-1">{t('edit.spotsAtMin', { count: event.current_spots })}</p>
              )}
            </div>

            {/* Privacy */}
            <PrivacySelector value={privacy} onChange={setPrivacy} />

            {/* Antes se podía cambiar la hora o el sitio y nadie se enteraba:
                la gente se presentaba donde ya no era. Ahora el disparador
                trg_event_change_push avisa, y conviene decirlo aquí para que
                el aviso no llegue de sorpresa a quien organiza. */}
            {event.current_spots > 0 && (
              <p className="text-xs text-muted-foreground">{t('edit.notifyNotice')}</p>
            )}
          </div>
        </div>

        {/* Pie fijo, fuera del scroll */}
        <div className="shrink-0 bg-card border-t border-border px-5 pt-4 flex gap-3 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
          <Button variant="outline" onClick={requestClose} className="h-12 rounded-xl px-6">
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !title.trim()}
            className="flex-1 h-12 rounded-xl font-bold"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : t('edit.save')}
          </Button>
        </div>
      </div>

      {wheel && (
        <DateTimeWheel
          value={wheel === 'start'
            ? combineDateTime(startDate, startTime)
            : combineDateTime(endDate, endTime)}
          title={wheel === 'start' ? t('edit.starts') : t('edit.ends')}
          onCancel={() => setWheel(null)}
          onConfirm={(d) => {
            if (wheel === 'start') { setStartDate(d); setStartTime(toTimeValue(d)); }
            else { setEndDate(d); setEndTime(toTimeValue(d)); }
            setWheel(null);
          }}
        />
      )}

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('edit.discardTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('edit.discardDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('create.keepEditing')}</AlertDialogCancel>
            <AlertDialogAction onClick={onClose} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t('create.discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
