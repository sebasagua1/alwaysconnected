import { useEffect, useMemo, useState } from 'react';
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
  /** Para distinguir a dos amigos con el mismo nombre. */
  major: string | null;
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

  // Se piden al abrir y NO dependen de `exclude`: la ficha relee quién va
  // cada vez que cambia el aforo (tiempo real), y antes eso volvía a pedir
  // la lista y vaciaba lo que la persona llevaba marcado.
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
      setFriends((data ?? []).filter((f) => f.id).map((f) => ({ id: f.id, name: f.name, avatar_url: f.avatar_url, major: f.major })));
    })();
    return () => { cancelled = true; };
  }, [open, t, toast]);

  // Quien se une mientras la hoja está abierta desaparece de la lista (y de
  // lo marcado) sin tocar al resto.
  const candidates = useMemo(() => {
    if (friends === null) return null;
    const dentro = new Set(exclude);
    return friends.filter((f) => !dentro.has(f.id));
  }, [friends, exclude]);
  const chosen = useMemo(
    () => (candidates ?? []).filter((f) => selected.has(f.id)).map((f) => f.id),
    [candidates, selected],
  );
  const full = chosen.length >= MAX;

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else if (chosen.length < MAX) next.add(id);
    return next;
  });

  const send = async () => {
    setSending(true);
    const { data, error } = await supabase.rpc('invite_friends_to_event', { _event_id: eventId, _friend_ids: chosen });
    setSending(false);
    if (error) {
      toast({ title: t('common.error'), description: rpcMessage(error.message, t), variant: 'destructive' });
      return;
    }
    const n = Number(data ?? 0);
    // El servidor se salta en silencio a quien ya tenía invitación (de
    // cualquiera), tiene estos avisos apagados o no puede ver la actividad.
    const skipped = chosen.length - n;
    toast(n === 0
      ? { title: t('inviteFriends.nobodyNew') }
      : { title: t('inviteFriends.sent', { count: n }), description: skipped > 0 ? t('inviteFriends.skipped', { count: skipped }) : undefined });
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Columna: cabecera y botón fijos, solo la lista hace scroll. Antes
          hacía scroll la hoja entera y, con muchos amigos, el botón de enviar
          quedaba al final y había que bajar hasta él. */}
      <SheetContent side="bottom" className="rounded-t-3xl max-h-[85dvh] flex flex-col gap-0 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]">
        <SheetHeader className="text-left">
          <SheetTitle>{t('inviteFriends.title')}</SheetTitle>
          <SheetDescription>{t('inviteFriends.desc')}</SheetDescription>
        </SheetHeader>

        {candidates === null ? (
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground mt-6" />
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground mt-6">{t('inviteFriends.empty')}</p>
        ) : (
          <ul className="mt-4 -mx-6 px-6 flex-1 min-h-0 overflow-y-auto divide-y divide-border">
            {candidates.map((f) => (
              <li key={f.id}>
                <label className="flex items-center gap-3 min-h-[52px] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(f.id)}
                    disabled={full && !selected.has(f.id)}
                    onChange={() => toggle(f.id)}
                    className="w-5 h-5 accent-[hsl(var(--primary))]"
                  />
                  <span aria-hidden="true">
                    <UserAvatar url={f.avatar_url} name={f.name} className="w-9 h-9 bg-muted" textClassName="text-xs text-muted-foreground" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium text-foreground truncate">{f.name ?? t('profile.student')}</span>
                    {f.major && <span className="block text-xs text-muted-foreground truncate">{f.major}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <div className="pt-3 mt-2 border-t border-border">
          {full && <p className="text-xs text-muted-foreground text-center mb-2">{t('inviteFriends.limit', { max: MAX })}</p>}
          <Button className="w-full h-12 rounded-xl font-bold gap-2" disabled={chosen.length === 0 || sending} onClick={send}>
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" aria-hidden="true" />}
            {t('inviteFriends.send', { count: chosen.length })}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
