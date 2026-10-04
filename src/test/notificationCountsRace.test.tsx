/**
 * Los contadores de la barra inferior se piden desde varios sitios a la vez
 * (tiempo real, volver a la app, salir de un chat) y las respuestas no llegan
 * en orden. Lo que se fija: manda la ÚLTIMA petición lanzada, no la última
 * respuesta recibida.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const pendientes: Array<(unread: number) => void> = [];

vi.mock('@/integrations/supabase/client', () => {
  const channel = { on: () => channel, subscribe: () => channel };
  return {
    supabase: {
      rpc: vi.fn(() => new Promise((resolve) => {
        pendientes.push((unread) => resolve({ data: [{ unread_messages: unread }], error: null }));
      })),
      channel: () => channel,
      removeChannel: () => {},
    },
  };
});

import { useNotificationSync } from '@/hooks/useNotificationSync';
import { useAuthStore } from '@/stores/authStore';
import { useNotificationStore } from '@/stores/notificationStore';

beforeEach(() => {
  pendientes.length = 0;
  useNotificationStore.getState().reset();
  useAuthStore.setState({ user: { id: 'u1' } } as never);
});

describe('notification_counts fuera de orden', () => {
  it('una respuesta vieja que llega tarde no pisa a la nueva', async () => {
    const { result } = renderHook(() => useNotificationSync());
    // La del montaje (vieja: 3 sin leer) y otra tras marcar leído (nueva: 0).
    act(() => { void result.current(); });
    expect(pendientes).toHaveLength(2);

    await act(async () => { pendientes[1](0); });
    expect(useNotificationStore.getState().unreadMessages).toBe(0);

    await act(async () => { pendientes[0](3); });
    expect(useNotificationStore.getState().unreadMessages).toBe(0);
  });

  it('en orden, la última sigue siendo la que vale', async () => {
    const { result } = renderHook(() => useNotificationSync());
    act(() => { void result.current(); });
    await act(async () => { pendientes[0](3); });
    await act(async () => { pendientes[1](1); });
    expect(useNotificationStore.getState().unreadMessages).toBe(1);
  });
});
