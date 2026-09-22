import { create } from 'zustand';

export interface NotificationCounts {
  joinRequests: number;
  friendRequests: number;
  unreadMessages: number;
  /** Eventos a los que me han dejado entrar y todavía no he visto. */
  approvals: number;
  /** Invitaciones a grupos creados desde un evento, sin responder. */
  groupInvites: number;
  /** Mensajes sin leer en los chats de las actividades en las que estoy. */
  eventChatUnread: number;
}

interface NotificationState extends NotificationCounts {
  setCounts: (counts: NotificationCounts) => void;
  reset: () => void;
  /**
   * Lo rellena useNotificationSync al montarse. Existe para que una pantalla
   * que acaba de marcar algo como leído pueda refrescar los contadores:
   * marcar leído es un UPDATE sobre group_members, que no emite realtime, así
   * que nadie se enteraría por su cuenta.
   */
  refresh: () => void | Promise<void>;
  setRefresh: (fn: () => void | Promise<void>) => void;
}

const EMPTY: NotificationCounts = { joinRequests: 0, friendRequests: 0, unreadMessages: 0, approvals: 0, groupInvites: 0, eventChatUnread: 0 };

export const useNotificationStore = create<NotificationState>((set) => ({
  ...EMPTY,
  setCounts: (counts) => set(counts),
  reset: () => set(EMPTY),
  refresh: () => {},
  setRefresh: (refresh) => set({ refresh }),
}));
