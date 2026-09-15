import { useCallback, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';
import { useNotificationStore } from '@/stores/notificationStore';

/**
 * Mantiene al día los contadores de la barra inferior. Se monta una sola vez
 * (AppShell): si cada pantalla montara su propia suscripción acabaríamos con
 * cuatro canales pidiendo lo mismo.
 */
export function useNotificationSync() {
  const { user } = useAuthStore();
  const setCounts = useNotificationStore((s) => s.setCounts);
  const reset = useNotificationStore((s) => s.reset);
  const setRefresh = useNotificationStore((s) => s.setRefresh);

  const refresh = useCallback(async () => {
    if (!user) return;
    // La RPC devuelve una sola fila con los tres números; contarlos desde el
    // cliente exigiría leer filas que la RLS no deja ver (las solicitudes de
    // mis eventos incluyen a gente cuyo perfil no puedo listar).
    const { data, error } = await supabase.rpc('notification_counts');
    if (error) return;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return;
    setCounts({
      joinRequests: Number(row.join_requests ?? 0),
      friendRequests: Number(row.friend_requests ?? 0),
      unreadMessages: Number(row.unread_messages ?? 0),
      approvals: Number(row.approvals ?? 0),
      // La base vieja no la devuelve: se queda en 0 hasta aplicar 20260919.
      groupInvites: Number((row as { group_invites?: number }).group_invites ?? 0),
    });
  }, [user, setCounts]);

  useEffect(() => { setRefresh(refresh); }, [refresh, setRefresh]);

  useEffect(() => {
    if (!user) {
      reset();
      return;
    }

    refresh();

    // Un cambio suele traer varios eventos seguidos (aprobar una solicitud
    // toca event_participants y events). Se agrupan para no lanzar una RPC
    // por cada uno.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 400);
    };

    // Filtros del lado del servidor donde el contador lo permite: sin ellos
    // cada fila que tocaba CUALQUIER usuario de la app despertaba a todos los
    // clientes conectados para pedir la misma RPC.
    const channel = supabase
      .channel('notification-counts')
      // Sin filtrar a propósito. `join_requests` cuenta las solicitudes de
      // OTRA gente a MIS eventos, y eso es un join contra events que no se
      // puede expresar como filtro de tiempo real. Filtrar por user_id
      // dejaría de contar justo lo que interesa.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'event_participants' }, scheduleRefresh)
      // `friend_requests` solo mira las dirigidas a mí.
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'friendships',
        filter: `addressee_id=eq.${user.id}`,
      }, scheduleRefresh)
      // Los mensajes propios no cuentan como no leídos (la RPC hace
      // `sender_id <> auth.uid()`), así que enviar uno no tiene por qué
      // provocar una recarga del contador.
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'messages',
        filter: `sender_id=neq.${user.id}`,
      }, scheduleRefresh)
      .subscribe();

    // Volver a la app tras un rato en segundo plano: el websocket pudo
    // caerse y perderse eventos por el camino.
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      supabase.removeChannel(channel);
    };
  }, [user, refresh, reset]);

  return refresh;
}
