import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { X, Minus, Plus as PlusIcon, MapPin, CalendarIcon, Repeat, AlertCircle } from 'lucide-react';
import { PrivacySelector } from '@/components/ui/privacy-selector';
import { CATEGORY_ICONS } from '@/lib/categoryIcons';
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
import { useFormatWhen } from '@/hooks/useFormatWhen';
import { useSheetDrag } from '@/hooks/useSheetDrag';
import { haptic } from '@/lib/haptics';
import { askForPush } from '@/stores/pushPrimerStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { DateTimeWheel } from '@/components/ui/datetime-wheel';
import { combineDateTime, toTimeValue } from '@/lib/datetime';
import { EVENT_CATEGORIES } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { rpcMessage } from '@/lib/rpcErrors';
import { reverseGeocode } from '@/lib/geocode';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks/use-toast';
import type { RepeatDraft } from '@/lib/repeatPlan';

const eventSchema = z.object({
  title: z.string().trim().min(3).max(80),
  category: z.string().min(1),
  address: z.string().trim().max(120).optional(),
  description: z.string().trim().max(500).optional(),
  maxSpots: z.number().int().min(2).max(100),
  privacy: z.enum(['open', 'friends', 'private']),
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  startsAt: z.date().refine((d) => d.getTime() > Date.now() - 60_000),
});

const MAPBOX_TOKEN = (import.meta.env.VITE_MAPBOX_TOKEN as string) ?? '';

interface Props {
  onClose: () => void;
  onPickLocation: () => void;
  pickedLocation: { lng: number; lat: number } | null;
  /**
   * Aparta la hoja de la vista SIN desmontarla, mientras se elige el sitio
   * en el mapa. Tiene que ser esto y no dejar de renderizarla: todo lo que
   * se ha escrito —titulo, fecha, hora, descripcion— vive en el estado de
   * este componente, y desmontarlo lo borra.
   */
  hidden?: boolean;
  /**
   * "Repetir el plan": el formulario sale relleno con el evento anterior y
   * la misma hora de la semana siguiente. Todo se puede cambiar antes de
   * publicar; al publicar se avisa a quienes fueron (lo hace el servidor).
   */
  initial?: RepeatDraft | null;
}

