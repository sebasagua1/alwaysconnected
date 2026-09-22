import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { es as esLocale, enUS } from 'date-fns/locale';
import { Repeat, UsersRound, UserPlus, Check, Loader2, ChevronRight } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { rpcMessage } from '@/lib/rpcErrors';
import { buildRepeatDraft } from '@/lib/repeatPlan';
import { UserAvatar } from '@/components/ui/user-avatar';
import type { MapEvent } from '@/stores/eventStore';

export interface Attendee {
  user_id: string;
  name: string | null;
  avatar_url: string | null;
  is_creator: boolean;
}

interface Props {
  event: MapEvent;
  attendees: Attendee[];
  myId: string;
  onClose: () => void;
}

type Relation = 'none' | 'sent' | 'friends';

/**
 * Lo que se ofrece cuando el evento ya terminó, a quien organizó o fue.
 *
 * Tres salidas y ninguna más, para que decidir sea rápido: agregar a quien
 * conociste, repetir el plan (se avisa a quienes fueron) o seguir en un grupo
 * (les llega una invitación). Es lo que hace que un evento lleve al siguiente.
 */
export function PostEventActions({ event, attendees, myId, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language?.startsWith('en') ? enUS : esLocale;
  const navigate = useNavigate();
  const { toast } = useToast();
  const [relations, setRelations] = useState<Record<string, Relation>>({});
  const [adding, setAdding] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);

  const others = useMemo(() => attendees.filter((a) => a.user_id !== myId), [attendees, myId]);
  const draft = useMemo(() => buildRepeatDraft(event), [event]);

  // Solo mis amistades: la RLS de friendships ya no deja leer más.
  useEffect(() => {
    if (others.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('friendships')
        .select('requester_id, addressee_id, status')
        .or(`requester_id.eq.${myId},addressee_id.eq.${myId}`);
      if (cancelled || !data) return;
      const next: Record<string, Relation> = {};
      for (const f of data) {
        const other = f.requester_id === myId ? f.addressee_id : f.requester_id;
        if (f.status === 'accepted') next[other] = 'friends';
        else if (f.status === 'pending' && !next[other]) next[other] = 'sent';
      }
      setRelations(next);
    })();
    return () => { cancelled = true; };
  }, [others.length, myId]);

  const addFriend = async (id: string) => {
    setAdding(id);
    const { error } = await supabase.from('friendships').insert({ requester_id: myId, addressee_id: id, status: 'pending' });
    setAdding(null);
    // Duplicada (23505) = ya había solicitud: para quien mira es lo mismo.
    if (error && error.code !== '23505') {
      toast({ title: t('common.error'), description: rpcMessage(error.message, t), variant: 'destructive' });
      return;
    }
    setRelations((r) => ({ ...r, [id]: 'sent' }));
  };

  const repeat = () => {
    navigate('/', { state: { repeat: { ...draft, startsAt: draft.startsAt.toISOString() } } });
    onClose();
  };

  const createGroup = async () => {
    setCreatingGroup(true);
    const { data, error } = await supabase.rpc('create_group_from_event', { _event_id: event.id });
    setCreatingGroup(false);
    if (error || !data) {
      toast({ title: t('common.error'), description: rpcMessage(error?.message, t), variant: 'destructive' });
      return;
    }
    toast({
      title: others.length === 0 ? t('afterEvent.groupCreatedNone') : t('afterEvent.groupCreated', { count: others.length }),
    });
    onClose();
    navigate(`/groups/${data}`, { state: { from: 'groups' } });
  };

  const toMeet = others.filter((a) => relations[a.user_id] !== 'friends');

  return (
    <section aria-labelledby="after-event-title" className="mb-4 rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-3">
      <h4 id="after-event-title" className="text-sm font-bold text-foreground">{t('afterEvent.title')}</h4>

      {toMeet.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground">{t('afterEvent.metSomeone')}</p>
          <ul className="flex gap-3 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
            {toMeet.map((a) => {
              const rel = relations[a.user_id] ?? 'none';
              const first = a.name?.split(' ')[0] ?? '?';
              return (
                <li key={a.user_id} className="shrink-0 w-[72px] flex flex-col items-center gap-1 text-center">
                  <UserAvatar url={a.avatar_url} name={a.name} className="w-11 h-11 bg-muted" textClassName="text-sm font-bold text-muted-foreground" />
                  <span className="w-full text-[11px] font-medium text-foreground truncate">{first}</span>
                  {rel === 'none' ? (
                    <button
                      type="button"
                      onClick={() => addFriend(a.user_id)}
                      disabled={adding === a.user_id}
                      aria-label={t('afterEvent.addAria', { name: a.name ?? first })}
                      className="inline-flex items-center justify-center gap-1 min-h-[32px] px-2.5 rounded-full bg-primary text-primary-foreground text-[11px] font-bold disabled:opacity-60"
                    >
                      {adding === a.user_id ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" aria-hidden="true" />}
                      {t('afterEvent.add')}
                    </button>
                  ) : (
                    <span className="inline-flex items-center gap-1 min-h-[32px] px-2 text-[11px] font-semibold text-muted-foreground">
                      <Check className="w-3 h-3" aria-hidden="true" />
                      {t('afterEvent.sent')}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <button
        type="button"
        onClick={repeat}
        className="w-full flex items-center gap-3 min-h-[56px] px-3 rounded-xl bg-card border border-border text-left"
      >
        <span className="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Repeat className="w-4 h-4" aria-hidden="true" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-bold text-foreground">{t('afterEvent.repeat')}</span>
          <span className="block text-xs text-muted-foreground truncate">
            {t('afterEvent.repeatWhen', { when: format(draft.startsAt, 'EEE d MMM · HH:mm', { locale: dateLocale }) })}
          </span>
        </span>
        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
      </button>

      {others.length > 0 && (
        <button
          type="button"
          onClick={createGroup}
          disabled={creatingGroup}
          className="w-full flex items-center gap-3 min-h-[56px] px-3 rounded-xl bg-card border border-border text-left disabled:opacity-60"
        >
          <span className="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
            {creatingGroup ? <Loader2 className="w-4 h-4 animate-spin" /> : <UsersRound className="w-4 h-4" aria-hidden="true" />}
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-bold text-foreground">{creatingGroup ? t('afterEvent.creatingGroup') : t('afterEvent.group')}</span>
            <span className="block text-xs text-muted-foreground">{t('afterEvent.groupHint')}</span>
          </span>
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
        </button>
      )}
    </section>
  );
}
