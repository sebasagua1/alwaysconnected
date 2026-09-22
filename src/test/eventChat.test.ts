import { describe, it, expect } from 'vitest';
import {
  activeMentionQuery, dropMessage, firstUnreadIndex, insertMention, mentionCandidates, mentionIdsInText,
  mentionLabel, mergeMessages, newMessageId, setSendState, splitMentions, toChatMessage, type EventChatMessage,
} from '@/lib/eventChat';
import { routeFromPath, routeFromPushData } from '@/lib/deepLinks';

const msg = (id: string, at: string, extra: Partial<EventChatMessage> = {}): EventChatMessage => ({
  id, content: id, created_at: at, sender_id: 'ana', edited_at: null, deleted_at: null, deleted_by: null,
  mentions: [], is_announcement: false, ...extra,
});

describe('mergeMessages: tres vías, una sola fila', () => {
  it('el eco optimista y el tiempo real del mismo mensaje no se duplican, lleguen en el orden que lleguen', () => {
    const optimista = msg('m1', '2026-09-22T10:00:00.000Z', { state: 'sending', sender_id: 'yo' });
    const servidor = msg('m1', '2026-09-22T10:00:00.512Z', { sender_id: 'yo' });

    // Primero la respuesta del INSERT, luego el tiempo real.
    let lista = mergeMessages([], [optimista]);
    lista = mergeMessages(lista, [servidor]);
    lista = mergeMessages(lista, [servidor]);
    expect(lista).toHaveLength(1);
    expect(lista[0].state).toBe('sent');

    // Al revés: el tiempo real gana la carrera a la respuesta.
    let otra = mergeMessages([], [optimista]);
    otra = mergeMessages(otra, [servidor]);
    expect(otra).toHaveLength(1);
    expect(otra[0].created_at).toBe(servidor.created_at);
  });

  it('ordena por fecha y desempata por id, estable entre recargas', () => {
    const lista = mergeMessages([], [msg('b', '2026-09-22T10:00:00Z'), msg('a', '2026-09-22T10:00:00Z'), msg('c', '2026-09-22T09:00:00Z')]);
    expect(lista.map((m) => m.id)).toEqual(['c', 'a', 'b']);
  });

  it('un UPDATE atrasado no "desborra" un mensaje ya borrado', () => {
    const borrado = msg('m', '2026-09-22T10:00:00Z', { deleted_at: '2026-09-22T10:05:00Z', content: '' });
    const lista = mergeMessages([borrado], [msg('m', '2026-09-22T10:00:00Z', { content: 'texto viejo' })]);
    expect(lista[0].deleted_at).not.toBeNull();
    expect(lista[0].content).toBe('');
  });

  it('devuelve la misma lista si no llega nada, para no repintar', () => {
    const lista = [msg('a', '2026-09-22T10:00:00Z')];
    expect(mergeMessages(lista, [])).toBe(lista);
  });

  it('reintentar un fallido lo vuelve a poner en "enviando" en su sitio', () => {
    let lista = mergeMessages([], [msg('x', '2026-09-22T10:00:00Z', { state: 'failed' })]);
    lista = mergeMessages(lista, [msg('x', '2026-09-22T10:00:00Z', { state: 'sending' })]);
    expect(lista).toHaveLength(1);
    expect(lista[0].state).toBe('sending');
  });

  it('setSendState y dropMessage solo tocan lo suyo', () => {
    const lista = [msg('a', '1'), msg('b', '2', { state: 'sending' })];
    expect(setSendState(lista, 'b', 'failed')[1].state).toBe('failed');
    expect(setSendState(lista, 'zzz', 'failed')).toBe(lista);
    expect(dropMessage(lista, 'a').map((m) => m.id)).toEqual(['b']);
  });
});

describe('no leídos', () => {
  it('la raya va en el primer mensaje ajeno posterior a la última lectura', () => {
    const lista = [
      msg('1', '2026-09-22T10:00:00Z'),
      msg('2', '2026-09-22T11:00:00Z', { sender_id: 'yo' }),
      msg('3', '2026-09-22T11:30:00Z', { deleted_at: 'x' }),
      msg('4', '2026-09-22T12:00:00Z'),
    ];
    expect(firstUnreadIndex(lista, '2026-09-22T10:30:00Z', 'yo')).toBe(3);
    expect(firstUnreadIndex(lista, '2026-09-22T13:00:00Z', 'yo')).toBe(-1);
    expect(firstUnreadIndex(lista, null, 'yo')).toBe(-1);
  });
});

