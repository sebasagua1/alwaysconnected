import { describe, it, expect } from 'vitest';
import { applyMessageChange, canSaveEdit, formatChatTime } from '@/lib/chat';

const msg = (id: string, content = 'hola') => ({
  id,
  content,
  created_at: '2026-09-14T10:00:00Z',
  sender_id: 'u1',
  senderName: 'Ana',
  edited_at: null as string | null,
  deleted_at: null as string | null,
});

describe('applyMessageChange', () => {
  it('cambia solo el mensaje indicado y conserva el resto de campos', () => {
    const list = [msg('a'), msg('b')];
    const next = applyMessageChange(list, { id: 'b', content: 'editado', edited_at: '2026-09-14T11:00:00Z', deleted_at: null });
    expect(next[0]).toBe(list[0]);
    expect(next[1]).toMatchObject({ content: 'editado', edited_at: '2026-09-14T11:00:00Z', senderName: 'Ana', created_at: list[1].created_at });
    expect(list[1].content).toBe('hola');
  });

  it('un borrado deja el texto vacío y la marca de borrado', () => {
    const next = applyMessageChange([msg('a')], { id: 'a', content: '', edited_at: null, deleted_at: '2026-09-14T12:00:00Z' });
    expect(next[0]).toMatchObject({ content: '', deleted_at: '2026-09-14T12:00:00Z' });
  });

  it('devuelve la misma lista si el mensaje no está cargado', () => {
    const list = [msg('a')];
    expect(applyMessageChange(list, { id: 'zzz', content: 'x', edited_at: null, deleted_at: null })).toBe(list);
  });
});

describe('canSaveEdit', () => {
  it('no deja guardar vacío ni solo espacios', () => {
    expect(canSaveEdit('hola', '')).toBe(false);
    expect(canSaveEdit('hola', '   ')).toBe(false);
  });

  it('no deja guardar si no cambió nada', () => {
    expect(canSaveEdit('hola', 'hola')).toBe(false);
    expect(canSaveEdit('hola', '  hola ')).toBe(false);
  });

  it('deja guardar un cambio real', () => {
    expect(canSaveEdit('hola', 'hola!')).toBe(true);
  });
});

describe('formatChatTime', () => {
  const now = new Date(2026, 8, 14, 18, 30); // 14 sep 2026, 18:30 local

  it('hoy: la hora', () => {
    expect(formatChatTime(new Date(2026, 8, 14, 9, 5).toISOString(), 'es', 'Ayer', now)).toBe('09:05');
  });

  it('ayer: la etiqueta', () => {
    expect(formatChatTime(new Date(2026, 8, 13, 23, 59).toISOString(), 'es', 'Ayer', now)).toBe('Ayer');
  });

  it('esta semana: el día; más viejo: la fecha corta', () => {
    const semana = formatChatTime(new Date(2026, 8, 10, 12).toISOString(), 'en', 'Yesterday', now);
    expect(semana).toBe(new Intl.DateTimeFormat('en', { weekday: 'short' }).format(new Date(2026, 8, 10, 12)));
    expect(formatChatTime(new Date(2026, 7, 1, 12).toISOString(), 'es', 'Ayer', now)).toBe('01/08/26');
  });
});
