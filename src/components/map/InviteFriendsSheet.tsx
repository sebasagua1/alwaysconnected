import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Send } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/ui/user-avatar';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { rpcMessage } from '@/lib/rpcErrors';

interface Friend {
  id: string;
  name: string | null;
  avatar_url: string | null;
}

/** Hasta 20 por vez, como exige invite_friends_to_event. */
const MAX = 20;

/**
 * Invitar amigos a una actividad. Manda un aviso (no una solicitud): cada
 * quien decide si se une. El servidor comprueba que sean amigos, que puedan
 * ver la actividad y que no estén ya dentro, y no repite la invitación.
 */
export function InviteFriendsSheet({ eventId, open, onOpenChange, exclude }: {
  eventId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Quienes ya están (no se ofrecen). */
  exclude: string[];
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSelected(new Set());
    (async () => {
      const { data, error } = await supabase.rpc('friends_page', { _limit: 100, _offset: 0 });
      if (cancelled) return;
      if (error) {
        setFriends([]);
        toast({ title: t('errors.friendsLoad'), variant: 'destructive' });
        return;
      }
      setFriends((data ?? []).filter((f) => f.id && !exclude.includes(f.id)).map((f) => ({ id: f.id, name: f.name, avatar_url: f.avatar_url })));
    })();
    return () => { cancelled = true; };
  }, [open, exclude, t, toast]);

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else if (next.size < MAX) next.add(id);
    return next;
  });

  const send = async () => {
    setSending(true);
    const { data, error } = await supabase.rpc('invite_friends_to_event', { _event_id: eventId, _friend_ids: [...selected] });
    setSending(false);
    if (error) {
      toast({ title: t('common.error'), description: rpcMessage(error.message, t), variant: 'destructive' });
      return;
    }
    const n = Number(data ?? 0);
    toast({ title: n > 0 ? t('inviteFriends.sent', { count: n }) : t('inviteFriends.nobodyNew') });
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-3xl max-h-[85dvh] overflow-y-auto pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]">
        <SheetHeader className="text-left">
          <SheetTitle>{t('inviteFriends.title')}</SheetTitle>
          <SheetDescription>{t('inviteFriends.desc')}</SheetDescription>
        </SheetHeader>

        {friends === null ? (
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground mt-6" />
        ) : friends.length === 0 ? (
          <p className="text-sm text-muted-foreground mt-6">{t('inviteFriends.empty')}</p>
        ) : (
          <ul className="mt-4 divide-y divide-border">
            {friends.map((f) => (
              <li key={f.id}>
                <label className="flex items-center gap-3 min-h-[52px] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(f.id)}
                    onChange={() => toggle(f.id)}
                    aria-label={f.name ?? t('profile.student')}
                    className="w-5 h-5 accent-[hsl(var(--primary))]"
                  />
                  <span aria-hidden="true">
                    <UserAvatar url={f.avatar_url} name={f.name} className="w-9 h-9 bg-muted" textClassName="text-xs text-muted-foreground" />
                  </span>
                  <span className="flex-1 min-w-0 text-sm font-medium text-foreground truncate">{f.name ?? t('profile.student')}</span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <Button className="w-full h-12 rounded-xl font-bold gap-2 mt-4" disabled={selected.size === 0 || sending} onClick={send}>
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" aria-hidden="true" />}
          {t('inviteFriends.send', { count: selected.size })}
        </Button>
      </SheetContent>
    </Sheet>
  );
}