export function CreateEventSheet({ onClose, onPickLocation, pickedLocation, hidden = false, initial = null }: Props) {
  const { user } = useAuthStore();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const formatWhen = useFormatWhen();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [category, setCategory] = useState(initial?.category ?? 'study');
  const [date, setDate] = useState<Date | undefined>(initial?.startsAt);
  const [whenOpen, setWhenOpen] = useState(false);
  const [time, setTime] = useState(initial ? toTimeValue(initial.startsAt) : '');
  const [address, setAddress] = useState(initial?.address ?? '');
  const [maxSpots, setMaxSpots] = useState(initial?.maxSpots ?? 10);
  const [description, setDescription] = useState(initial?.description ?? '');
  const [privacy, setPrivacy] = useState(initial?.privacy ?? 'open');
  const [durationMins, setDurationMins] = useState(initial?.durationMins ?? 120);
  const [loading, setLoading] = useState(false);
  const [placeName, setPlaceName] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  // Si la persona ya escribio el nombre del sitio a mano, el geocoding no se
  // lo pisa: lo suyo manda sobre lo que adivine Mapbox.
  // Al repetir, el nombre del sitio anterior cuenta como escrito a mano.
  const addressTouched = useRef(!!initial?.address);

  // El pin -> un nombre que alguien reconozca. Las coordenadas siguen yendo
  // a la base igual; esto es solo lo que se ve.
  useEffect(() => {
    if (!pickedLocation) {
      setPlaceName(null);
      return;
    }
    const ctrl = new AbortController();
    let cancelada = false;
    setLookingUp(true);
    const idioma = i18n.language?.startsWith('en') ? 'en' : 'es';
    reverseGeocode(pickedLocation.lng, pickedLocation.lat, MAPBOX_TOKEN, idioma, ctrl.signal)
      .then((nombre) => {
        if (cancelada) return;
        setPlaceName(nombre);
        if (nombre && !addressTouched.current) setAddress(nombre);
      })
      .finally(() => { if (!cancelada) setLookingUp(false); });
    return () => { cancelada = true; ctrl.abort(); };
  }, [pickedLocation, i18n.language]);

  // ---- Validación a la vista ------------------------------------------------
  //
  // Antes «Publicar» estaba desactivado hasta tener título, fecha, hora y
  // lugar, al final de un formulario largo y sin decir qué faltaba: la gente
  // veía un botón apagado y no sabía por qué. Ahora siempre se puede pulsar;
  // si falta algo, se marca en el campo, se dice arriba del botón y se sube
  // hasta el primero.
  const [showErrors, setShowErrors] = useState(false);
  const startsAtPreview = date && time ? combineDateTime(date, time) : null;
  const errors = {
    title: title.trim().length < 3,
    when: !startsAtPreview || startsAtPreview.getTime() < Date.now() - 60_000,
    location: !pickedLocation,
  };
  const missing = [
    errors.title && t('create.missingTitle'),
    errors.when && t('create.missingWhen'),
    errors.location && t('create.missingLocation'),
  ].filter(Boolean) as string[];
  const titleRef = useRef<HTMLInputElement>(null);
  const whenRef = useRef<HTMLDivElement>(null);
  const locationRef = useRef<HTMLDivElement>(null);

  // ---- Cerrar sin perder un borrador -----------------------------------------
  //
  // Tocar fuera de la hoja o la X borraba todo, incluido el sitio ya marcado
  // en el mapa, sin preguntar.
  const dirty =
    !!initial ||
    title.trim() !== '' ||
    description.trim() !== '' ||
    !!date ||
    !!pickedLocation ||
    (addressTouched.current && address.trim() !== '');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const { sheetRef, scrollRef, handleProps } = useSheetDrag<HTMLDivElement>({
    onClose,
    enabled: !hidden,
    canClose: () => {
      if (!dirty) return true;
      setConfirmDiscard(true);
      return false;
    },
  });

  const DURATION_OPTIONS = [
    { mins: 30, label: t('create.duration30') },
    { mins: 60, label: t('create.duration60') },
    { mins: 120, label: t('create.duration120') },
    { mins: 180, label: t('create.duration180') },
    { mins: 240, label: t('create.duration240') },
  ];

  const handlePublish = async () => {
    if (!user) return;

    if (errors.title || errors.when || errors.location || !date || !time || !pickedLocation) {
      setShowErrors(true);
      haptic.warning();
      const first = errors.title ? titleRef.current : errors.when ? whenRef.current : locationRef.current;
      first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (errors.title) titleRef.current?.focus({ preventScroll: true });
      return;
    }

    const [hours, mins] = time.split(':').map(Number);
    const startsAt = new Date(date);
    startsAt.setHours(hours, mins, 0, 0);

    const parsed = eventSchema.safeParse({
      title,
      category,
      address: address || undefined,
      description: description || undefined,
      maxSpots,
      privacy,
      lng: pickedLocation.lng,
      lat: pickedLocation.lat,
      startsAt,
    });

    if (!parsed.success) {
      toast({
        title: t('create.checkEvent'),
        description: parsed.error.errors[0]?.message ?? 'Invalid input',
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);
    const v = parsed.data;
    const { error } = await supabase.from('events').insert({
      creator_id: user.id,
      title: v.title,
      category: v.category,
      address: v.address ?? null,
      description: v.description ?? null,
      starts_at: v.startsAt.toISOString(),
      ends_at: new Date(v.startsAt.getTime() + durationMins * 60 * 1000).toISOString(),
      max_spots: v.maxSpots,
      privacy: v.privacy,
      is_active: true,
      current_spots: 0,
      lng: v.lng,
      lat: v.lat,
      repeated_from: initial?.repeatedFrom ?? null,
    });

    if (error) {
      // El trigger de límite de creación lanza EVENT_RATE_LIMIT; sin pasar por
      // rpcMessage el usuario vería el texto crudo de Postgres.
      toast({ title: t('common.error'), description: rpcMessage(error.message, t), variant: 'destructive' });
    } else {
      haptic.success();
      toast({ title: t('create.created'), description: t('create.createdDesc') });
      onClose();
      // Con un plan publicado, los avisos de «alguien se unió» valen la pena.
      askForPush('created');
    }
    setLoading(false);
  };


  const errorText = (msg: string) => (
    <p className="mt-1.5 flex items-center gap-1.5 text-sm text-destructive">
      <AlertCircle aria-hidden="true" className="w-4 h-4 shrink-0" />
      {msg}
    </p>
  );

  return (
    // Mismo z que el sheet de editar, por encima de BottomNav (z-50): en z-30
    // el fondo oscuro quedaba por debajo y la barra se veía iluminada sobre la
    // pantalla atenuada, además de seguir siendo pulsable con el modal abierto.
    <div
      className={cn(
        'fixed inset-0 z-[60] bg-scrim animate-fade-in',
        // `invisible` y no un desmontaje: conserva el estado. Ademas quita el
        // elemento del hit-testing, asi que los toques llegan al mapa de
        // debajo para poner el pin.
        hidden && 'invisible pointer-events-none',
      )}
      onClick={requestClose}
      aria-hidden={hidden}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-event-title"
        className="absolute bottom-0 left-0 right-0 bg-card rounded-t-3xl shadow-lifted animate-slide-up max-h-[88dvh] flex flex-col mx-auto sm:max-w-[430px]"
        onClick={e => e.stopPropagation()}
      >
        {/* Cabecera fija: la X ya no se va con el scroll, y desde aquí se
            puede bajar la hoja con el dedo. */}
        <div {...handleProps} className="shrink-0 px-5 pt-1 pb-3 border-b border-border/60">
          <div className="drag-handle" />
          <div className="flex items-center justify-between">
            <h2 id="create-event-title" className="text-xl font-extrabold text-foreground">{t('create.title')}</h2>
            <button onClick={requestClose} aria-label={t('common.close')} className="w-11 h-11 -mr-2 inline-flex items-center justify-center text-muted-foreground">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 pt-4 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]">
          <div className="space-y-5">
            {initial && (
              <p className="flex items-start gap-2 rounded-xl bg-primary/10 text-primary text-sm font-medium p-3">
                <Repeat className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                {t('afterEvent.repeatBanner', { title: initial.title })}
              </p>
            )}
            {/* Title — con etiqueta visible: el placeholder desaparecía al
                escribir y el campo se quedaba sin nombre. */}
            <div>
              <label htmlFor="create-title" className="text-sm font-semibold text-foreground mb-2 block">{t('create.titleLabel')}</label>
              <Input
                id="create-title"
                ref={titleRef}
                placeholder={t('create.titlePh')}
                value={title}
                onChange={e => setTitle(e.target.value)}
                aria-invalid={showErrors && errors.title}
                className={cn('h-12 rounded-xl text-base', showErrors && errors.title && 'border-destructive')}
              />
              {showErrors && errors.title && errorText(t('create.errorTitle'))}
            </div>

            {/* Category chips */}
            <div>
              <label className="text-sm font-semibold text-foreground mb-2 block">{t('create.category')}</label>
              <div className="flex flex-wrap gap-2" role="group" aria-label={t('create.category')}>
                {EVENT_CATEGORIES.map(cat => (
                  <button
                    key={cat.key}
                    onClick={() => setCategory(cat.key)}
                    aria-pressed={category === cat.key}
                    className={cn(
                      'flex items-center gap-1.5 min-h-[44px] px-4 rounded-full text-xs font-semibold transition-all',
                      category === cat.key
                        ? 'text-white shadow-soft'
                        : 'bg-muted text-muted-foreground'
                    )}
                    style={category === cat.key ? { background: cat.color } : undefined}
                  >
                    {(() => { const Icon = CATEGORY_ICONS[cat.key]; return <Icon className="w-4 h-4" />; })()}
                    <span>{t('categories.' + cat.key)}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Date & Time */}
            <div ref={whenRef}>
              <label className="text-sm font-semibold text-foreground mb-1 block">{t('create.when')}</label>
              <Button
                type="button"
                variant="outline"
                onClick={() => setWhenOpen(true)}
                aria-invalid={showErrors && errors.when}
                className={cn(
                  'h-12 w-full justify-start text-left font-normal rounded-xl',
                  !startsAtPreview && 'text-muted-foreground',
                  showErrors && errors.when && 'border-destructive',
                )}
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {startsAtPreview
                  // Con la hora de fin según la duración: «Hoy · 19:00 – 21:00».
                  ? formatWhen(
                      startsAtPreview.toISOString(),
                      new Date(startsAtPreview.getTime() + durationMins * 60_000).toISOString(),
                      { range: true },
                    )
                  : <span>{t('create.pickWhen')}</span>}
              </Button>
              {showErrors && errors.when && errorText(startsAtPreview ? t('create.errorPast') : t('create.errorWhen'))}
            </div>
            {/* Duration */}
            <div>
              <label className="text-sm font-semibold text-foreground mb-2 block">{t('create.duration')}</label>
              <div className="flex flex-wrap gap-2" role="group" aria-label={t('create.duration')}>
                {DURATION_OPTIONS.map(opt => (
                  <button
                    key={opt.mins}
                    type="button"
                    onClick={() => setDurationMins(opt.mins)}
                    aria-pressed={durationMins === opt.mins}
                    className={cn(
                      'inline-flex items-center justify-center min-h-[44px] px-4 rounded-full text-xs font-semibold transition-all',
                      durationMins === opt.mins
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Location - Pick on map.

                Ya no se enseñan lat/lng: son exactas y no significan nada
                para quien organiza. Se guardan igual, solo no se pintan.
                Cuando el geocoding no da nombre, la etiqueta es neutra —
                NUNCA se vuelve a caer en las coordenadas. */}
            <div ref={locationRef}>
              <label className="text-sm font-semibold text-foreground mb-2 block">{t('create.location')}</label>
              {pickedLocation ? (
                <div className="flex items-center gap-3 p-3 bg-primary/10 rounded-xl border border-primary/20">
                  <MapPin className="w-5 h-5 text-primary flex-shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-foreground">
                      {t('create.locationConfirmed')}
                    </span>
                    <span className="block text-xs text-muted-foreground truncate">
                      {lookingUp
                        ? t('create.locationLooking')
                        : placeName ?? t('create.locationUnnamed')}
                    </span>
                  </span>
                  <button
                    onClick={onPickLocation}
                    className="inline-flex items-center min-h-[44px] text-xs font-semibold text-primary underline flex-shrink-0"
                  >
                    {t('create.locationChange')}
                  </button>
                </div>
              ) : (
                <button
                  onClick={onPickLocation}
                  className={cn(
                    'w-full flex items-center gap-3 p-3 bg-muted rounded-xl text-left hover:bg-muted/80 transition-colors',
                    showErrors && errors.location && 'ring-1 ring-destructive',
                  )}
                >
                  <MapPin className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                  <span className="flex-1">
                    <span className="block text-sm font-semibold text-foreground">
                      {t('create.locationQuestion')}
                    </span>
                    <span className="block text-xs text-muted-foreground mt-0.5">
                      {t('create.locationHint')}
                    </span>
                  </span>
                </button>
              )}
              {showErrors && errors.location && errorText(t('create.errorLocation'))}
              <label htmlFor="create-place" className="text-sm font-semibold text-foreground mt-4 mb-2 block">
                {t('create.placeNameLabel')} <span className="font-normal text-muted-foreground">({t('common.optional')})</span>
              </label>
              <Input
                id="create-place"
                placeholder={t('create.placeNamePh')}
                value={address}
                onChange={e => { addressTouched.current = true; setAddress(e.target.value); }}
                className="h-12 rounded-xl text-base"
              />
            </div>

            {/* Max spots stepper */}
            <div>
              <label className="text-sm font-semibold text-foreground mb-2 block">{t('create.maxSpots')}</label>
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setMaxSpots(Math.max(2, maxSpots - 1))}
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
            </div>

            {/* Description */}
            <div>
              <label htmlFor="create-description" className="text-sm font-semibold text-foreground mb-2 block">
                {t('create.descriptionLabel')} <span className="font-normal text-muted-foreground">({t('common.optional')})</span>
              </label>
              <Textarea
                id="create-description"
                placeholder={t('create.descriptionPh2')}
                value={description}
                onChange={e => setDescription(e.target.value)}
                className="rounded-xl min-h-[80px]"
              />
            </div>

            {/* Privacidad, en el formulario y no escondida tras un acordeon:
                decidir quien puede ver tu evento no es una opcion avanzada,
                y plegada nadie la abria — todos los eventos salian con el
                valor por defecto sin haberlo elegido. */}
            <PrivacySelector value={privacy} onChange={setPrivacy} />

            {/* Publish: siempre pulsable. Si falta algo, lo dice aquí mismo. */}
            <div className="space-y-2">
              {showErrors && missing.length > 0 && (
                <p role="alert" className="text-sm text-destructive text-center">
                  {t('create.missingSummary', {
                    list: missing.length > 1
                      ? `${missing.slice(0, -1).join(', ')} ${t('common.and')} ${missing[missing.length - 1]}`
                      : missing[0],
                  })}
                </p>
              )}
              <Button
                onClick={handlePublish}
                disabled={loading}
                className="w-full h-12 rounded-xl font-bold text-base"
              >
                {loading ? t('create.publishing') : t('create.publish')}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {whenOpen && (
        <DateTimeWheel
          value={date && time ? combineDateTime(date, time) : null}
          minDate={new Date()}
          title={t('create.when')}
          onCancel={() => setWhenOpen(false)}
          onConfirm={(d) => {
            setDate(d);
            setTime(toTimeValue(d));
            setWhenOpen(false);
          }}
        />
      )}

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('create.discardTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('create.discardDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('create.keepEditing')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={onClose}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('create.discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
