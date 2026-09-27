import { useTranslation } from 'react-i18next';
import { BellRing } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { registerPush } from '@/lib/push';
import { haptic } from '@/lib/haptics';
import { usePushPrimerStore } from '@/stores/pushPrimerStore';
import { useSheetDrag } from '@/hooks/useSheetDrag';

/**
 * Tarjeta que prepara el diálogo de notificaciones del sistema.
 * La abre `askForPush()` después de unirse, crear un plan o pedir amistad.
 */
export function PushPrimer() {
  const { t } = useTranslation();
  const reason = usePushPrimerStore((s) => s.reason);
  const snooze = usePushPrimerStore((s) => s.snooze);
  const close = usePushPrimerStore((s) => s.close);
  const { sheetRef, handleProps } = useSheetDrag<HTMLDivElement>({ onClose: snooze, enabled: !!reason });

  if (!reason) return null;

  const accept = async () => {
    close();
    haptic.light();
    await registerPush({ ask: true });
  };

  return (
    <div className="fixed inset-0 z-[75] bg-scrim animate-fade-in" onClick={snooze}>
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="push-primer-title"
        className="absolute bottom-0 inset-x-0 mx-auto sm:max-w-[430px] bg-card rounded-t-3xl shadow-lifted animate-slide-up px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]"
        onClick={(e) => e.stopPropagation()}
      >
        <div {...handleProps} className="pt-1 pb-2">
          <div className="drag-handle" />
        </div>
        <div className="flex flex-col items-center text-center gap-3">
          <span className="w-14 h-14 rounded-2xl bg-primary/10 text-primary flex items-center justify-center" aria-hidden="true">
            <BellRing className="w-7 h-7" />
          </span>
          <h2 id="push-primer-title" className="text-xl font-extrabold text-foreground">{t('pushPrimer.title')}</h2>
          <p className="text-sm text-muted-foreground max-w-[32ch]">{t(`pushPrimer.body.${reason}`)}</p>
        </div>
        <div className="mt-6 flex flex-col gap-2">
          <Button onClick={() => void accept()} className="h-12 rounded-xl font-bold">
            {t('pushPrimer.yes')}
          </Button>
          <Button variant="ghost" onClick={snooze} className="h-12 rounded-xl font-semibold text-muted-foreground">
            {t('pushPrimer.notNow')}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground text-center">{t('pushPrimer.footnote')}</p>
      </div>
    </div>
  );
}
