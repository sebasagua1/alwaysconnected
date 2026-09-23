import { Bell } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useNotificationStore } from '@/stores/notificationStore';
import { cn } from '@/lib/utils';

/**
 * La campana del centro de notificaciones, con su contador. Va en la
 * cabecera de cada pestaña (y flotando sobre el mapa) en vez de ser una
 * quinta pestaña: la barra inferior se queda como estaba.
 */
export function NotificationBell({ className, floating = false }: { className?: string; floating?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const unread = useNotificationStore((s) => s.notificationsUnread);

  return (
    <button
      type="button"
      onClick={() => navigate('/notifications')}
      aria-label={unread > 0 ? t('notificationCenter.bellUnread', { count: unread }) : t('notificationCenter.bell')}
      className={cn(
        'relative w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        floating ? 'glass text-foreground border border-border shadow-soft' : 'text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      <Bell className="w-5 h-5" aria-hidden="true" />
      {unread > 0 && (
        <span
          aria-hidden="true"
          className="absolute -top-0.5 -right-0.5 min-w-[20px] h-5 px-1 rounded-full bg-destructive text-destructive-foreground text-[11px] font-bold flex items-center justify-center"
        >
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </button>
  );
}
