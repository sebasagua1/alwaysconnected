import { useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, WifiOff } from 'lucide-react';
import { bootStatusSlot, hideBootSplash, setBootStatusShown, useBootSplash } from '@/lib/bootSplash';

/**
 * Se pone junto a la pantalla de destino: cuando ESTO se monta, la pantalla
 * también, así que ya se puede quitar la de entrada.
 *
 * Tiene que ir dentro del mismo <Suspense> que la pantalla. Si esa pantalla es
 * diferida y su código aún no ha bajado, React no monta a ninguna de las dos
 * (enseña el fallback), y la pantalla de entrada sigue tapando la rueda.
 *
 * useLayoutEffect y no useEffect: corre antes de pintar, así que el fundido
 * empieza en el mismo fotograma en que aparece la pantalla de debajo.
 */
export function BootReady() {
  useLayoutEffect(() => {
    hideBootSplash();
  }, []);
  return null;
}

interface StartupStatusProps {
  /** 'slow': sigue intentándolo, pero avisa. 'error': ya no va a llegar solo. */
  tone: 'slow' | 'error';
  title: string;
  body: string;
  onRetry: () => void;
  /** Reintento en curso: el botón se desactiva y lo dice. */
  retrying?: boolean;
  secondary?: { label: string; onClick: () => void };
}

/**
 * Qué pasa cuando el arranque tarda o falla, con salida.
 *
 * Mientras está puesta la pantalla de entrada, el aviso se escribe DENTRO de
 * ella (portal): el azul y el logo se quedan y abajo aparece qué pasa y el
 * botón. Si ya no está (el perfil falla justo después de iniciar sesión, por
 * ejemplo), ocupa la pantalla con los colores de la app.
 */
export function StartupStatus({ tone, title, body, onRetry, retrying = false, secondary }: StartupStatusProps) {
  const { t } = useTranslation();
  const splashVisible = useBootSplash((s) => s.visible);
  const slot = splashVisible ? bootStatusSlot() : null;

  useEffect(() => {
    if (!slot) return;
    setBootStatusShown(true);
    return () => setBootStatusShown(false);
  }, [slot]);

  const retryLabel = retrying ? t('boot.retrying') : t('boot.retry');
  const role = tone === 'error' ? 'alert' : 'status';

  if (slot) {
    return createPortal(
      <div role={role} className="boot-status">
        <p className="boot-status__title">{title}</p>
        <p className="boot-status__body">{body}</p>
        <button type="button" className="boot-status__button" onClick={onRetry} disabled={retrying}>
          {retrying && <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin" />}
          {retryLabel}
        </button>
        {secondary && (
          <button type="button" className="boot-status__link" onClick={secondary.onClick} disabled={retrying}>
            {secondary.label}
          </button>
        )}
      </div>,
      slot,
    );
  }

  return (
    <div
      role={role}
      className="min-h-screen flex flex-col items-center justify-center gap-4 px-6 pt-safe safe-bottom text-center bg-background"
    >
      <WifiOff aria-hidden="true" className="w-10 h-10 text-muted-foreground" />
      <h1 className="text-xl font-bold text-foreground">{title}</h1>
      <p className="text-sm text-muted-foreground max-w-xs">{body}</p>
      <div className="flex flex-col gap-2 w-full max-w-[240px] mt-2">
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="inline-flex items-center justify-center gap-2 min-h-[44px] px-6 bg-primary text-primary-foreground rounded-xl font-semibold text-sm disabled:opacity-70"
        >
          {retrying && <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin" />}
          {retryLabel}
        </button>
        {secondary && (
          <button
            type="button"
            onClick={secondary.onClick}
            disabled={retrying}
            className="inline-flex items-center justify-center min-h-[44px] px-6 bg-muted text-muted-foreground rounded-xl font-semibold text-sm"
          >
            {secondary.label}
          </button>
        )}
      </div>
    </div>
  );
}
