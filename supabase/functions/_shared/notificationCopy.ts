/**
 * El texto de cada aviso, en español y en inglés.
 *
 * Lo usan la Edge Function notify-dispatch (la push) y la app (la bandeja),
 * para que las dos digan lo mismo. En la base solo hay IDs y banderas: los
 * nombres y títulos llegan aquí ya resueltos con los permisos de ese
 * momento, y si no llegan (persona bloqueada, evento que ya no se ve) se
 * dice algo genérico en vez de inventar.
 *
 * Sin dependencias, para poder probarlo en vitest.
 */

export type Locale = 'es' | 'en';

export interface CopyInput {
  type: string;
  count?: number | null;
  actor_name?: string | null;
  event_title?: string | null;
  group_name?: string | null;
  is_dm?: boolean | null;
  /** Solo si la persona quiere vistas previas; null si no. */
  preview?: string | null;
  data?: Record<string, unknown> | null;
}

export interface Copy {
  title: string;
  body: string;
}

const T = {
  es: {
    someone: 'Alguien',
    yourPlan: 'tu plan',
    group: 'tu grupo',
    app: 'Always Connected',
    newMessages: (n: number) => `${n} mensajes nuevos`,
    wrote: (a: string) => `${a} escribió en el chat`,
    revived: (a: string) => `${a} volvió a escribir en el chat`,
    mentioned: (a: string) => `${a} te mencionó`,
    tapToSee: 'Toca para ver el mensaje',
    announcementTitle: (e: string) => `Aviso del organizador · ${e}`,
    announcementBody: 'Hay un aviso importante en el chat',
    dmBody: 'Te envió un mensaje',
    joinRequestTitle: 'Nueva solicitud',
    joinRequest: (a: string, e: string) => `${a} quiere unirse a «${e}»`,
    approvalTitle: 'Ya estás dentro',
    approval: (e: string) => `Te aprobaron en «${e}»`,
    rejectedTitle: 'Solicitud no aceptada',
    rejected: (e: string) => `Tu solicitud para «${e}» no fue aceptada esta vez`,
    joinedOne: (a: string) => `${a} se unió a tu actividad`,
    joinedMany: (a: string, n: number) => `${a} y ${n} más se unieron a tu actividad`,
    reminderTitle: 'Tu plan empieza pronto',
    reminder: (e: string, when: string) => `«${e}» empieza ${when}`,
    startedTitle: 'Ya empezó',
    started: (e: string) => `«${e}» ya empezó. Registra tu asistencia para sumar puntos.`,
    changedTitle: 'Cambió un plan',
    changedTime: (e: string) => `Cambió la hora de «${e}»`,
    changedPlace: (e: string) => `Cambió el lugar de «${e}»`,
    changedPrivacy: (e: string) => `«${e}» ahora es solo para amigos`,
    changedOther: (e: string) => `Hay cambios en «${e}»`,
    cancelledTitle: 'Plan cancelado',
    cancelled: (e: string) => `Se canceló «${e}»`,
    repeatTitle: 'Se repite un plan',
    repeat: (a: string, e: string) => `${a} organizó otra vez «${e}». ¿Te apuntas?`,
    inviteTitle: (a: string) => `${a} te invitó a un plan`,
    invite: (e: string) => `«${e}». ¿Te apuntas?`,
    friendCreatedTitle: (a: string) => `${a} creó un plan`,
    friendCreated: (e: string) => `«${e}». ¿Te apuntas?`,
    friendJoinedTitle: 'Tus amigos se apuntan',
    friendJoinedOne: (a: string, e: string) => `${a} va a «${e}»`,
    friendJoinedMany: (a: string, n: number, e: string) => `${a} y ${n} amigos más van a «${e}»`,
    campusTitle: 'Nuevo plan en tu campus',
    campus: (e: string) => `«${e}». Quizá te interese.`,
    spotsTitle: 'Quedan pocos lugares',
    spots: (e: string, n: number) => (n === 1 ? `«${e}»: queda 1 lugar` : `«${e}»: quedan ${n} lugares`),
    digestTitle: 'Planes para estos días',
    digest: (n: number) => `Hay ${n} planes en tu campus en los próximos días`,
    friendRequestTitle: 'Solicitud de amistad',
    friendRequest: (a: string) => `${a} te quiere agregar`,
    friendAcceptedTitle: 'Nueva amistad',
    friendAccepted: (a: string) => `${a} aceptó tu solicitud`,
    groupInviteTitle: 'Te invitaron a un grupo',
    groupInvite: (a: string, g: string) => `${a} te invitó a «${g}»`,
    contactJoinedTitle: 'Alguien que conoces está aquí',
    contactJoined: (a: string) => `${a} se unió a Always Connected`,
    inviteAcceptedTitle: 'Aceptaron tu invitación',
    inviteAccepted: (a: string) => `${a} se unió con tu invitación`,
    suggestionTitle: 'Quizá conozcas a…',
    suggestion: (a: string) => `${a} está en Always Connected`,
    profileTitle: 'Completa tu perfil',
    profile: 'Añade una foto e intereses para que te encuentren y te recomendemos mejores planes.',
    verifPendingTitle: 'Te falta un paso',
    verifPending: 'Confirma el código que enviamos a tu correo institucional.',
    verifReminderTitle: 'Verifica tu universidad',
    verifReminder: 'Es opcional, pero da más confianza a quienes se unen a tus planes.',
    verifApprovedTitle: 'Universidad verificada',
    verifApproved: 'Tu cuenta ya aparece como verificada.',
    verifRejectedTitle: 'No se pudo verificar',
    verifRejected: 'Revisa la verificación universitaria en tu perfil.',
    securityTitle: 'Aviso de seguridad',
    securityEmail: 'El correo de tu cuenta cambió. Si no fuiste tú, escríbenos a soporte.',
    securityPassword: 'La contraseña de tu cuenta cambió. Si no fuiste tú, escríbenos a soporte.',
    securityOther: 'Hubo un cambio en tu cuenta.',
    promo: 'Novedades en Always Connected',
    fallback: 'Tienes un aviso nuevo',
    inMinutes: (m: number) => (m >= 1440 ? 'mañana' : m >= 60 ? `en ${Math.round(m / 60)} h` : `en ${m} min`),
  },
  en: {
    someone: 'Someone',
    yourPlan: 'your plan',
    group: 'your group',
    app: 'Always Connected',
    newMessages: (n: number) => `${n} new messages`,
    wrote: (a: string) => `${a} wrote in the chat`,
    revived: (a: string) => `${a} is back in the chat`,
    mentioned: (a: string) => `${a} mentioned you`,
    tapToSee: 'Tap to see the message',
    announcementTitle: (e: string) => `Organizer announcement · ${e}`,
    announcementBody: "There's an important announcement in the chat",
    dmBody: 'Sent you a message',
    joinRequestTitle: 'New request',
    joinRequest: (a: string, e: string) => `${a} wants to join “${e}”`,
    approvalTitle: "You're in",
    approval: (e: string) => `You were approved for “${e}”`,
    rejectedTitle: 'Request not accepted',
    rejected: (e: string) => `Your request for “${e}” wasn't accepted this time`,
    joinedOne: (a: string) => `${a} joined your activity`,
    joinedMany: (a: string, n: number) => `${a} and ${n} more joined your activity`,
    reminderTitle: 'Your plan starts soon',
    reminder: (e: string, when: string) => `“${e}” starts ${when}`,
    startedTitle: 'It has started',
    started: (e: string) => `“${e}” has started. Check in to earn points.`,
    changedTitle: 'A plan changed',
    changedTime: (e: string) => `The time of “${e}” changed`,
    changedPlace: (e: string) => `The place of “${e}” changed`,
    changedPrivacy: (e: string) => `“${e}” is now friends only`,
    changedOther: (e: string) => `There are changes to “${e}”`,
    cancelledTitle: 'Plan cancelled',
    cancelled: (e: string) => `“${e}” was cancelled`,
    repeatTitle: 'A plan is back',
    repeat: (a: string, e: string) => `${a} is organizing “${e}” again. Want to join?`,
    inviteTitle: (a: string) => `${a} invited you to a plan`,
    invite: (e: string) => `“${e}”. Want to join?`,
    friendCreatedTitle: (a: string) => `${a} created a plan`,
    friendCreated: (e: string) => `“${e}”. Want to join?`,
    friendJoinedTitle: 'Your friends are going',
    friendJoinedOne: (a: string, e: string) => `${a} is going to “${e}”`,
    friendJoinedMany: (a: string, n: number, e: string) => `${a} and ${n} more friends are going to “${e}”`,
    campusTitle: 'New plan on your campus',
    campus: (e: string) => `“${e}”. You might like it.`,
    spotsTitle: 'Few spots left',
    spots: (e: string, n: number) => (n === 1 ? `“${e}”: 1 spot left` : `“${e}”: ${n} spots left`),
    digestTitle: 'Plans for the next few days',
    digest: (n: number) => `There are ${n} plans on your campus in the next few days`,
    friendRequestTitle: 'Friend request',
    friendRequest: (a: string) => `${a} wants to add you`,
    friendAcceptedTitle: 'New friend',
    friendAccepted: (a: string) => `${a} accepted your request`,
    groupInviteTitle: 'You were invited to a group',
    groupInvite: (a: string, g: string) => `${a} invited you to “${g}”`,
    contactJoinedTitle: 'Someone you know is here',
    contactJoined: (a: string) => `${a} joined Always Connected`,
    inviteAcceptedTitle: 'Your invitation was accepted',
    inviteAccepted: (a: string) => `${a} joined with your invitation`,
    suggestionTitle: 'You might know…',
    suggestion: (a: string) => `${a} is on Always Connected`,
    profileTitle: 'Complete your profile',
    profile: 'Add a photo and interests so people can find you and we can recommend better plans.',
    verifPendingTitle: 'One step left',
    verifPending: 'Confirm the code we sent to your university email.',
    verifReminderTitle: 'Verify your university',
    verifReminder: "It's optional, but it builds trust with people who join your plans.",
    verifApprovedTitle: 'University verified',
    verifApproved: 'Your account now shows as verified.',
    verifRejectedTitle: "Couldn't verify",
    verifRejected: 'Check the university verification in your profile.',
    securityTitle: 'Security notice',
    securityEmail: "Your account email changed. If this wasn't you, contact support.",
    securityPassword: "Your account password changed. If this wasn't you, contact support.",
    securityOther: 'There was a change to your account.',
    promo: "What's new on Always Connected",
    fallback: 'You have a new notification',
    inMinutes: (m: number) => (m >= 1440 ? 'tomorrow' : m >= 60 ? `in ${Math.round(m / 60)} h` : `in ${m} min`),
  },
} as const;

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function renderNotification(input: CopyInput, locale: Locale = 'es'): Copy {
  const t = T[locale === 'en' ? 'en' : 'es'];
  const a = input.actor_name?.trim() || t.someone;
  const e = input.event_title?.trim() || t.yourPlan;
  const g = input.group_name?.trim() || t.group;
  const n = Math.max(1, num(input.count, 1));
  const p = input.preview?.trim() || null;
  const d = input.data ?? {};

  switch (input.type) {
    case 'event_message':
      if (n > 1) return { title: e, body: t.newMessages(n) + (p ? ` · ${a}: ${p}` : '') };
      return { title: e, body: p ? `${a}: ${p}` : d.revived ? t.revived(a) : t.wrote(a) };
    case 'chat_mention':
      return { title: t.mentioned(a), body: `${e}: ${p ?? t.tapToSee}` };
    case 'organizer_announcement':
      return { title: t.announcementTitle(e), body: p ?? t.announcementBody };
    case 'message':
      if (input.is_dm) return { title: a, body: n > 1 ? t.newMessages(n) : (p ?? t.dmBody) };
      return { title: g, body: n > 1 ? t.newMessages(n) + (p ? ` · ${a}: ${p}` : '') : `${a}: ${p ?? t.dmBody}` };
    case 'join_request':
      return { title: t.joinRequestTitle, body: t.joinRequest(a, e) };
    case 'approval':
      return { title: t.approvalTitle, body: t.approval(e) };
    case 'join_rejected':
      return { title: t.rejectedTitle, body: t.rejected(e) };
    case 'participant_joined':
      return { title: e, body: n > 1 ? t.joinedMany(a, n - 1) : t.joinedOne(a) };
    case 'event_reminder':
      return { title: t.reminderTitle, body: t.reminder(e, t.inMinutes(num(d.minutes, 60))) };
    case 'event_started':
      return { title: t.startedTitle, body: t.started(e) };
    case 'event_changed':
      return {
        title: t.changedTitle,
        body: d.change === 'time' ? t.changedTime(e) : d.change === 'place' ? t.changedPlace(e)
          : d.change === 'privacy' ? t.changedPrivacy(e) : t.changedOther(e),
      };
    case 'event_cancelled':
      return { title: t.cancelledTitle, body: t.cancelled(e) };
    case 'event_repeat':
      return { title: t.repeatTitle, body: t.repeat(a, e) };
    case 'event_invite':
      return { title: t.inviteTitle(a), body: t.invite(e) };
    case 'friend_created_event':
      return { title: t.friendCreatedTitle(a), body: t.friendCreated(e) };
    case 'friend_joined_event':
      return { title: t.friendJoinedTitle, body: n > 1 ? t.friendJoinedMany(a, n - 1, e) : t.friendJoinedOne(a, e) };
    case 'new_campus_event':
      return { title: t.campusTitle, body: t.campus(e) };
    case 'spots_low':
      return { title: t.spotsTitle, body: t.spots(e, Math.max(1, num(d.left, 2))) };
    case 'digest':
      return { title: t.digestTitle, body: t.digest(num(d.count, 3)) };
    case 'friend_request':
      return { title: t.friendRequestTitle, body: t.friendRequest(a) };
    case 'friend_accepted':
      return { title: t.friendAcceptedTitle, body: t.friendAccepted(a) };
    case 'group_invite':
      return { title: t.groupInviteTitle, body: t.groupInvite(a, g) };
    case 'contact_joined':
      return { title: t.contactJoinedTitle, body: t.contactJoined(a) };
    case 'invite_accepted':
      return { title: t.inviteAcceptedTitle, body: t.inviteAccepted(a) };
    case 'person_suggestion':
      return { title: t.suggestionTitle, body: t.suggestion(a) };
    case 'profile_incomplete':
      return { title: t.profileTitle, body: t.profile };
    case 'verification_pending':
      return { title: t.verifPendingTitle, body: t.verifPending };
    case 'verification_reminder':
      return { title: t.verifReminderTitle, body: t.verifReminder };
    case 'verification_approved':
      return { title: t.verifApprovedTitle, body: t.verifApproved };
    case 'verification_rejected':
      return { title: t.verifRejectedTitle, body: t.verifRejected };
    case 'security_alert':
      return {
        title: t.securityTitle,
        body: d.kind === 'email_changed' ? t.securityEmail : d.kind === 'password_changed' ? t.securityPassword : t.securityOther,
      };
    case 'promotional':
      return { title: t.app, body: t.promo };
    default:
      return { title: t.app, body: t.fallback };
  }
}
