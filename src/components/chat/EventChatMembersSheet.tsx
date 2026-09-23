import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BellOff, Bell, Loader2, UserMinus, UserCheck } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { UserAvatar } from '@/components/ui/user-avatar';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { rpcMessage } from '@/lib/rpcErrors';

export interface ChatMember {
  user_id: string;
  name: string | null;
  avatar_url: string | null;
  is_organizer: boolean;
}

interface Removed {
  user_id: string;
  name: string | null;
  avatar_url: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId: string;
  members: ChatMember[];
  myId: string;
  isOrganizer: boolean;
  muted: boolean;
  onToggleMute: () => void;
  /** Tras expulsar o readmitir: la lista y el recuento cambian. */
  onChanged: () => void;
}

/**
 * Quién está en el chat de la actividad. Quien organiza puede quitar a
 * alguien (y deshacerlo): la base borra su participación, libera la plaza y
 * le corta el chat al instante; sus mensajes anteriores se quedan.
 */
export function EventChatMembersSheet({ open, onOpenChange, eventId, members, myId, isOrganizer, muted, onToggleMute, onChanged }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [removing, setRemoving] = useState<ChatMember | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [removed, setRemoved] = useState<Removed[]>([]);

  useEffect(() => {
    if (!open || !isOrganizer) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.rpc('event_removed_people', { _event_id: eventId });
      if (!cancelled) setRemoved(data ?? []);
    })();
    return () => { cancelled = true; };
  }, [open, isOrganizer, eventId]);

  const remove = async (m: ChatMember) => {
    setRemoving(null);
    setWorking(m.user_id);
    const { error } = await supabase.rpc('remove_event_participant', { _event_id: eventId, _user_id: m.user_id });
    setWorking(null);
    if (error) {
      toast({ title: t('common.error'), description: rpcMessage(error.message, t), variant: 'destructive' });
      return;
    }
    setRemoved((prev) => [{ user_id: m.user_id, name: m.name, avatar_url: m.avatar_url }, ...prev]);
    toast({ title: t('eventChat.removedToast', { name: m.name ?? t('profile.student') }) });
    onChanged();
  };

  const readmit = async (r: Removed) => {
    setWorking(r.user_id);
    const { error } = await supabase.rpc('readmit_event_participant', { _event_id: eventId, _user_id: r.user_id });
    setWorking(null);
    if (error) {
      toast({ title: t('common.error'), description: rpcMessage(error.message, t), variant: 'destructive' });
      return;
    }
    setRemoved((prev) => prev.filter((x) => x.user_id !== r.user_id));
    toast({ title: t('eventChat.readmittedToast', { name: r.name ?? t('profile.student') }) });
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-[300px] sm:w-[360px] overflow-y-auto pt-[calc(1.5rem+env(safe-area-inset-top,0px))]">
          <SheetHeader>
            <SheetTitle>{t('eventChat.members')}</SheetTitle>
            <SheetDescription>{t('eventChat.membersDesc')}</SheetDescription>
          </SheetHeader>

          <button
            onClick={onToggleMute}
            aria-pressed={muted}
            className="mt-4 w-full flex items-center gap-3 min-h-[48px] px-3 rounded-xl border border-border text-left"
          >
            {muted ? <BellOff className="w-4 h-4 text-muted-foreground" /> : <Bell className="w-4 h-4 text-primary" />}
            <span className="flex-1">
              <span className="block text-sm font-semibold text-foreground">
                {muted ? t('eventChat.mutedLabel') : t('eventChat.unmutedLabel')}
              </span>
              <span className="block text-xs text-muted-foreground">{t('eventChat.muteHelp')}</span>
            </span>
          </button>

          <ul className="mt-5 space-y-1">
            {members.map((m) => (
              <li key={m.user_id} className="flex items-center gap-3 min-h-[48px]">
                <UserAvatar url={m.avatar_url} name={m.name} className="w-9 h-9 bg-muted" textClassName="text-xs font-bold text-muted-foreground" />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-foreground truncate">{m.name ?? t('profile.student')}</span>
                  {(m.is_organizer || m.user_id === myId) && (
                    <span className="block text-xs text-muted-foreground">
                      {m.is_organizer ? t('event.organizer') : t('groups.you')}
                    </span>
                  )}
                </span>
                {isOrganizer && !m.is_organizer && m.user_id !== myId && (
                  <button
                    onClick={() => setRemoving(m)}
                    disabled={working === m.user_id}
                    aria-label={t('eventChat.removeMember', { name: m.name ?? t('profile.student') })}
                    className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-destructive disabled:opacity-50"
                  >
                    {working === m.user_id ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserMinus className="w-4 h-4" />}
                  </button>
                )}
              </li>
            ))}
          </ul>

          {isOrganizer && removed.length > 0 && (
            <div className="mt-6">
              <p className="text-[13px] font-semibold text-muted-foreground mb-2">{t('eventChat.removedPeople')}</p>
              <ul className="space-y-1">
                {removed.map((r) => (
                  <li key={r.user_id} className="flex items-center gap-3 min-h-[48px]">
                    <UserAvatar url={r.avatar_url} name={r.name} className="w-9 h-9 bg-muted" textClassName="text-xs text-muted-foreground" />
                    <span className="flex-1 min-w-0 text-sm text-foreground truncate">{r.name ?? t('profile.student')}</span>
                    <button
                      onClick={() => readmit(r)}
                      disabled={working === r.user_id}
                      className="inline-flex items-center gap-1 min-h-[44px] px-3 rounded-full bg-muted text-xs font-bold text-foreground disabled:opacity-50"
                    >
                      <UserCheck className="w-3.5 h-3.5" aria-hidden="true" />
                      {t('eventChat.readmit')}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('eventChat.removeMemberTitle', { name: removing?.name ?? t('profile.student') })}</AlertDialogTitle>
            <AlertDialogDescription>{t('eventChat.removeMemberDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removing && remove(removing)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('eventChat.removeMemberAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
