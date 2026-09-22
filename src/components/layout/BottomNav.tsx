import { Map, CalendarDays, Users, UserCircle } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useNotificationStore } from '@/stores/notificationStore';

const tabs = [
  { path: '/', icon: Map, key: 'map' as const },
  { path: '/events', icon: CalendarDays, key: 'events' as const },
  { path: '/friends', icon: Users, key: 'friends' as const },
  { path: '/profile', icon: UserCircle, key: 'profile' as const },
];

export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { joinRequests, friendRequests, unreadMessages, approvals, groupInvites, eventChatUnread } = useNotificationStore();

  // Amigos concentra dos cosas que esperan respuesta: quien te ha agregado y
  // quien te ha escrito.
  const badges: Record<string, number> = {
    // Mis eventos junta las dos direcciones: quien espera que le apruebes y
    // los eventos en los que acaban de aprobarte a ti.
    // y los chats de las actividades, que viven dentro de cada una.
    '/events': joinRequests + approvals + eventChatUnread,
    '/friends': friendRequests + unreadMessages + groupInvites,
  };

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 glass border-t border-border safe-bottom">
      <div className="mx-auto sm:max-w-[430px] flex items-center justify-around h-16">
        {tabs.map(({ path, icon: Icon, key }) => {
          const active = location.pathname === path;
          const count = badges[path] ?? 0;
          return (
            <button
              key={path}
              onClick={() => navigate(path)}
              // Ancla para el recorrido de bienvenida, que mide dónde está
              // cada pestaña para colocarle el globo encima. Con data-* y no
              // con un ref porque la barra vive en el AppShell y el recorrido
              // en MapHome: pasar refs entre esos dos sería atarlos.
              data-tour={key}
              className={cn(
                'flex flex-col items-center gap-0.5 px-4 py-2 min-w-[64px]',
                'transition-[color,transform] duration-200 active:scale-95',
                active ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              <span className="relative">
                <Icon
                  className={cn(
                    'w-6 h-6 transition-transform duration-200',
                    active && 'scale-110'
                  )}
                  strokeWidth={active ? 2.5 : 1.8}
                />
                {count > 0 && (
                  <span
                    aria-label={t('notifications.pending', { count })}
                    className="absolute -top-1.5 -right-2 min-w-[20px] h-5 px-1 rounded-full bg-destructive text-destructive-foreground text-xs font-bold flex items-center justify-center"
                  >
                    {count > 9 ? '9+' : count}
                  </span>
                )}
              </span>
              <span className="text-xs font-semibold">{t(`bottomNav.${key}`)}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
