import type { TFunction } from 'i18next';

/**
 * Las RPC lanzan códigos estables (RAISE EXCEPTION 'NOT_FRIENDS'), que llegan
 * al cliente dentro de un mensaje de Postgres del tipo
 * `... NOT_FRIENDS ...`. Aquí se traducen a texto para el usuario; cualquier
 * código no contemplado cae al mensaje crudo, que sigue siendo mejor que nada.
 */
const RPC_ERROR_KEYS: Record<string, string> = {
  NOT_AUTHENTICATED: 'rpcErrors.notAuthenticated',
  NOT_FRIENDS: 'rpcErrors.notFriends',
  NOT_A_MEMBER: 'rpcErrors.notAMember',
  CANNOT_INVITE_TO_DM: 'rpcErrors.cannotInviteToDm',
  GROUP_NOT_FOUND: 'rpcErrors.groupNotFound',
  INVALID_TARGET: 'rpcErrors.invalidTarget',
  EVENT_RATE_LIMIT: 'rpcErrors.eventRateLimit',
  // Los lanza el disparador guard_message_update al editar o borrar.
  MESSAGE_DELETED: 'rpcErrors.messageDeleted',
  EMPTY_MESSAGE: 'rpcErrors.emptyMessage',
  MESSAGE_FIELD_LOCKED: 'rpcErrors.messageLocked',
  // Los lanza set_profile_campus al elegir campus en el alta.
  CAMPUS_LOCKED: 'rpcErrors.campusLocked',
  CAMPUS_NOT_AVAILABLE: 'rpcErrors.campusNotAvailable',
  CAMPUS_NOT_ALLOWED: 'rpcErrors.campusNotAllowed',
  // Los lanza guard_friendship_write al pedir o aceptar amistad.
  FRIEND_SELF: 'rpcErrors.friendSelf',
  FRIEND_NOT_AVAILABLE: 'rpcErrors.friendNotAvailable',
  FRIEND_REQUEST_EXISTS: 'friends.alreadySent',
  FRIEND_REQUEST_INCOMING: 'rpcErrors.friendRequestIncoming',
  ALREADY_FRIENDS: 'rpcErrors.alreadyFriends',
  FRIEND_RATE_LIMIT: 'rpcErrors.friendRateLimit',
  FRIENDSHIP_FIELD_LOCKED: 'rpcErrors.friendshipLocked',
  // request_institution.
  REQUEST_RATE_LIMIT: 'rpcErrors.requestRateLimit',
  INVALID_REQUEST: 'rpcErrors.invalidRequest',
  // Después del evento (20260919).
  REPEAT_NOT_ALLOWED: 'rpcErrors.repeatNotAllowed',
  NOT_AN_ATTENDEE: 'rpcErrors.notAnAttendee',
  EVENT_NOT_STARTED: 'rpcErrors.eventNotStarted',
  INVITE_NOT_FOUND: 'rpcErrors.inviteNotFound',
  INVITE_ALREADY_ANSWERED: 'rpcErrors.inviteAlreadyAnswered',
};

export function rpcMessage(raw: string | undefined, t: TFunction): string {
  if (!raw) return t('common.error');
  const code = Object.keys(RPC_ERROR_KEYS).find((c) => raw.includes(c));
  return code ? t(RPC_ERROR_KEYS[code]) : raw;
}
