/**
 * Conciliar la bandeja con una primera página recién pedida. Lo que se
 * fija: lo que el servidor ya no tiene se va, lo que se cargó en páginas
 * posteriores se queda, y el orden es el del servidor (fecha y, a igual
 * fecha, id).
 */
import { describe, it, expect, vi } from 'vitest';

// Sin .env (en el CI) el cliente real revienta al importarse.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import { reconcileInbox, upsertInbox, type InboxItem } from '@/lib/notifications';

const n = (id: string, updated_at: string, extra: Partial<InboxItem> = {}): InboxItem => ({
  id, type: 'digest', category: 'digests', count: 1, created_at: updated_at, updated_at, read_at: null, data: {},
  actor_id: null, actor_name: null, actor_avatar: null, event_id: null, event_title: null, event_starts_at: null,
  group_id: null, group_name: null, is_dm: false, ...extra,
});
const ids = (l: InboxItem[]) => l.map((x) => x.id);

describe('reconcileInbox', () => {
  it('una página incompleta es la bandeja entera: lo demás ya no existe', () => {
    const lista = [n('c', '2026-10-03'), n('b', '2026-10-02'), n('a', '2026-10-01')];
    expect(ids(reconcileInbox(lista, [n('c', '2026-10-03'), n('a', '2026-10-01')], 30))).toEqual(['c', 'a']);
    expect(reconcileInbox(lista, [], 30)).toEqual([]);
  });

  it('con la página llena, quita lo que falta dentro de su tramo y conserva lo de más abajo', () => {
    const lista = [n('e', '2026-10-05'), n('d', '2026-10-04'), n('c', '2026-10-03'), n('b', '2026-10-02'), n('a', '2026-10-01')];
    // Página de 3: llega uno nuevo (f) y «d» ya no está.
    const pagina = [n('f', '2026-10-06'), n('e', '2026-10-05'), n('c', '2026-10-03')];
    expect(ids(reconcileInbox(lista, pagina, 3))).toEqual(['f', 'e', 'c', 'b', 'a']);
  });

  it('el servidor manda: trae el estado nuevo de lo que ya estaba', () => {
    const lista = [n('a', '2026-10-01')];
    const [a] = reconcileInbox(lista, [n('a', '2026-10-02', { read_at: '2026-10-02', count: 4 })], 30);
    expect(a).toMatchObject({ updated_at: '2026-10-02', read_at: '2026-10-02', count: 4 });
  });

  it('a igual fecha, el límite del tramo lo decide el id', () => {
    const hora = '2026-10-01T10:00:00+00:00';
    const lista = [n('d', hora), n('c', hora), n('b', hora), n('a', hora)];
    // Página de 2 que acaba en «c»: «b» y «a» son de más abajo y se quedan;
    // nada de lo que hay por encima de «c» falta.
    expect(ids(reconcileInbox(lista, [n('d', hora), n('c', hora)], 2))).toEqual(['d', 'c', 'b', 'a']);
    // Si «d» desaparece y entra «e», «d» se va aunque comparta fecha.
    expect(ids(reconcileInbox(lista, [n('e', hora), n('c', hora)], 2))).toEqual(['e', 'c', 'b', 'a']);
  });
});

describe('upsertInbox', () => {
  it('añade sin repetir y ordena por actividad', () => {
    const lista = [n('b', '2026-10-02'), n('a', '2026-10-01')];
    expect(ids(upsertInbox(lista, [n('a', '2026-10-03'), n('c', '2026-09-30')]))).toEqual(['a', 'b', 'c']);
  });
});
