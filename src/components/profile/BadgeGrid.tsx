import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { BADGE_DEFINITIONS } from '@/lib/constants';
import { BADGE_ICONS, type BadgeType } from '@/lib/categoryIcons';
import { BADGE_TARGETS } from '@/lib/badges';
import { regionalLocale } from '@/lib/datetime';
import { useSheetDrag } from '@/hooks/useSheetDrag';
import { cn } from '@/lib/utils';

interface Props {
  /** Las conseguidas, con su fecha. Lo que no esté aquí sigue bloqueado. */
  earned: Partial<Record<string, string>>;
  /** Cuánto lleva cada una. null si todavía no se sabe (cargando, o falló). */
  progress: Record<BadgeType, number> | null;
}

/**
 * Las insignias del perfil, y el detalle de cada una.
 *
 * La tarjeta ya decía cómo se gana y cuánto falta, pero no respondía al
 * toque: una insignia conseguida solo decía «¡Conseguida!», sin qué
 * significa ni desde cuándo la tienes. Ahora cada una es un botón que abre
 * una hoja con todo eso.
 */
export function BadgeGrid({ earned, progress }: Props) {
  const { t } = useTranslation();
  // La insignia elegida se guarda aparte de si la hoja está abierta: al
  // cerrar tiene que seguir pintada mientras dura la animación de salida.
  const [selected, setSelected] = useState<BadgeType | null>(null);
  const [open, setOpen] = useState(false);
  /** La insignia que abrió la hoja: al cerrar, el foco vuelve a ella. */
  const openerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        {BADGE_DEFINITIONS.map((badge) => {
          const isEarned = badge.type in earned;
          const target = BADGE_TARGETS[badge.type];
          const current = isEarned ? target : progress?.[badge.type] ?? 0;
          const Icon = BADGE_ICONS[badge.type];
          const status = isEarned ? t('badges.earned') : t(`badges.how.${badge.type}`, { count: target });
          return (
            <button
              key={badge.type}
              type="button"
              onClick={(e) => { openerRef.current = e.currentTarget; setSelected(badge.type); setOpen(true); }}
              aria-haspopup="dialog"
              // El nombre se da entero: sin esto el lector de pantalla leería
              // el «3/5» de abajo como «tres barra cinco».
              aria-label={[
                t('badges.' + badge.type),
                status,
                !isEarned && progress ? t('badges.progress', { current, target }) : null,
              ].filter(Boolean).join('. ')}
              className={cn(
                'flex flex-col gap-1.5 p-3 rounded-xl text-left active:scale-[0.98] transition-transform',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isEarned ? 'bg-primary/10' : 'bg-muted/50',
              )}
            >
              <Icon aria-hidden="true" className={cn('w-6 h-6', isEarned ? 'text-primary' : 'text-muted-foreground/60')} />
              <span className="text-xs font-bold text-foreground leading-tight">{t('badges.' + badge.type)}</span>
              {/* Bloqueada no basta: sin decir cómo se gana, la insignia
                  gris no invita a nada. */}
              <span className="text-[11px] text-muted-foreground leading-snug">{status}</span>
              {!isEarned && progress && (
                <span className="block w-full mt-auto pt-1">
                  <span className="block h-1.5 rounded-full bg-muted overflow-hidden">
                    <span className="block h-full bg-primary rounded-full" style={{ width: `${(current / target) * 100}%` }} />
                  </span>
                  <span className="block mt-1 text-[11px] font-semibold text-muted-foreground">
                    {current}/{target}
                  </span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Sobre Sheet (Radix): Escape, tocar fuera y foco atrapado dentro. El
          scroll del perfil se bloquea mientras está abierta y vuelve donde
          estaba. */}
      <Sheet open={open} onOpenChange={setOpen}>
        {selected && (
          <BadgeDetail
            type={selected}
            earnedAt={earned[selected]}
            isEarned={selected in earned}
            progress={progress?.[selected] ?? null}
            onClose={() => setOpen(false)}
            // Radix devuelve el foco a SU disparador, y aquí no hay: la hoja
            // se abre por estado. Sin esto el foco se perdía en el <body> y
            // quien navega con teclado o VoiceOver volvía al principio de la
            // pantalla.
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              openerRef.current?.focus();
            }}
          />
        )}
      </Sheet>
    </>
  );
}

function BadgeDetail({ type, earnedAt, isEarned, progress, onClose, onCloseAutoFocus }: {
  type: BadgeType;
  earnedAt: string | undefined;
  isEarned: boolean;
  progress: number | null;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { t, i18n } = useTranslation();
  // Bajar el dedo la cierra, como el resto de hojas de la app.
  const { sheetRef, scrollRef, handleProps } = useSheetDrag<HTMLDivElement>({ onClose });
  const Icon = BADGE_ICONS[type];
  const target = BADGE_TARGETS[type];
  const current = isEarned ? target : progress;

  const earnedDate = earnedAt && !Number.isNaN(Date.parse(earnedAt))
    ? new Intl.DateTimeFormat(regionalLocale(i18n.language ?? 'es'), { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(earnedAt))
    : null;
  const status = !isEarned
    ? t('badges.locked')
    : earnedDate ? t('badges.earnedOn', { date: earnedDate }) : t('badges.earned');

  return (
    <SheetContent
      ref={sheetRef}
      side="bottom"
      onCloseAutoFocus={onCloseAutoFocus}
      className="rounded-t-3xl p-0 gap-0 max-h-[85dvh] flex flex-col sm:max-w-[430px] sm:mx-auto"
    >
      <div {...handleProps} className="shrink-0 px-6 pt-1 pb-4">
        <div className="drag-handle" aria-hidden="true" />
        {/* pr-8: la X de cerrar de la hoja va en esa esquina. */}
        <div className="flex items-center gap-4 pr-8">
          <span
            aria-hidden="true"
            className={cn(
              'w-14 h-14 shrink-0 rounded-2xl flex items-center justify-center',
              isEarned ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground/70',
            )}
          >
            <Icon className="w-7 h-7" />
          </span>
          <div className="min-w-0">
            <SheetTitle className="text-xl font-extrabold leading-tight">{t('badges.' + type)}</SheetTitle>
            <p className={cn('text-sm font-semibold', isEarned ? 'text-primary' : 'text-muted-foreground')}>{status}</p>
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-6 space-y-5">
        <SheetDescription className="text-sm text-foreground">{t(`badges.about.${type}`)}</SheetDescription>

        <div>
          <h3 className="text-[13px] font-bold text-muted-foreground mb-1">{t('badges.howTitle')}</h3>
          <p className="text-sm text-foreground">{t(`badges.how.${type}`, { count: target })}</p>
        </div>

        {/* Sin dato no se pinta un «0 de 5» que sería mentira: puede ser que
            la consulta fallara, no que no lleves nada. */}
        {current !== null && (
          <div>
            <h3 className="text-[13px] font-bold text-muted-foreground mb-2">{t('badges.progressTitle')}</h3>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={target}
              aria-valuenow={current}
              aria-label={t('badges.progress', { current, target })}
              className="h-2 rounded-full bg-muted overflow-hidden"
            >
              <div className="h-full bg-primary rounded-full" style={{ width: `${(current / target) * 100}%` }} />
            </div>
            <p className="mt-1.5 text-sm font-semibold text-foreground">{t('badges.progress', { current, target })}</p>
          </div>
        )}
      </div>

      <div className="shrink-0 px-6 pt-5 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]">
        <Button variant="outline" onClick={onClose} className="w-full h-12 rounded-xl font-semibold">
          {t('common.close')}
        </Button>
      </div>
    </SheetContent>
  );
}