describe('menciones', () => {
  const miembros = [
    { id: 'u1', name: 'Ana López' },
    { id: 'u2', name: 'Andrés Ruiz' },
    { id: 'yo', name: 'Yo Mismo' },
  ];

  it('detecta la @ que se está escribiendo, pero no un correo', () => {
    expect(activeMentionQuery('hola @an', 8)).toEqual({ start: 5, query: 'an' });
    expect(activeMentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(activeMentionQuery('escribe a ana@tec.mx', 20)).toBeNull();
    expect(activeMentionQuery('hola @ana y ya', 14)).toBeNull();
  });

  it('propone miembros por inicio de palabra y sin acentos, nunca a uno mismo', () => {
    expect(mentionCandidates(miembros, 'an', 'yo').map((m) => m.id)).toEqual(['u1', 'u2']);
    expect(mentionCandidates(miembros, 'andre', 'yo').map((m) => m.id)).toEqual(['u2']);
    expect(mentionCandidates(miembros, 'lop', 'yo').map((m) => m.id)).toEqual(['u1']);
    expect(mentionCandidates(miembros, '', 'yo').map((m) => m.id)).not.toContain('yo');
  });

  it('inserta la etiqueta y deja el cursor detrás', () => {
    const r = insertMention('hola @an', 5, 8, miembros[0]);
    expect(r).toEqual({ text: 'hola @Ana ', caret: 10 });
  });

  it('solo cuenta las menciones elegidas que siguen escritas', () => {
    expect(mentionIdsInText('@Ana y @Andrés vengan', miembros)).toEqual(['u1', 'u2']);
    // Borró "@Andrés" a mano: ya no se le menciona.
    expect(mentionIdsInText('@Ana vengan', miembros)).toEqual(['u1']);
    // "@Anabel" no es "@Ana".
    expect(mentionIdsInText('@Anabel', miembros)).toEqual([]);
  });

  it('la etiqueta es el primer nombre sin signos', () => {
    expect(mentionLabel('  María José ')).toBe('María');
    expect(mentionLabel(null)).toBe('');
  });

  it('resalta solo las menciones que guardó el servidor', () => {
    const nombres = new Map([['u1', 'Ana López']]);
    expect(splitMentions('hola @Ana, y @Pedro', ['u1'], nombres)).toEqual([
      { text: 'hola ' },
      { text: '@Ana', mention: 'u1' },
      { text: ', y @Pedro' },
    ]);
    expect(splitMentions('sin menciones', [], nombres)).toEqual([{ text: 'sin menciones' }]);
  });
});

describe('ids y filas', () => {
  it('genera UUID v4', () => {
    expect(newMessageId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('una fila vieja sin menciones ni aviso se lee como vacía, no como null', () => {
    const m = toChatMessage({ id: 'x', content: 'hola', created_at: 'a', sender_id: 's', mentions: null as unknown as string[] });
    expect(m.mentions).toEqual([]);
    expect(m.is_announcement).toBe(false);
  });
});

describe('enlaces al chat de actividad', () => {
  const id = '11111111-2222-4333-8444-555555555555';

  it('la ruta del chat se acepta solo con un uuid de verdad', () => {
    expect(routeFromPath(`/events/${id}/chat`)).toBe(`/events/${id}/chat`);
    expect(routeFromPath('/events/../../algo/chat')).toBeNull();
    expect(routeFromPath(`/events/${id}/chat/extra`)).toBeNull();
  });

  it('mensajes, menciones y avisos abren el chat correcto', () => {
    for (const type of ['event_message', 'chat_mention', 'organizer_announcement']) {
      expect(routeFromPushData({ type, event_id: id })).toBe(`/events/${id}/chat`);
    }
    expect(routeFromPushData({ type: 'chat_mention' })).toBeNull();
  });
});
