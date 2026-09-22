import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/integrations/supabase/client';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks/use-toast';
import { rpcMessage } from '@/lib/rpcErrors';

export type FriendRelation = 'none' | 'outgoing' | 'incoming' | 'friends';

export interface FriendTarget {
  id: string;
  relation: FriendRelation;
  friendship_id: string | null;
}

export type RelationOverride = Pick<FriendTarget, 'relation' | 'friendship_id'>;

/**
 * Agregar, aceptar y cancelar solicitudes de amistad, con la interfaz
 * optimista y la vuelta atrás si el servidor dice que no.
 *
 * Lo que cambia se guarda por id y encima de la lista que llegó
 * (`withOverride`), así una misma persona se ve igual en la búsqueda, en las
 * sugerencias, en los contactos y en su ficha sin volver a pedir nada.
 *
 * Sale de FindPeople para que "Encontrar amigos" (contactos) use las mismas
 * reglas en vez de una copia.
 */
export function useFriendActions(onFriendsChanged?: () => void) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuthStore();
  const [overrides, setOverrides] = useState<Record<string, RelationOverride>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const setRelation = useCallback((id: string, o: RelationOverride) => setOverrides((prev) => ({ ...prev, [id]: o })), []);
  const setBusyFor = (id: string, v: boolean) => setBusy((prev) => ({ ...prev, [id]: v }));

  const withOverride = useCallback(
    <P extends FriendTarget>(p: P): P => ({ ...p, ...overrides[p.id] }),
    [overrides],
  );

  const reset = useCallback(() => setOverrides({}), []);

  /** La fila real de la relación, tras un error que dice que ya existía. */
  const refreshRelation = async (person: FriendTarget, previous: RelationOverride) => {
    if (!user) return setRelation(person.id, previous);
    const { data, error } = await supabase
      .from('friendships')
      .select('id, status, requester_id')
      .or(`and(requester_id.eq.${user.id},addressee_id.eq.${person.id}),and(requester_id.eq.${person.id},addressee_id.eq.${user.id})`)
      .maybeSingle();
    if (error) return setRelation(person.id, previous);
    if (!data) return setRelation(person.id, { relation: 'none', friendship_id: null });
    setRelation(person.id, {
      relation: data.status === 'accepted' ? 'friends' : data.requester_id === user.id ? 'outgoing' : 'incoming',
      friendship_id: data.status === 'accepted' ? null : data.id,
    });
  };

  const add = async (person: FriendTarget) => {
    if (!user || busy[person.id]) return;
    const previous: RelationOverride = { relation: person.relation, friendship_id: person.friendship_id };
    setBusyFor(person.id, true);
    setRelation(person.id, { relation: 'outgoing', friendship_id: null });
    const { data, error } = await supabase
      .from('friendships')
      .insert({ requester_id: user.id, addressee_id: person.id, status: 'pending' })
      .select('id')
      .single();
    setBusyFor(person.id, false);

    if (!error && data) {
      setRelation(person.id, { relation: 'outgoing', friendship_id: data.id });
      toast({ title: t('friends.requestSent') });
      return;
    }
    // Ya había algo entre las dos personas (otro dispositivo, o la lista
    // estaba vieja): se enseña lo que hay de verdad, no un error.
    if (error && /FRIEND_REQUEST_EXISTS|FRIEND_REQUEST_INCOMING|ALREADY_FRIENDS|23505/.test(`${error.message} ${error.code}`)) {
      await refreshRelation(person, previous);
      toast({ title: rpcMessage(error.code === '23505' ? 'FRIEND_REQUEST_EXISTS' : error.message, t) });
      return;
    }
    setRelation(person.id, previous);
    toast({ title: t('common.error'), description: rpcMessage(error?.message, t), variant: 'destructive' });
  };

  const accept = async (person: FriendTarget) => {
    if (!person.friendship_id || busy[person.id]) return;
    const previous: RelationOverride = { relation: person.relation, friendship_id: person.friendship_id };
    setBusyFor(person.id, true);
    setRelation(person.id, { relation: 'friends', friendship_id: null });
    const { data, error } = await supabase
      .from('friendships')
      .update({ status: 'accepted' })
      .eq('id', person.friendship_id)
      .select('id');
    setBusyFor(person.id, false);
    // Sin filas: la solicitud ya no existe (la cancelaron).
    if (error || !data?.length) {
      await refreshRelation(person, previous);
      toast({
        title: error ? t('common.error') : t('friends.requestGone'),
        description: error ? rpcMessage(error.message, t) : undefined,
        variant: 'destructive',
      });
      return;
    }
    toast({ title: t('friends.requestAccepted') });
    onFriendsChanged?.();
  };

  const cancelRequest = async (person: FriendTarget) => {
    if (!person.friendship_id || busy[person.id]) return;
    const previous: RelationOverride = { relation: person.relation, friendship_id: person.friendship_id };
    setBusyFor(person.id, true);
    setRelation(person.id, { relation: 'none', friendship_id: null });
    const { error } = await supabase
      .from('friendships')
      .delete()
      .eq('id', person.friendship_id)
      .eq('status', 'pending');
    setBusyFor(person.id, false);
    if (error) {
      setRelation(person.id, previous);
      toast({ title: t('common.error'), description: rpcMessage(error.message, t), variant: 'destructive' });
      return;
    }
    toast({ title: t('friends.requestCanceled') });
  };

  return { busy, withOverride, reset, add, accept, cancelRequest };
}
