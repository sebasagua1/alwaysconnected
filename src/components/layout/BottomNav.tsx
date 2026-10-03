import { useRef } from 'react';
import { Map, CalendarDays, Users, UserCircle } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { cn } from '@/lib/utils';
import { useNotificationStore } from '@/stores/notificationStore';
import { isFullScreenRoute, useUiStore } from '@/stores/uiStore';
import { crossfadeTo } from '@/lib/viewTransition';

gsap.registerPlugin(useGSAP);

/** Ancho de la barrita que marca la pestaña activa. */
const MARCA = 28;

const tabs = [
  { path: '/', icon: Map, key: 'map' as const },
  { path: '/events', icon: CalendarDays, key: 'events' as const },
  { path: '/friends', icon: Users, key: 'friends' as const },
  { path: '/profile', icon: UserCircle, key: 'profile' as const },
];

/**
 * El globo rojo de una pestaña. Solo vuelve a animarse cuando la cuenta SUBE
 * (llega algo nuevo): antes se remontaba con cualquier cambio de número, y
 * leer un chat —de 3 a 2— hacía saltar el badge como si hubiera entrado un
 * aviso.
 */
function NavBadge({ count, label }: { count: number; label: string }) {
  const prevRef = useRef(count);
  const bumpRef = useRef(0);
  if (count > prevRef.current) bumpRef.current += 1;
  prevRef.current = count;
  if (count <= 0) return null;
  return (
    <span
      aria-label={label}
      // La key cambia solo al subir: React monta un span nuevo y la
      // animación de entrada se repite.
      key={bumpRef.current}
      className="absolute -top-1.5 -right-2 min-w-[20px] h-5 px-1 rounded-full bg-destructive text-destructive-foreground text-xs font-bold flex items-center justify-center animate-scale-in"
    >
      {count > 9 ? '9+' : count}
    </span>
  );
}

export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { joinRequests, friendRequests, unreadMessages, approvals, groupInvites, eventChatUnread } = useNotificationStore();
  const navHiders = useUiStore((s) => s.navHiders);
  // Fuera en las conversaciones y mientras alguien la pida oculta (elegir
  // ubicación, por ejemplo). Se desmonta en vez de esconderse: así no queda
  // nada enfocable ni legible por VoiceOver detrás.
  const hidden = navHiders > 0 || isFullScreenRoute(location.pathname);

  // Amigos concentra dos cosas que esperan respuesta: quien te ha agregado y
  // quien te ha escrito.
  const badges: Record<string, number> = {
    // Mis eventos junta las dos direcciones: quien espera que le apruebes y
    // los eventos en los que acaban de aprobarte a ti.
    // y los chats de las actividades, que viven dentro de cada una.
    '/events': joinRequests + approvals + eventChatUnread,
    '/friends': friendRequests + unreadMessages + groupInvites,
  };

  // Barrita que se desliza hasta la pestaña activa.
  //
  // Antes la pestaña activa se distinguía solo por color e icono más grande,
  // y al cambiar de pestaña no había nada que conectara una con otra: el
  // color saltaba de sitio. La barra que viaja da continuidad, que es de lo
  // poco que se ve en TODAS las pantallas de la app.
  //
  // Se mide con offsetLeft en vez de getBoundingClientRect porque el
  // contenedor está centrado con mx-auto y lo que hace falta es la posición
  // dentro de la fila, no dentro de la ventana.
  const filaRef = useRef<HTMLDivElement>(null);
  const marcaRef = useRef<HTMLSpanElement>(null);
  const yaColocada = useRef(false);

  useGSAP(
    () => {
      const fila = filaRef.current;
      const marca = marcaRef.current;
      if (!fila || !marca) return;

      // Oculta: al volver se coloca de golpe, sin viajar desde donde estaba
      // la barra anterior, que ya no existe.
      if (hidden) { yaColocada.current = false; return; }
      const activa = fila.querySelector<HTMLElement>('[data-activa="true"]');
      // Una ruta que no es ninguna pestaña (un chat, por ejemplo): la barra se
      // esconde en vez de quedarse señalando la pestaña anterior, que sería
      // mentira.
      if (!activa) {
        gsap.to(marca, { autoAlpha: 0, duration: 0.15 });
        return;
      }

      const x = activa.offsetLeft + activa.offsetWidth / 2 - MARCA / 2;

      // La primera vez se coloca sin viajar: si no, al abrir la app la barra
      // se vería salir desde la izquierda.
      if (!yaColocada.current) {
        yaColocada.current = true;
        gsap.set(marca, { x, autoAlpha: 1 });
        return;
      }

      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.to(marca, {
          x,
          autoAlpha: 1,
          // Al mismo ritmo que el fundido entre pestañas (index.css):
          // 300 ms y curva simétrica, para que marca y pantalla lleguen
          // a la vez.
          duration: 0.3,
          ease: 'sine.inOut',
        });
      });
      mm.add('(prefers-reduced-motion: reduce)', () => {
        gsap.set(marca, { x, autoAlpha: 1 });
      });
      return () => mm.revert();
    },
    { dependencies: [location.pathname, hidden], scope: filaRef },
  );

  // Las pestañas no se apilan en el historial, igual que en iOS: cambiar de
  // pestaña SUSTITUYE la entrada actual. Así «atrás» (la flecha o el gesto de
  // deslizar desde el borde) vuelve siempre a la pantalla de la que vino un
  // detalle, y no va saltando por las pestañas que se tocaron antes.
  const goTo = (path: string, active: boolean) => {
    if (active) {
      // Tocar la pestaña en la que ya estás sube al principio, como en iOS.
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    // Fundido cruzado con la pantalla anterior (ver lib/viewTransition.ts).
    crossfadeTo(path, () => navigate(path, { replace: true }));
  };

  if (hidden) return null;

  return (
    <nav className="vt-bottom-nav fixed bottom-0 left-0 right-0 z-50 glass border-t border-border safe-bottom">
      <div ref={filaRef} className="relative mx-auto sm:max-w-[430px] flex items-center justify-around h-16">
        <span
          ref={marcaRef}
          aria-hidden="true"
          style={{ width: MARCA }}
          // invisible de partida: la coloca el efecto de arriba antes del
          // primer pintado, así no se ve aparecer en la esquina.
          className="pointer-events-none absolute left-0 top-0 h-[3px] rounded-full bg-primary opacity-0"
        />
        {tabs.map(({ path, icon: Icon, key }) => {
          const active = location.pathname === path;
          const count = badges[path] ?? 0;
          return (
            <button
              key={path}
              onClick={() => goTo(path, active)}
              aria-current={active ? 'page' : undefined}
              // Ancla para el recorrido de bienvenida, que mide dónde está
              // cada pestaña para colocarle el globo encima. Con data-* y no
              // con un ref porque la barra vive en el AppShell y el recorrido
              // en MapHome: pasar refs entre esos dos sería atarlos.
              data-tour={key}
              data-activa={active}
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
                <NavBadge count={count} label={t('notifications.pending', { count })} />
              </span>
              <span className="text-xs font-semibold">{t(`bottomNav.${key}`)}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
