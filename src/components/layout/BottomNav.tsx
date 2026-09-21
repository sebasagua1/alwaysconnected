import { useRef } from 'react';
import { Map, CalendarDays, Users, UserCircle } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { cn } from '@/lib/utils';
import { useNotificationStore } from '@/stores/notificationStore';

gsap.registerPlugin(useGSAP);

/** Ancho de la barrita que marca la pestaña activa. */
const MARCA = 28;

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
  const { joinRequests, friendRequests, unreadMessages, approvals, groupInvites } = useNotificationStore();

  // Amigos concentra dos cosas que esperan respuesta: quien te ha agregado y
  // quien te ha escrito.
  const badges: Record<string, number> = {
    // Mis eventos junta las dos direcciones: quien espera que le apruebes y
    // los eventos en los que acaban de aprobarte a ti.
    '/events': joinRequests + approvals,
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
          duration: 0.34,
          // La misma curva que ya usan las hojas y las transiciones de
          // página: sale rápido y frena largo, como se mueve iOS.
          ease: 'power3.out',
        });
      });
      mm.add('(prefers-reduced-motion: reduce)', () => {
        gsap.set(marca, { x, autoAlpha: 1 });
      });
      return () => mm.revert();
    },
    { dependencies: [location.pathname], scope: filaRef },
  );

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 glass border-t border-border safe-bottom">
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
              onClick={() => navigate(path)}
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
                {count > 0 && (
                  <span
                    aria-label={t('notifications.pending', { count })}
                    // key con la cuenta: al cambiar el número React monta un
                    // span nuevo y la animación se repite. Sin esto solo
                    // entraría la primera vez y pasar de 1 a 2 sería mudo.
                    key={count}
                    className="absolute -top-1.5 -right-2 min-w-[20px] h-5 px-1 rounded-full bg-destructive text-destructive-foreground text-xs font-bold flex items-center justify-center animate-scale-in"
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
