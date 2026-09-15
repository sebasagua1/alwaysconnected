import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Check, X as XIcon, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useNotificationStore } from '@/stores/notificationStore';
import { useToast } from '@/hooks/use-toast';
import { rpcMessage } from '@/lib/rpcErrors';
import { UserAvatar } from '@/components/ui/user-avatar';
import type { Database } from '@/integrations/supabase/types';

type Invite = Database['public']['Functions']['my_group_invites']['Returns'][number];

/**
 * Invitaciones a grupos que salieron de un evento. Se entra solo aceptando:
 * nadie aparece en un chat sin haberlo decidido.
 *
 * Se relee cuando cambia el contador del globo, que es lo que se entera de
 * que llegó una nueva (la tabla no se puede escuchar por tiempo real: no
 * tiene lectura directa).
 */
export function GroupInvites() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const count = useNotificationStore((s) => s.groupInvites);
  const refreshCounts = useNotificationStore((s) => s.refresh);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('my_group_invites');
    // Antes de aplicar la migración la RPC no existe: simplemente no hay nada.
    if (!error) setInvites(data ?? []);
  }, []);

  useEffect(() => { load(); }, [load, count]);

  const respond = async (inv: Invite, accept: boolean) => {
    setBusy(inv.invite_id);
    const { data, error } = await supabase.rpc('respond_group_invite', { _invite_id: inv.invite_id, _accept: accept });
    setBusy(null);
    setInvites((list) => list.filter((i) => i.invite_id !== inv.invite_id));
    refreshCounts();
    if (error) {
      toast({ title: t('common.error'), description: rpcMessage(error.message, t), variant: 'destructive' });
      return;
    }
    if (accept && data) {
      toast({ title: t('groupInvites.accepted') });
      navigate(`/groups/${data}`, { state: { from: 'groups' } });
    } else {
      toast({ title: t('groupInvites.declined') });
    }
  };

  if (invites.length === 0) return null;

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground">
        {t('groupInvites.title')} ({invites.length})
      </h2>
      {invites.map((inv) => (
        <div key={inv.invite_id} className="flex items-center gap-3 bg-card rounded-xl p-3 shadow-soft">
          <UserAvatar url={inv.inviter_avatar} name={inv.inviter_name} className="w-10 h-10 bg-primary/10" textClassName="text-sm text-primary" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-sm text-foreground truncate">{inv.group_name}</p>
            <p className="text-xs text-muted-foreground truncate">
              {inv.event_title
                ? t('groupInvites.fromEvent', { name: inv.inviter_name ?? '', event: inv.event_title })
                : t('groupInvites.from', { name: inv.inviter_name ?? '' })}
            </p>
          </div>
          <div className="flex gap-3 shrink-0">
            <button
              onClick={() => respond(inv, true)}
              disabled={busy === inv.invite_id}
              aria-label={t('groupInvites.acceptAria', { group: inv.group_name })}
              className="w-11 h-11 rounded-full bg-primary flex items-center justify-center text-primary-foreground disabled:opacity-60"
            >
              {busy === inv.invite_id ? <Loader2 className="w-5 h-5 animate-spin" /> : <Check className="w-5 h-5" />}
            </button>
            <button
              onClick={() => respond(inv, false)}
              disabled={busy === inv.invite_id}
              aria-label={t('groupInvites.declineAria', { group: inv.group_name })}
              className="w-11 h-11 rounded-full bg-muted flex items-center justify-center text-muted-foreground disabled:opacity-60"
            >
              <XIcon className="w-5 h-5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
