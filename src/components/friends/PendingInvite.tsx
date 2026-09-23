import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { UserAvatar } from '@/components/ui/user-avatar';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks/use-toast';
import { registerMyIdentifiers, takePendingInvite } from '@/lib/contacts';

interface Inviter {
  inviter_id: string;
  name: string | null;
  avatar_url: string | null;
  relation: 'none' | 'outgoing' | 'incoming' | 'friends';
}

/** Cada cuánto se vuelve a registrar el correo verificado, si eres encontrable. */
const REGISTER_EVERY_MS = 24 * 3600 * 1000;
const REGISTER_KEY = 'ac_contacts_registered_at';

/**
 * Al entrar con una invitación pendiente: se canjea (cuenta para quien
 * invitó) y, si esa persona es visible, se ofrece agregarla. Nunca manda la
 * solicitud sola.
 *
 * De paso, una vez al día, renueva las huellas de tus identificadores si
 * elegiste que tus contactos te encuentren: si cambiaste de correo, la
 * base ya borró la huella vieja y aquí se pone la nueva.
 */
export function PendingInvite() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user, profile } = useAuthStore();
  const [inviter, setInviter] = useState<Inviter | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!user || !profile?.onboarding_completed) return;
    let cancelled = false;

    const code = takePendingInvite();
    if (code) {
      (async () => {
        const { data, error } = await supabase.rpc('redeem_invite', { _code: code });
        if (cancelled || error) return;
        const row = (data ?? [])[0];
        if (row && row.relation !== 'friends') setInviter(row);
      })();
    }

    (async () => {
      try {
        const last = Number(localStorage.getItem(REGISTER_KEY) ?? 0);
        if (Date.now() - last < REGISTER_EVERY_MS) return;
        const { data } = await supabase.rpc('my_contact_settings');
        const row = Array.isArray(data) ? data[0] : data;
        if (row?.discoverable) await registerMyIdentifiers();
        localStorage.setItem(REGISTER_KEY, String(Date.now()));
      } catch {
        // Se reintenta el próximo día: no es algo que la persona tenga que ver.
      }
    })();

    return () => { cancelled = true; };
  }, [user, profile?.onboarding_completed]);

  const add = async () => {
    if (!user || !inviter) return;
    setSending(true);
    const { error } = await supabase
      .from('friendships')
      .insert({ requester_id: user.id, addressee_id: inviter.inviter_id, status: 'pending' });
    setSending(false);
    setInviter(null);
    toast({ title: error && error.code !== '23505' ? t('common.error') : t('friends.requestSent') });
  };

  return (
    <AlertDialog open={inviter !== null} onOpenChange={(o) => !o && setInviter(null)}>
      <AlertDialogContent>
        <AlertDialogHeader className="items-center text-center">
          <UserAvatar url={inviter?.avatar_url} name={inviter?.name} className="w-16 h-16 bg-primary/10 mb-2" textClassName="text-xl text-primary" />
          <AlertDialogTitle>{t('invite.fromTitle', { name: inviter?.name ?? '' })}</AlertDialogTitle>
          <AlertDialogDescription>{t('invite.fromDesc')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('findFriends.notNow')}</AlertDialogCancel>
          {inviter?.relation === 'none' && (
            <AlertDialogAction disabled={sending} onClick={add}>{t('invite.addBack')}</AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
